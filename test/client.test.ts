import { describe, it, expect, vi } from "vitest";
import { NetBirdClient, NetBirdApiError, MAX_BACKOFF_MS } from "../src/netbird/client.js";
import { RateLimiter } from "../src/netbird/rateLimiter.js";
import type { Logger } from "../src/logger.js";

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeClient(fetchImpl: typeof fetch, maxRetries = 4) {
  return new NetBirdClient({
    auth: { token: "test-pat", baseUrl: "https://api.netbird.io" },
    logger: silentLogger,
    rateLimiter: new RateLimiter(1000),
    timeoutMs: 5000,
    fetchImpl,
    maxRetries,
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("NetBirdClient", () => {
  it("sends the Token auth header and parses JSON", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Token test-pat");
      return jsonResponse([{ id: "p1" }]);
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const peers = await client.get("/api/peers");
    expect(peers).toEqual([{ id: "p1" }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("appends query params, skipping undefined", async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toBe("https://api.netbird.io/api/peers?name=laptop");
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    await client.get("/api/peers", { name: "laptop", ip: undefined });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries on 429 then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response("", { status: 429, headers: { "retry-after": "0" } });
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const result = await client.get("/api/peers");
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("caps an oversized Retry-After so a hostile upstream can't stall the call", async () => {
    // A compromised-but-allowlisted upstream could answer 429 with a huge
    // Retry-After (e.g. 24h) and hang the call far past NETBIRD_TIMEOUT_MS,
    // since the backoff sleep runs outside the request timeout guard. The cap
    // must clamp the honored delay to MAX_BACKOFF_MS. Fake timers let us drive
    // the (clamped) sleep instantly and inspect the delay the client chose.
    vi.useFakeTimers();
    try {
      let calls = 0;
      const warnDelays: number[] = [];
      const capturingLogger: Logger = {
        debug: () => {},
        info: () => {},
        warn: (_msg, meta) => {
          const delay = meta?.delay;
          if (typeof delay === "number") warnDelays.push(delay);
        },
        error: () => {},
      };
      const fetchImpl = vi.fn(async () => {
        calls++;
        if (calls === 1) {
          // 86400s == 24h — three-plus orders of magnitude past any sane cap.
          return new Response("", { status: 429, headers: { "retry-after": "86400" } });
        }
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch;

      const client = new NetBirdClient({
        auth: { token: "test-pat", baseUrl: "https://api.netbird.io" },
        logger: capturingLogger,
        rateLimiter: new RateLimiter(1000),
        timeoutMs: 5000,
        fetchImpl,
        maxRetries: 4,
      });

      const pending = client.get("/api/peers");
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result).toEqual({ ok: true });
      expect(calls).toBe(2);
      // The honored delay must be clamped to the cap, not the 86_400_000ms sent.
      expect(warnDelays[0]).toBe(MAX_BACKOFF_MS);
      expect(warnDelays[0]).toBeLessThan(86_400_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws NetBirdApiError on 4xx (non-429)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "not found" }, { status: 404 }),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    await expect(client.get("/api/peers/nope")).rejects.toBeInstanceOf(NetBirdApiError);
  });

  it("serializes JSON bodies on writes", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ name: "eng" });
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      return jsonResponse({ id: "g1", name: "eng" });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const group = await client.post("/api/groups", { name: "eng" });
    expect(group).toEqual({ id: "g1", name: "eng" });
  });
});

describe("NetBirdClient#verifyToken", () => {
  it("hits /api/users with the Token auth header and returns ok on success", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://api.netbird.io/api/users");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Token test-pat");
      return jsonResponse([{ id: "u1" }]);
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    expect(await client.verifyToken()).toBe("ok");
  });

  it("returns invalid on 401", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "unauthorized" }, { status: 401 }),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    expect(await client.verifyToken()).toBe("invalid");
  });

  it("returns invalid on 403", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "forbidden" }, { status: 403 }),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    expect(await client.verifyToken()).toBe("invalid");
  });

  it("retries on 429 then returns ok", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response("", { status: 429, headers: { "retry-after": "0" } });
      }
      return jsonResponse([{ id: "u1" }]);
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    expect(await client.verifyToken()).toBe("ok");
    expect(calls).toBe(2);
  });

  it("returns unknown on a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl, 0);
    expect(await client.verifyToken()).toBe("unknown");
  });

  it("returns unknown on 500", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "boom" }, { status: 500 }),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl, 0);
    expect(await client.verifyToken()).toBe("unknown");
  });
});

