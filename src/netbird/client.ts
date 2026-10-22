import type { AuthContext } from "../auth/context.js";
import type { Logger } from "../logger.js";
import { RateLimiter, sleep } from "./rateLimiter.js";

export interface NetBirdClientOptions {
  auth: AuthContext;
  logger: Logger;
  rateLimiter: RateLimiter;
  timeoutMs: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Max retries on 429 / 5xx / network errors (POST: 429 only). */
  maxRetries?: number;
}

export class NetBirdApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "NetBirdApiError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Query string params for GET requests. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body for write requests. */
  body?: unknown;
}

/** Cheap authenticated read used to check whether a token can authenticate. */
const USERS_PATH = "/api/users";

/**
 * Upper bound on any single backoff sleep. The backoff runs OUTSIDE the
 * per-request AbortController/timeout guard, so an allowlisted-but-hostile
 * upstream could otherwise answer 429/5xx with an enormous `Retry-After`
 * (e.g. 24h) and hang the call far past NETBIRD_TIMEOUT_MS. Clamping every
 * honored delay to this cap keeps total call time bounded (<= maxRetries *
 * MAX_BACKOFF_MS) regardless of what the upstream sends.
 */
export const MAX_BACKOFF_MS = 30_000;

/** One fetch attempt's result: either the HTTP response, or the thrown transport error. */
type FetchOutcome =
  | { readonly kind: "response"; readonly res: Response }
  | { readonly kind: "error"; readonly error: unknown };

/** What to do after classifying an attempt's outcome. */
type RetryDecision<T> =
  | { readonly action: "retry" }
  | { readonly action: "return"; readonly value: T }
  | { readonly action: "throw"; readonly error: NetBirdApiError };

/** Outcome of a token-verification call: valid, rejected, or indeterminate. */
export type TokenVerification = "ok" | "invalid" | "unknown";

/**
 * Thin REST client for the NetBird public API. Handles auth, timeouts, a
 * client-side rate limit, and exponential backoff on 429/5xx (honoring
 * Retry-After; POST only on 429). Transport-agnostic — one instance per AuthContext.
 */
