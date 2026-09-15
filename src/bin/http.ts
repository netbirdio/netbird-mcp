#!/usr/bin/env node
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { resolveAuth } from "../auth/resolve.js";
import { AuthContext, AuthError } from "../auth/context.js";
import { loadConfigOrExit } from "./loadConfigOrExit.js";
import { createLogger } from "../logger.js";
import { LimiterPool } from "../netbird/limiterPool.js";
import { verifyPat, type TokenVerification } from "../netbird/client.js";
import { buildServer } from "../server.js";
import { NetBirdOAuthProvider } from "../oauth/provider.js";
import { loginRateLimiter } from "../oauth/loginRateLimit.js";

/**
 * CLOUD entrypoint. Speaks MCP over Streamable HTTP so the server can be hosted
 * and added to Claude as a remote/custom connector.
 *
 * Auth (Bearer-vs-Token dispatch, OAuth binding resolution) lives in
 * ../auth/resolve.js — this file only wires transport.
 *
 * Stateless: each request gets a fresh server instance, so one deployment safely
 * serves many tenants and scales horizontally.
 */
const config = loadConfigOrExit();
const logger = createLogger(config.logLevel);
const { host, port, tokenHeader, urlHeader, oauthEnabled, directPatEnabled, publicBaseUrl, verifyPatOnLogin, trustProxy } =
  config.http;

const provider = new NetBirdOAuthProvider({
  logger,
  verifyPatOnLogin,
  maxRequestsPerMinute: config.maxRequestsPerMinute,
  requestTimeoutMs: config.requestTimeoutMs,
  allowedApiHosts: config.allowedApiHosts,
});

// One rate limiter per tenant (keyed by a hash of the NetBird token, never the token
// itself), so NetBird's per-account limit is respected without cross-tenant interference.
const limiters = new LimiterPool(config.maxRequestsPerMinute);

// Verify a direct PAT against NetBird before it is trusted, reusing the tenant's
// own limiter so verification counts against the same per-account budget as its
// tool calls. Only the direct-PAT path uses this; OAuth bindings are pre-verified.
// An indeterminate result (or a surprise throw) fails open — the host is already
// allowlisted and NetBird refuses a bogus token on the real call — but is logged,
// so admitting a token without a clean verification is never silent.
const verifyDirectPat = async (auth: AuthContext): Promise<TokenVerification> => {
  try {
    const result = await verifyPat(auth, {
      logger,
      rateLimiter: limiters.get(auth.token),
      timeoutMs: config.requestTimeoutMs,
    });
    if (result === "unknown") {
      logger.warn("direct-PAT verification indeterminate; admitting token unverified", {
        baseUrl: auth.baseUrl,
      });
    }
    return result;
  } catch (err) {
    logger.warn("direct-PAT verification errored; admitting token unverified", {
      baseUrl: auth.baseUrl,
      message: (err as Error).message,
    });
    return "unknown";
  }
};

const app = express();
// Behind a proxy this must be set so req.ip is the real client IP, which every
// per-IP rate limiter (OAuth routes, login form, per-source login verify) keys on.
app.set("trust proxy", trustProxy);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false })); // OAuth login form posts

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", oauth: oauthEnabled });
});

const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(`${publicBaseUrl}/mcp`));

if (oauthEnabled) {
  // Standard MCP authorization-server endpoints: metadata discovery, dynamic client
  // registration, /authorize, /token, /revoke.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(publicBaseUrl),
      resourceServerUrl: new URL(`${publicBaseUrl}/mcp`),
      scopesSupported: ["netbird"],
      resourceName: "NetBird",
    }),
  );
  // Our interactive login step (the page /authorize renders posts here). Rate
  // limited like the SDK's own auth routes, since each submission triggers an
  // outbound PAT verification.
  app.post("/oauth/netbird-login", loginRateLimiter(), provider.handleLogin);
}

app.post("/mcp", async (req, res) => {
  let auth: AuthContext;
  try {
    auth = await resolveAuth(req.headers, {
      provider: oauthEnabled ? provider : undefined,
      tokenHeader,
      urlHeader,
      allowedApiHosts: config.allowedApiHosts,
      directPatEnabled,
      verifyPat: verifyDirectPat,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      // Point unauthenticated clients at the resource metadata so Claude can
      // discover the OAuth endpoints and start the flow.
      res
        .status(401)
        .set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`)
        .json({ jsonrpc: "2.0", error: { code: -32001, message: err.message }, id: null });
      return;
    }
    throw err;
  }

  // Stateless: fresh transport + server per request, disposed when the response closes.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer({ auth, config, logger, rateLimiter: limiters.get(auth.token) });

  res.on("close", () => {
    transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error("error handling mcp request", { message: (err as Error).message });
    if (!res.headersSent) {
      res
        .status(500)
        .json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// Streamable HTTP GET/DELETE are for stateful sessions; this server is stateless.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. This server is stateless; use POST /mcp." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(port, host, () => {
  logger.info("netbird mcp server ready (http)", {
    host,
    port,
    endpoint: "/mcp",
    publicBaseUrl,
    oauthEnabled,
    destructiveEnabled: config.enableDestructive,
  });
});
