import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * End-to-end coverage of the CLOUD entrypoint's OAuth flow: spawn the real
 * HTTP server and walk the whole protocol a production MCP client walks —
 * dynamic registration, interactive login, PKCE code exchange, a
 * Bearer-authenticated tool call through the real SDK client, and refresh
 * rotation. A fake NetBird API records Authorization headers so the test can
 * assert the PAT bound at login (never the bearer token) is what reaches
 * NetBird.
 *
 * This exists because the SDK's token handler only forwards code_verifier
 * when the provider sets skipLocalPkceValidation — a contract no seam-level
 * test can see. Unit suites passed while every wire exchange failed.
 */

const TSX = resolve("node_modules/.bin/tsx");
const ENTRY = resolve("src/bin/http.ts");
const VERIFIER = "e2e-code-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const BOUND_PAT = "e2e-bound-pat";

interface SeenRequest {
  method: string;
  url: string;
  auth: string | undefined;
}

let fakeApi: Server;
let fakeApiPort: number;
let seen: SeenRequest[];
let child: ChildProcess;
let base: string;

function startFakeNetBird(): Promise<number> {
  seen = [];
  fakeApi = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/users")) return res.end(JSON.stringify([{ id: "u1" }]));
    if (req.url?.startsWith("/api/peers")) return res.end(JSON.stringify([{ id: "p1", name: "peer-one" }]));
    res.end(JSON.stringify({}));
  });
  return new Promise((resolvePort) => {
    fakeApi.listen(0, "127.0.0.1", () => resolvePort((fakeApi.address() as AddressInfo).port));
  });
}

async function waitForHealthz(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`server at ${url} never became healthy`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function registerClient(): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://localhost:9999/cb"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

/** Complete the interactive login step and return the one-time code. */
async function loginForCode(clientId: string, state: string): Promise<string> {
  const form = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "http://localhost:9999/cb",
    code_challenge: CHALLENGE,
    state,
    scope: "netbird",
    netbird_token: BOUND_PAT,
    netbird_api_url: `http://127.0.0.1:${fakeApiPort}`,
  });
  const res = await fetch(`${base}/oauth/netbird-login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  expect(location.searchParams.get("state")).toBe(state);
  return location.searchParams.get("code")!;
}

async function exchange(params: Record<string, string>): Promise<Response> {
  return fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

beforeAll(async () => {
  fakeApiPort = await startFakeNetBird();
  const port = 39_500 + (process.pid % 400);
  base = `http://127.0.0.1:${port}`;
  child = spawn(TSX, [ENTRY], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      NETBIRD_ENABLE_OAUTH: "true",
      PUBLIC_BASE_URL: base,
      // The login form posts netbird_api_url pointing at the fake NetBird on
      // loopback; allowlist that host so the flow isn't refused as SSRF.
      NETBIRD_ALLOWED_API_HOSTS: "127.0.0.1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await waitForHealthz(base);
}, 30_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => fakeApi.close(() => r()));
});

describe("OAuth end-to-end over HTTP (spawned server, real MCP client)", () => {
  it("walks registration -> login -> PKCE exchange -> Bearer tool call -> refresh rotation", async () => {
    const clientId = await registerClient();
    const code = await loginForCode(clientId, "s-e2e");

    // Login must have verified the PAT against the NetBird API.
    expect(seen.some((r) => r.url.startsWith("/api/users") && r.auth === `Token ${BOUND_PAT}`)).toBe(
      true,
    );

    const tokenRes = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      client_id: clientId,
      redirect_uri: "http://localhost:9999/cb",
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };
    expect(tokens.access_token).toBeTruthy();

    // A real SDK client calls a tool with the Bearer token.
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    });
    const client = new Client({ name: "oauth-e2e", version: "0.0.0" });
    await client.connect(transport);
    const result = await client.callTool({ name: "list_peers", arguments: {} });
    await client.close();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("peer-one");

    // The NetBird API saw the bound PAT — never the bearer token.
    const peersCall = seen.find((r) => r.url.startsWith("/api/peers"));
    expect(peersCall?.auth).toBe(`Token ${BOUND_PAT}`);
    expect(seen.some((r) => r.auth?.includes(tokens.access_token))).toBe(false);

    // Refresh grant rotates; the old refresh token dies.
    const refreshed = await exchange({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const rotated = (await refreshed.json()) as { access_token: string };
    expect(rotated.access_token).not.toBe(tokens.access_token);
    const replay = await exchange({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(replay.status).toBe(400);
  }, 20_000);

  it("allowlists the login form's netbird_api_url and rate-limits the real login route", async () => {
    const res = await fetch(`${base}/oauth/netbird-login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "c-ssrf",
        redirect_uri: "http://localhost:9999/cb",
        code_challenge: "chal",
        netbird_token: "x",
        netbird_api_url: "http://169.254.169.254",
      }),
    });
    // A disallowed host is refused (before any outbound call)...
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/not allowed/i);
    // ...and the mounted rate limiter tags the response with its standard headers.
    expect(res.headers.has("ratelimit") || res.headers.has("ratelimit-limit")).toBe(true);
  }, 20_000);

  it("rejects a wrong code_verifier at the wire with 400 invalid_grant", async () => {
    const clientId = await registerClient();
    const code = await loginForCode(clientId, "s-bad-pkce");
    const res = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier-wrong",
      client_id: clientId,
      redirect_uri: "http://localhost:9999/cb",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  }, 20_000);

  it("answers unauthenticated /mcp with 401 and the resource-metadata discovery header", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });
});
