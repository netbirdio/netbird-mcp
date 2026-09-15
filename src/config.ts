/**
 * Central configuration. All environment parsing happens behind loadServerConfig();
 * entrypoints (bin/*) call it and pass resolved values everywhere else, so tool
 * logic and transport wiring stay transport-agnostic.
 */

import { checkApiUrl, hostOf } from "./netbird/apiUrlPolicy.js";

export const DEFAULT_NETBIRD_API_URL = "https://api.netbird.io";
/** Client-side cap kept under NetBird Cloud's 120 req/min limit. */
export const DEFAULT_MAX_REQUESTS_PER_MINUTE = 110;
/** Per-request timeout for NetBird calls, in ms. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Default header carrying a direct NetBird PAT (fallback auth path). */
export const DEFAULT_TOKEN_HEADER = "x-netbird-token";
/** Default header carrying a self-hosted management API base URL. */
export const DEFAULT_URL_HEADER = "x-netbird-api-url";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** HTTP (cloud) entrypoint settings — unused by the stdio entrypoint. */
export interface HttpConfig {
  /** Host/interface the Streamable HTTP server binds to. */
  host: string;
  /** Port the Streamable HTTP server listens on. */
  port: number;
  /** Header carrying a direct NetBird PAT (fallback auth path). */
  tokenHeader: string;
  /** Header carrying a per-tenant NetBird base URL override. */
  urlHeader: string;
  /** Whether the OAuth 2.1 authorization server is mounted. */
  oauthEnabled: boolean;
  /**
   * Whether the direct-PAT header path (x-netbird-token / Authorization: Token)
   * is available. Defaults OFF when OAuth is enabled — a caller must opt in via
   * NETBIRD_ENABLE_DIRECT_PAT — and ON when OAuth is disabled, since it is then
   * the only way to authenticate over HTTP.
   */
  directPatEnabled: boolean;
  /** Externally reachable origin the AS advertises in its metadata. */
  publicBaseUrl: string;
  /** Whether a PAT is verified against NetBird at OAuth login time. */
  verifyPatOnLogin: boolean;
  /**
   * Express `trust proxy` setting. Behind a reverse proxy / load balancer the
   * per-IP rate limits (OAuth routes, the login form, and per-source login
   * verification) must key on the real client IP, not the proxy's — otherwise
   * every client collapses into one bucket. Set to the number of proxy hops or
   * a preset (e.g. "loopback"); defaults to false (direct connections). Bare
   * booleans are rejected — trusting every proxy allows IP spoofing.
   */
  trustProxy: boolean | number | string;
}

export interface ServerConfig {
  /** Enable destructive tools (delete_peer, delete_policy, delete_group). */
  enableDestructive: boolean;
  /** Client-side cap kept under NetBird Cloud's 120 req/min limit. */
  maxRequestsPerMinute: number;
  /** Per-request timeout for NetBird calls, in ms. */
  requestTimeoutMs: number;
  logLevel: LogLevel;
  /**
   * Hosts a NetBird API base URL is allowed to target — the single trust set the
   * URL policy (see netbird/apiUrlPolicy) checks base URLs against. Contains the
   * configured NETBIRD_API_URL host (which is the public default when unset) plus
   * any NETBIRD_ALLOWED_API_HOSTS entries.
   */
  allowedApiHosts: readonly string[];
  http: HttpConfig;
}

function boolEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Parse the Express `trust proxy` value from env. A bare integer is a hop count
 * (the common "one proxy in front" = 1); anything else is passed through so
 * operators can use Express presets or subnet lists ("loopback", "10.0.0.0/8", …).
 * Unset means false — safe for direct connections.
 *
 * Permissive booleans (true/yes/on) are rejected: `trust proxy: true` makes
 * Express trust the client-controlled leftmost X-Forwarded-For entry, letting
 * anyone spoof their IP past the per-IP rate limits. A hop count or preset is
 * always the safer way to express the same intent.
 */
