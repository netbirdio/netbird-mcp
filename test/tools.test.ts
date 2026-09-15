import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildServer } from "../src/server.js";
import {
  registerMutation,
  registerDelete,
  type ToolDeps,
  type MutationManifest,
  type DeleteManifest,
} from "../src/tools/registry.js";
import type { ServerConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";

/**
 * These tests exercise the tool layer through the server's own public seam:
 * build the server, connect an MCP client over an in-memory transport, and
 * inject a recording fake fetch into the NetBird client underneath. No
 * registration internals are imported — only externally observable behaviour
 * (preview vs. applied, request shape, tool presence, error surfacing).
 */

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const baseConfig: ServerConfig = {
  enableDestructive: false,
  maxRequestsPerMinute: 1000,
  requestTimeoutMs: 5000,
  logLevel: "error",
  allowedApiHosts: ["api.netbird.io"],
  http: {
    host: "127.0.0.1",
    port: 3000,
    tokenHeader: "x-netbird-token",
    urlHeader: "x-netbird-api-url",
    oauthEnabled: false,
    directPatEnabled: true,
    publicBaseUrl: "http://localhost:3000",
    verifyPatOnLogin: false,
    trustProxy: false,
  },
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeRecordingFetch(handler: Handler = () => jsonResponse({})) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function connectClient(config: ServerConfig, fetchImpl: typeof fetch) {
  const server = buildServer({
    auth: { token: "test-pat", baseUrl: "https://api.netbird.io" },
    config,
    logger: silentLogger,
    fetchImpl,
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const [first] = result.content;
  return first?.text ?? "";
}

function jsonOf(result: { content: Array<{ type: string; text?: string }> }): unknown {
  return JSON.parse(textOf(result));
}

describe("tool layer (via MCP client over in-memory transport)", () => {
  let recorder: ReturnType<typeof makeRecordingFetch>;

  beforeEach(() => {
    recorder = makeRecordingFetch();
  });

  it("update tool without confirm returns a preview and makes no API call", async () => {
    const client = await connectClient(baseConfig, recorder.fetchImpl);

    const result = await client.callTool({
      name: "update_peer",
      arguments: { peer_id: "p1", name: "new-name" },
    });

    const body = jsonOf(result as never) as { status: string; would_send: unknown };
    expect(body.status).toBe("preview");
    expect(body.would_send).toEqual({ name: "new-name" });
    expect(recorder.calls).toHaveLength(0);
  });

  it("confirming an update sends exactly the non-undefined fields to the right method+path", async () => {
    recorder = makeRecordingFetch(() => jsonResponse({ id: "p1", name: "new-name" }));
    const client = await connectClient(baseConfig, recorder.fetchImpl);

    const result = await client.callTool({
      name: "update_peer",
      arguments: { peer_id: "p1", name: "new-name", confirm: true },
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].method).toBe("PUT");
    expect(recorder.calls[0].url).toBe("https://api.netbird.io/api/peers/p1");
    expect(recorder.calls[0].body).toEqual({ name: "new-name" });
    expect(jsonOf(result as never)).toEqual({ id: "p1", name: "new-name" });
  });

  it("URI-encodes ids interpolated into the path", async () => {
    recorder = makeRecordingFetch(() => jsonResponse({ ok: true }));
    const client = await connectClient(baseConfig, recorder.fetchImpl);

    await client.callTool({
      name: "update_peer",
      arguments: { peer_id: "peer id/with slash", name: "x", confirm: true },
    });

    expect(recorder.calls[0].url).toBe(
      "https://api.netbird.io/api/peers/peer%20id%2Fwith%20slash",
    );
  });

  it("delete tools are absent from tools/list when destructive operations are disabled", async () => {
    const client = await connectClient(baseConfig, recorder.fetchImpl);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("delete_peer");
    expect(names).not.toContain("delete_group");
    expect(names).not.toContain("delete_policy");
  });

  it("delete tools are present but still confirm-gated when destructive operations are enabled", async () => {
    const client = await connectClient({ ...baseConfig, enableDestructive: true }, recorder.fetchImpl);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("delete_peer");

    const preview = await client.callTool({
      name: "delete_peer",
      arguments: { peer_id: "p1", confirm: false },
    });
    expect((jsonOf(preview as never) as { status: string }).status).toBe("preview");
    expect(recorder.calls).toHaveLength(0);

    const applied = await client.callTool({
      name: "delete_peer",
      arguments: { peer_id: "p1", confirm: true },
    });
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].method).toBe("DELETE");
    expect(recorder.calls[0].url).toBe("https://api.netbird.io/api/peers/p1");
    expect(jsonOf(applied as never)).toEqual({ status: "deleted", peer_id: "p1" });
  });

  it("surfaces a NetBird 4xx as a structured tool error with status info", async () => {
    recorder = makeRecordingFetch(() => jsonResponse({ message: "not found" }, 404));
    const client = await connectClient(baseConfig, recorder.fetchImpl);

    const result = await client.callTool({ name: "get_peer", arguments: { peer_id: "nope" } });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = textOf(result as never);
    expect(text).toContain("404");
    expect(text).toContain("not found");
  });

  it("maps expires_in_seconds to expires_in and defaults auto_groups on setup key creation", async () => {
    recorder = makeRecordingFetch(() => jsonResponse({ id: "k1" }));
    const client = await connectClient(baseConfig, recorder.fetchImpl);

    await client.callTool({
      name: "create_setup_key",
      arguments: { name: "contractor", expires_in_seconds: 604800, confirm: true },
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].method).toBe("POST");
    expect(recorder.calls[0].url).toBe("https://api.netbird.io/api/setup-keys");
    expect(recorder.calls[0].body).toEqual({
      name: "contractor",
      type: "one-off",
      expires_in: 604800,
      auto_groups: [],
    });
  });

  it("slices events client-side to the requested limit", async () => {
    const events = [{ id: "e1" }, { id: "e2" }, { id: "e3" }, { id: "e4" }];
    recorder = makeRecordingFetch(() => jsonResponse(events));
    const client = await connectClient(baseConfig, recorder.fetchImpl);

    const result = await client.callTool({ name: "list_events", arguments: { limit: 2 } });

    expect(jsonOf(result as never)).toEqual([{ id: "e1" }, { id: "e2" }]);
  });

  it("a read tool hits the right path and method", async () => {
    recorder = makeRecordingFetch(() => jsonResponse({ id: "net1" }));
    const client = await connectClient(baseConfig, recorder.fetchImpl);

    const result = await client.callTool({
      name: "get_network",
      arguments: { network_id: "net1" },
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].method).toBe("GET");
    expect(recorder.calls[0].url).toBe("https://api.netbird.io/api/networks/net1");
    expect(jsonOf(result as never)).toEqual({ id: "net1" });
  });
});

describe("per-manifest smoke coverage — remaining unique transforms", () => {
  let recorder: ReturnType<typeof makeRecordingFetch>;

  beforeEach(() => {
    recorder = makeRecordingFetch();
  });

  it("list_peers forwards name/ip filters as query params", async () => {
    const client = await connectClient(baseConfig, recorder.fetchImpl);

    await client.callTool({ name: "list_peers", arguments: { name: "office", ip: "100.64.0.1" } });

    expect(recorder.calls).toHaveLength(1);
    const url = new URL(recorder.calls[0].url);
    expect(url.pathname).toBe("/api/peers");
    expect(url.searchParams.get("name")).toBe("office");
    expect(url.searchParams.get("ip")).toBe("100.64.0.1");
  });

  it("create_policy sends the rule set with the enabled default applied", async () => {
    const client = await connectClient(baseConfig, recorder.fetchImpl);

    await client.callTool({
      name: "create_policy",
      arguments: {
        name: "allow-web",
        rules: [{ sources: ["g1"], destinations: ["g2"], protocol: "tcp", ports: ["443"] }],
        confirm: true,
      },
    });

    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0];
    expect(call.method).toBe("POST");
    expect(new URL(call.url).pathname).toBe("/api/policies");
    const body = call.body as { name: string; enabled: boolean; rules: Array<Record<string, unknown>> };
    expect(body.name).toBe("allow-web");
    expect(body.enabled).toBe(true); // schema default, applied without being passed
    expect(body.rules[0]).toMatchObject({ sources: ["g1"], destinations: ["g2"], protocol: "tcp" });
    expect(body).not.toHaveProperty("description"); // undefined fields stripped
  });

  it("update_setup_key PUTs only the provided fields to the key's path", async () => {
    const client = await connectClient(baseConfig, recorder.fetchImpl);

    await client.callTool({
      name: "update_setup_key",
      arguments: { key_id: "k 1", revoked: true, confirm: true },
    });

    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0];
    expect(call.method).toBe("PUT");
    expect(new URL(call.url).pathname).toBe("/api/setup-keys/k%201");
    expect(call.body).toEqual({ revoked: true });
  });
});