export class NetBirdClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;

  constructor(private readonly opts: NetBirdClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 4;
  }

  get<T = unknown>(path: string, query?: RequestOptions["query"]): Promise<T> {
    return this.request<T>(path, { method: "GET", query });
  }

  post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body });
  }

  put<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PUT", body });
  }

  delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }

  /**
   * Verifies that this client's credentials can authenticate against its base
   * URL, via the same auth header, timeout, retry, and rate-limit path as every
   * other call. Maps the outcome to a three-state result: "ok" on success,
   * "invalid" on 401/403, and "unknown" for anything else (timeouts, network
   * failures, 5xx, or other unexpected errors).
   */
  async verifyToken(): Promise<TokenVerification> {
    try {
      await this.get(USERS_PATH);
      return "ok";
    } catch (err) {
      if (err instanceof NetBirdApiError && (err.status === 401 || err.status === 403)) {
        return "invalid";
      }
      return "unknown";
    }
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(this.opts.auth.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async request<T>(path: string, options: RequestOptions): Promise<T> {
    const method = options.method ?? "GET";
    const url = this.buildUrl(path, options.query);

    let attempt = 0;
    // Retry loop: 429/5xx and transport errors are retried with backoff. Each
    // iteration's outcome is classified in one place (decideRetry), which owns
    // the delay/log/sleep and makes the terminal "throw once exhausted"
    // explicit rather than a fall-through.
    while (true) {
      await this.opts.rateLimiter.acquire();
      const outcome = await this.fetchOnce(url, method, options);
      const decision = await this.decideRetry<T>(outcome, attempt, method, path);
      switch (decision.action) {
        case "retry":
          attempt++;
          continue;
        case "return":
          return decision.value;
        case "throw":
          throw decision.error;
      }
    }
  }

  /**
   * Perform exactly one fetch under the request timeout, surfacing the outcome
   * as data. The AbortController/timeout is always cleared in `finally` (no
   * duplicate clear on the error path).
   */
  private async fetchOnce(
    url: string,
    method: string,
    options: RequestOptions,
  ): Promise<FetchOutcome> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Token ${this.opts.auth.token}`,
          Accept: "application/json",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      return { kind: "response", res };
    } catch (err) {
      return { kind: "error", error: err };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Classify one attempt's outcome into retry | return | throw. Retryable
   * outcomes (transport error, or 429/5xx) still within the retry budget own
   * the whole backoff step here — capped-delay computation, logging, and the
   * sleep — and return "retry". Everything else is terminal and explicit.
   */
  private async decideRetry<T>(
    outcome: FetchOutcome,
    attempt: number,
    method: string,
    path: string,
  ): Promise<RetryDecision<T>> {
    const canRetry = attempt < this.maxRetries;
    // POST is not idempotent: after a lost reply, a timeout or a 5xx the server
    // may already have created the object, and sending it again creates a second
    // one. So a POST is retried only on 429 (rejected before processing). GET,
    // PUT (full replacement) and DELETE leave the same state when repeated.
    const idempotent = method !== "POST";
    // When a POST is not retried, say so in the error, so a caller (or an agent)
    // doesn't treat it as a definite failure and simply send it again.
    const uncertain = idempotent
      ? ""
      : " (the request may have been processed; check before retrying)";

    if (outcome.kind === "error") {
      if (canRetry && idempotent) {
        await this.backoff(backoffMs(attempt), "netbird request failed, retrying", {
          method,
          path,
          attempt,
        });
        return { action: "retry" };
      }
      const msg = `Network error calling NetBird ${method} ${path}: ${(outcome.error as Error).message}${uncertain}`;
      return { action: "throw", error: new NetBirdApiError(msg, 0) };
    }

    const { res } = outcome;
    if ((res.status === 429 || (res.status >= 500 && idempotent)) && canRetry) {
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      // Clamp the honored delay: never trust an upstream Retry-After beyond the cap.
      const delay = Math.min(retryAfter ?? backoffMs(attempt), MAX_BACKOFF_MS);
      await this.backoff(delay, "netbird throttled/5xx, backing off", {
        method,
        path,
        status: res.status,
        attempt,
      });
      return { action: "retry" };
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      // The headers arrived but the body was cut off. Idempotent methods retry like
      // any other transport error; a POST may still have been processed, so it
      // keeps the same warning instead.
      if (canRetry && idempotent) {
        await this.backoff(backoffMs(attempt), "netbird response cut off, retrying", {
          method,
          path,
          attempt,
        });
        return { action: "retry" };
      }
      const msg = `Network error reading NetBird ${method} ${path} response: ${(err as Error).message}${uncertain}`;
      return { action: "throw", error: new NetBirdApiError(msg, 0) };
    }
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const error = new NetBirdApiError(
        `NetBird ${method} ${path} failed with ${res.status}${res.status >= 500 ? uncertain : ""}`,
        res.status,
        parsed ?? text,
      );
      return { action: "throw", error };
    }
    return { action: "return", value: parsed as T };
  }

  /** Single place that logs a pending retry and sleeps for the (already capped) delay. */
  private async backoff(
    delay: number,
    message: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    this.opts.logger.warn(message, { ...context, delay });
    await sleep(delay);
  }
}

/**
 * Verify a NetBird PAT by constructing a short-lived client and issuing the
 * cheap authenticated read. The single wrapper both the OAuth login flow and the
 * direct-PAT request path use, so the auth-header convention, timeout, retry, and
 * rate limiting have exactly one implementation. Never throws — see verifyToken.
 */
export function verifyPat(
  auth: AuthContext,
  deps: { logger: Logger; rateLimiter: RateLimiter; timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<TokenVerification> {
  return new NetBirdClient({ auth, ...deps }).verifyToken();
}

function backoffMs(attempt: number): number {
  // Exponential backoff with jitter: ~0.5s, 1s, 2s, 4s (+/- 20%).
  const base = 500 * 2 ** attempt;
  const jitter = base * 0.2 * (0.5 - deterministicJitter(attempt));
  return Math.round(base + jitter);
}

// Avoids Math.random (banned in some harness contexts); deterministic small jitter.
function deterministicJitter(attempt: number): number {
  return ((attempt * 2654435761) % 1000) / 1000;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