function parseTrustProxy(value: string | undefined): boolean | number | string {
  const v = value?.trim();
  if (!v) return false;
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10);
  const lower = v.toLowerCase();
  if (["true", "yes", "on"].includes(lower)) {
    throw new Error(
      `NETBIRD_TRUST_PROXY="${v}" is not allowed: trusting every proxy lets clients ` +
        `spoof their IP via X-Forwarded-For and bypass per-IP rate limits. ` +
        `Set the number of proxy hops (e.g. 1) or an Express preset/subnet ` +
        `(e.g. "loopback", "10.0.0.0/8") instead.`,
    );
  }
  if (["false", "no", "off"].includes(lower)) return false;
  return v;
}

/**
 * Build the base-URL host allowlist from operator config: the configured
 * NETBIRD_API_URL host (which normalizeBaseUrl resolves to the public default
 * when unset), plus any NETBIRD_ALLOWED_API_HOSTS entries. Junk entries are
 * dropped and hosts deduped, so the result is a clean trust set for the policy.
 */
function parseAllowedApiHosts(env: NodeJS.ProcessEnv): string[] {
  const configured = hostOf(normalizeBaseUrl(env.NETBIRD_API_URL));
  const extras = (env.NETBIRD_ALLOWED_API_HOSTS ?? "")
    .split(",")
    .map((entry) => hostOf(entry))
    .filter((host): host is string => host !== null);
  const all = [configured, ...extras].filter((host): host is string => host !== null);
  return [...new Set(all)];
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const level = (env.LOG_LEVEL ?? "info").toLowerCase();
  const logLevel: LogLevel = ["debug", "info", "warn", "error"].includes(level)
    ? (level as LogLevel)
    : "info";

  // The operator's configured base URL is trusted (its host is auto-allowlisted),
  // so this only fails fast on a malformed value — a scheme-less or non-http(s)
  // NETBIRD_API_URL — rather than letting the server boot with a broken target.
  const allowedApiHosts = parseAllowedApiHosts(env);
  const configuredBaseUrl = normalizeBaseUrl(env.NETBIRD_API_URL);
  const urlCheck = checkApiUrl(configuredBaseUrl, allowedApiHosts);
  if (!urlCheck.allowed) {
    throw new Error(
      `NETBIRD_API_URL is not usable: ${urlCheck.reason}. ` +
        `Set it to a full https URL for your NetBird API (e.g. https://api.netbird.io).`,
    );
  }

  // Port is resolved first: the public base URL default is derived from it.
  // intEnv guards malformed values — a garbage PORT must not yield NaN here
  // (it would poison the derived publicBaseUrl and the listen call).
  const port = intEnv(env.PORT, 3000);
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");

  // Direct-PAT is a fallback path, not Claude's path. When OAuth is on it stays
  // off unless explicitly opted into; when OAuth is off it defaults on so HTTP
  // deployments still have a way to authenticate.
  const oauthEnabled = boolEnv(env.NETBIRD_ENABLE_OAUTH, true);
  const directPatEnabled = boolEnv(env.NETBIRD_ENABLE_DIRECT_PAT, !oauthEnabled);

  return {
    enableDestructive: boolEnv(env.NETBIRD_ENABLE_DESTRUCTIVE, false),
    maxRequestsPerMinute: intEnv(env.NETBIRD_MAX_RPM, DEFAULT_MAX_REQUESTS_PER_MINUTE),
    requestTimeoutMs: intEnv(env.NETBIRD_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    logLevel,
    allowedApiHosts,
    http: {
      host: env.HOST?.trim() || "0.0.0.0",
      port,
      tokenHeader: env.NETBIRD_TOKEN_HEADER ?? DEFAULT_TOKEN_HEADER,
      urlHeader: env.NETBIRD_URL_HEADER ?? DEFAULT_URL_HEADER,
      oauthEnabled,
      directPatEnabled,
      publicBaseUrl,
      verifyPatOnLogin: boolEnv(env.NETBIRD_VERIFY_PAT_ON_LOGIN, true),
      trustProxy: parseTrustProxy(env.NETBIRD_TRUST_PROXY),
    },
  };
}

export function normalizeBaseUrl(url: string | undefined): string {
  const base = (url && url.trim()) || DEFAULT_NETBIRD_API_URL;
  return base.replace(/\/+$/, "");
}