/**
 * The registry injects a `confirm` field into every write tool's advertised
 * schema; manifests declare only domain fields. These tests observe the listed
 * schema through the MCP client's tools/list and assert optionality per kind.
 */
describe("registry-injected confirm field (via MCP client tools/list)", () => {
  const recorder = makeRecordingFetch();

  // The names of every write tool and whether confirm should be optional.
  const mutationTools = [
    "update_peer",
    "create_group",
    "update_group",
    "create_policy",
    "update_policy",
    "create_setup_key",
    "update_setup_key",
  ];
  const deleteTools = ["delete_peer", "delete_group", "delete_policy"];

  interface ListedSchema {
    properties?: Record<string, unknown>;
    required?: string[];
  }

  async function listedSchemas(): Promise<Map<string, ListedSchema>> {
    // Destructive on so delete tools appear in the listing too.
    const client = await connectClient(
      { ...baseConfig, enableDestructive: true },
      recorder.fetchImpl,
    );
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, t.inputSchema as ListedSchema]));
  }

  it("advertises an optional confirm boolean on every mutation tool", async () => {
    const schemas = await listedSchemas();
    for (const name of mutationTools) {
      const schema = schemas.get(name);
      expect(schema, `${name} should be listed`).toBeDefined();
      expect(schema?.properties, `${name} exposes confirm`).toHaveProperty("confirm");
      expect(schema?.required ?? [], `${name} confirm is optional`).not.toContain("confirm");
    }
  });

  it("advertises a required confirm boolean on every delete tool", async () => {
    const schemas = await listedSchemas();
    for (const name of deleteTools) {
      const schema = schemas.get(name);
      expect(schema, `${name} should be listed`).toBeDefined();
      expect(schema?.properties, `${name} exposes confirm`).toHaveProperty("confirm");
      expect(schema?.required ?? [], `${name} confirm is required`).toContain("confirm");
    }
  });
});