describe("NetBirdClient retries and non-idempotent POSTs", () => {
  // A stand-in for the NetBird API: every POST /api/setup-keys creates a key
  // before the reply goes out. The first reply then goes wrong in one of the
  // ways a client can't tell apart from "not created": the connection drops,
  // the client times out, or a proxy answers 503.
  function setupKeyServer(firstReply: "drop" | "timeout" | "503") {
    const created: string[] = [];
    const fetchImpl = vi.fn(async (_url, init?: RequestInit) => {
      const id = `key-${created.length + 1}`;
      created.push(id);
      if (created.length === 1) {
        if (firstReply === "drop") throw new TypeError("fetch failed: socket hang up");
        if (firstReply === "503") {
          return new Response("upstream error", { status: 503, headers: { "retry-after": "0" } });
        }
        await new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          ),
        );
      }
      return jsonResponse({ id });
    }) as unknown as typeof fetch;
    return { created, fetchImpl };
  }

  for (const firstReply of ["drop", "timeout", "503"] as const) {
    it(`one POST creates one object when the reply is lost (${firstReply})`, async () => {
      const { created, fetchImpl } = setupKeyServer(firstReply);
      const client = new NetBirdClient({
        auth: { token: "test-pat", baseUrl: "https://api.netbird.io" },
        logger: silentLogger,
        rateLimiter: new RateLimiter(1000),
        timeoutMs: 50,
        fetchImpl,
      });

      const call = client.post("/api/setup-keys", { name: "ci-runner" });
      await expect(call).rejects.toBeInstanceOf(NetBirdApiError);
      await expect(call).rejects.toThrow("may have been processed");
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(created).toEqual(["key-1"]);
    });
  }

  it("keeps the POST warning when the reply body is cut off", async () => {
    const fetchImpl = vi.fn(async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.error(new TypeError("terminated: other side closed"));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const call = makeClient(fetchImpl).post("/api/setup-keys", { name: "ci-runner" });
    await expect(call).rejects.toBeInstanceOf(NetBirdApiError);
    await expect(call).rejects.toThrow("may have been processed");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries a GET whose reply body is cut off", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        const body = new ReadableStream({
          start(controller) {
            controller.error(new TypeError("terminated: other side closed"));
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      }
      return jsonResponse([{ id: "p1" }]);
    }) as unknown as typeof fetch;

    const peers = await makeClient(fetchImpl).get("/api/peers");
    expect(peers).toEqual([{ id: "p1" }]);
    expect(calls).toBe(2);
  });

  it("still retries a POST on 429, which the server rejected before processing", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response("", { status: 429, headers: { "retry-after": "0" } });
      return jsonResponse({ id: "key-1" });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    expect(await client.post("/api/setup-keys", { name: "ci-runner" })).toEqual({ id: "key-1" });
    expect(calls).toBe(2);
  });

  for (const method of ["get", "put", "delete"] as const) {
    it(`still retries an idempotent ${method.toUpperCase()} on 503 and on a network error`, async () => {
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls++;
        if (calls === 1) throw new TypeError("fetch failed");
        if (calls === 2) return new Response("", { status: 503, headers: { "retry-after": "0" } });
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch;

      const client = makeClient(fetchImpl);
      const result =
        method === "get"
          ? await client.get("/api/groups/g1")
          : method === "put"
            ? await client.put("/api/groups/g1", { name: "eng" })
            : await client.delete("/api/groups/g1");
      expect(result).toEqual({ ok: true });
      expect(calls).toBe(3);
    });
  }
});