/**
 * The confirm field is injected, never hand-declared. A manifest that declares
 * its own `confirm` collides with the guardrail and must be rejected at
 * registration time. This exercises the public registration functions directly
 * because the collision can only arise from a (rejected) manifest — it can
 * never reach the buildServer seam once the real manifests are correct.
 */
describe("confirm collision guard (registration-time throw)", () => {
  const deps: ToolDeps = {
    client: {} as never,
    config: { ...baseConfig, enableDestructive: true },
    logger: silentLogger,
  };

  it("rejects a mutation manifest that declares its own confirm field", () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    // The cast smuggles the colliding field past the compile-time guard so the
    // runtime guard (the last line of defence for untyped callers) is exercised.
    const colliding = { confirm: z.boolean().optional() } as unknown as Record<string, never>;
    expect(() =>
      registerMutation(server, deps, {
        name: "bad_mutation",
        title: "Bad",
        description: "Bad",
        inputSchema: colliding,
        method: "POST",
        path: () => "/api/x",
        previewAction: () => "Would x.",
        buildBody: () => ({}),
      }),
    ).toThrow(/confirm/);
  });

  it("rejects a delete manifest that declares its own confirm field", () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const colliding = { x_id: z.string(), confirm: z.boolean() } as unknown as {
      x_id: z.ZodString;
    };
    expect(() =>
      registerDelete(server, deps, {
        name: "bad_delete",
        title: "Bad",
        description: "Bad",
        inputSchema: colliding,
        path: ({ x_id }) => `/api/x/${x_id}`,
        label: "x",
        idField: "x_id",
      }),
    ).toThrow(/confirm/);
  });

  it("rejects a confirm-declaring manifest at the type level", () => {
    const shape = { confirm: z.boolean().optional() };
    // @ts-expect-error — `confirm` is reserved by the registry guardrail
    type RejectedMutation = MutationManifest<typeof shape>;
    // @ts-expect-error — `confirm` is reserved by the registry guardrail
    type RejectedDelete = DeleteManifest<typeof shape>;
    // Type-only assertions; the runtime guard is exercised above.
    expect(shape.confirm).toBeDefined();
  });
});
