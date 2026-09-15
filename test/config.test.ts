import { describe, it, expect } from "vitest";
import { loadServerConfig, normalizeBaseUrl } from "../src/config.js";

describe("loadServerConfig — core fields", () => {
  it("resolves documented defaults when nothing is set", () => {
    const config = loadServerConfig({} as NodeJS.ProcessEnv);
    expect(config.enableDestructive).toBe(false);
    expect(config.maxRequestsPerMinute).toBe(110);
    expect(config.requestTimeoutMs).toBe(30_000);
    expect(config.logLevel).toBe("info");
  });

  it("honors explicit values", () => {
    const config = loadServerConfig({
      NETBIRD_ENABLE_DESTRUCTIVE: "true",
      NETBIRD_MAX_RPM: "42",
      NETBIRD_TIMEOUT_MS: "5000",
      LOG_LEVEL: "debug",
    } as NodeJS.ProcessEnv);
    expect(config.enableDestructive).toBe(true);
    expect(config.maxRequestsPerMinute).toBe(42);
    expect(config.requestTimeoutMs).toBe(5000);
    expect(config.logLevel).toBe("debug");
  });

  it("parses the boolean convention's affirmative tokens case-insensitively", () => {
    for (const value of ["1", "TRUE", "Yes", "ON"]) {
      const config = loadServerConfig({ NETBIRD_ENABLE_DESTRUCTIVE: value } as NodeJS.ProcessEnv);
      expect(config.enableDestructive).toBe(true);
    }
  });

  it("falls back to info for an unrecognized log level", () => {
    const config = loadServerConfig({ LOG_LEVEL: "verbose" } as NodeJS.ProcessEnv);
    expect(config.logLevel).toBe("info");
  });

  it("falls back to the default for a non-positive or malformed numeric value", () => {
    const config = loadServerConfig({
      NETBIRD_MAX_RPM: "not-a-number",
      NETBIRD_TIMEOUT_MS: "-5",
    } as NodeJS.ProcessEnv);
    expect(config.maxRequestsPerMinute).toBe(110);
    expect(config.requestTimeoutMs).toBe(30_000);
  });
});

describe("loadServerConfig — http sub-object defaults", () => {
  it("resolves documented defaults when nothing is set", () => {
    const config = loadServerConfig({} as NodeJS.ProcessEnv);
    expect(config.http).toEqual({
      host: "0.0.0.0",
      port: 3000,
      tokenHeader: "x-netbird-token",
      urlHeader: "x-netbird-api-url",
      oauthEnabled: true,
      directPatEnabled: false,
      publicBaseUrl: "http://localhost:3000",
      verifyPatOnLogin: true,
      trustProxy: false,
    });
  });

  it("derives the default public base URL from a custom port", () => {
    const config = loadServerConfig({ PORT: "8080" } as NodeJS.ProcessEnv);
    expect(config.http.port).toBe(8080);
    expect(config.http.publicBaseUrl).toBe("http://localhost:8080");
  });
});

describe("loadServerConfig — http sub-object explicit values", () => {
  it("honors every explicit http value", () => {
    const config = loadServerConfig({
      HOST: "127.0.0.1",
      PORT: "4000",
      NETBIRD_TOKEN_HEADER: "x-custom-token",
      NETBIRD_URL_HEADER: "x-custom-url",
      NETBIRD_ENABLE_OAUTH: "false",
      PUBLIC_BASE_URL: "https://mcp.example.com/",
      NETBIRD_VERIFY_PAT_ON_LOGIN: "false",
    } as NodeJS.ProcessEnv);
    expect(config.http).toEqual({
      host: "127.0.0.1",
      port: 4000,
      tokenHeader: "x-custom-token",
      urlHeader: "x-custom-url",
      oauthEnabled: false,
      directPatEnabled: true,
      publicBaseUrl: "https://mcp.example.com",
      verifyPatOnLogin: false,
      trustProxy: false,
    });
  });

  it("parses PORT as a number", () => {
    const config = loadServerConfig({ PORT: "9090" } as NodeJS.ProcessEnv);
    expect(config.http.port).toBe(9090);
  });

  it("trims HOST and falls back to all interfaces when blank", () => {
    expect(loadServerConfig({ HOST: " 127.0.0.1 " } as NodeJS.ProcessEnv).http.host).toBe(
      "127.0.0.1",
    );
    expect(loadServerConfig({ HOST: "   " } as NodeJS.ProcessEnv).http.host).toBe("0.0.0.0");
  });

  it("parses NETBIRD_TRUST_PROXY: unset -> false, integer -> hop count, preset -> passthrough", () => {
    const trust = (v?: string) =>
      loadServerConfig({ NETBIRD_TRUST_PROXY: v } as NodeJS.ProcessEnv).http.trustProxy;
    expect(trust(undefined)).toBe(false);
    expect(trust("1")).toBe(1); // one proxy hop in front
    expect(trust("false")).toBe(false);
    expect(trust("no")).toBe(false);
    expect(trust("off")).toBe(false);
    expect(trust("loopback")).toBe("loopback"); // Express preset, passed through
  });

  it("rejects permissive NETBIRD_TRUST_PROXY booleans at startup", () => {
    // `trust proxy: true` makes Express trust the client-controlled leftmost
    // X-Forwarded-For entry, letting anyone spoof their IP past the per-IP rate
    // limits. Safe alternatives (a hop count or preset) always exist, so a bare
    // boolean fails fast instead of silently enabling the unsafe mode.
    for (const v of ["true", "yes", "on", "TRUE"]) {
      expect(() => loadServerConfig({ NETBIRD_TRUST_PROXY: v } as NodeJS.ProcessEnv)).toThrow(
        /NETBIRD_TRUST_PROXY/,
      );
    }
  });

  it("strips a trailing slash from an explicit PUBLIC_BASE_URL", () => {
    const config = loadServerConfig({
      PUBLIC_BASE_URL: "https://mcp.example.com///",
    } as NodeJS.ProcessEnv);
    expect(config.http.publicBaseUrl).toBe("https://mcp.example.com");
  });
});

describe("loadServerConfig — direct-PAT availability", () => {
  it("defaults direct-PAT OFF when OAuth is enabled (secure default)", () => {
    const config = loadServerConfig({} as NodeJS.ProcessEnv);
    expect(config.http.oauthEnabled).toBe(true);
    expect(config.http.directPatEnabled).toBe(false);
  });

  it("defaults direct-PAT ON when OAuth is disabled (only auth path left)", () => {
    const config = loadServerConfig({ NETBIRD_ENABLE_OAUTH: "false" } as NodeJS.ProcessEnv);
    expect(config.http.directPatEnabled).toBe(true);
  });

  it("honors an explicit opt-in while OAuth stays enabled", () => {
    const config = loadServerConfig({ NETBIRD_ENABLE_DIRECT_PAT: "true" } as NodeJS.ProcessEnv);
    expect(config.http.oauthEnabled).toBe(true);
    expect(config.http.directPatEnabled).toBe(true);
  });

  it("honors an explicit opt-out even when OAuth is disabled", () => {
    const config = loadServerConfig({
      NETBIRD_ENABLE_OAUTH: "false",
      NETBIRD_ENABLE_DIRECT_PAT: "false",
    } as NodeJS.ProcessEnv);
    expect(config.http.directPatEnabled).toBe(false);
  });
});

describe("loadServerConfig — http boolean flags (false/FALSE/unset)", () => {
  it("NETBIRD_ENABLE_OAUTH: unset defaults to enabled", () => {
    expect(loadServerConfig({} as NodeJS.ProcessEnv).http.oauthEnabled).toBe(true);
  });

  it("NETBIRD_ENABLE_OAUTH: 'false' disables", () => {
    expect(
      loadServerConfig({ NETBIRD_ENABLE_OAUTH: "false" } as NodeJS.ProcessEnv).http.oauthEnabled,
    ).toBe(false);
  });

  it("NETBIRD_ENABLE_OAUTH: 'FALSE' disables (case-insensitive)", () => {
    expect(
      loadServerConfig({ NETBIRD_ENABLE_OAUTH: "FALSE" } as NodeJS.ProcessEnv).http.oauthEnabled,
    ).toBe(false);
  });

  it("NETBIRD_ENABLE_OAUTH: 'true' keeps it enabled", () => {
    expect(
      loadServerConfig({ NETBIRD_ENABLE_OAUTH: "true" } as NodeJS.ProcessEnv).http.oauthEnabled,
    ).toBe(true);
  });

  it("NETBIRD_VERIFY_PAT_ON_LOGIN: unset defaults to enabled", () => {
    expect(
      loadServerConfig({} as NodeJS.ProcessEnv).http.verifyPatOnLogin,
    ).toBe(true);
  });

  it("NETBIRD_VERIFY_PAT_ON_LOGIN: 'false' disables", () => {
    expect(
      loadServerConfig({ NETBIRD_VERIFY_PAT_ON_LOGIN: "false" } as NodeJS.ProcessEnv).http
        .verifyPatOnLogin,
    ).toBe(false);
  });

  it("NETBIRD_VERIFY_PAT_ON_LOGIN: 'FALSE' disables (case-insensitive)", () => {
    expect(
      loadServerConfig({ NETBIRD_VERIFY_PAT_ON_LOGIN: "FALSE" } as NodeJS.ProcessEnv).http
        .verifyPatOnLogin,
    ).toBe(false);
  });
});

describe("loadServerConfig — http header names", () => {
  it("uses the dedicated defaults when unset", () => {
    const config = loadServerConfig({} as NodeJS.ProcessEnv);
    expect(config.http.tokenHeader).toBe("x-netbird-token");
    expect(config.http.urlHeader).toBe("x-netbird-api-url");
  });

  it("round-trips custom header names", () => {
    const config = loadServerConfig({
      NETBIRD_TOKEN_HEADER: "authorization-token",
      NETBIRD_URL_HEADER: "x-nb-url",
    } as NodeJS.ProcessEnv);
    expect(config.http.tokenHeader).toBe("authorization-token");
    expect(config.http.urlHeader).toBe("x-nb-url");
  });
});

describe("loadServerConfig — NetBird API host allowlist", () => {
  it("defaults the allowlist to the canonical public host", () => {
    const config = loadServerConfig({} as NodeJS.ProcessEnv);
    expect(config.allowedApiHosts).toEqual(["api.netbird.io"]);
  });

  it("auto-trusts the operator's configured NETBIRD_API_URL host", () => {
    const config = loadServerConfig({
      NETBIRD_API_URL: "https://nb.corp.example.com",
    } as NodeJS.ProcessEnv);
    expect(config.allowedApiHosts).toContain("nb.corp.example.com");
  });

  it("adds NETBIRD_ALLOWED_API_HOSTS entries, accepting bare hosts and full URLs", () => {
    const config = loadServerConfig({
      NETBIRD_ALLOWED_API_HOSTS: "nb1.example.com, https://nb2.example.com:8443/api ,  ",
    } as NodeJS.ProcessEnv);
    expect(config.allowedApiHosts).toContain("nb1.example.com");
    expect(config.allowedApiHosts).toContain("nb2.example.com");
  });

  it("deduplicates hosts and drops unparseable entries", () => {
    const config = loadServerConfig({
      NETBIRD_ALLOWED_API_HOSTS: "api.netbird.io, api.netbird.io, ::: ,",
    } as NodeJS.ProcessEnv);
    expect(config.allowedApiHosts).toEqual(["api.netbird.io"]);
  });

  it("accepts a self-hosted https NETBIRD_API_URL without throwing", () => {
    expect(() =>
      loadServerConfig({ NETBIRD_API_URL: "https://nb.corp.example.com" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("accepts a loopback NETBIRD_API_URL the operator explicitly configured (local/self-host)", () => {
    expect(() =>
      loadServerConfig({ NETBIRD_API_URL: "http://127.0.0.1:8080" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("fails fast when NETBIRD_API_URL is not a valid http(s) URL", () => {
    expect(() =>
      loadServerConfig({ NETBIRD_API_URL: "ftp://nb.example.com" } as NodeJS.ProcessEnv),
    ).toThrow(/NETBIRD_API_URL/);
    expect(() =>
      loadServerConfig({ NETBIRD_API_URL: "api.netbird.io" } as NodeJS.ProcessEnv),
    ).toThrow(/NETBIRD_API_URL/);
  });
});

describe("normalizeBaseUrl", () => {
  it("defaults to the NetBird cloud API URL when unset", () => {
    expect(normalizeBaseUrl(undefined)).toBe("https://api.netbird.io");
  });

  it("defaults when given an empty or whitespace-only string", () => {
    expect(normalizeBaseUrl("")).toBe("https://api.netbird.io");
    expect(normalizeBaseUrl("   ")).toBe("https://api.netbird.io");
  });

  it("strips one or more trailing slashes from a custom URL", () => {
    expect(normalizeBaseUrl("https://nb.example.com/")).toBe("https://nb.example.com");
    expect(normalizeBaseUrl("https://nb.example.com///")).toBe("https://nb.example.com");
  });

  it("leaves a URL without a trailing slash unchanged", () => {
    expect(normalizeBaseUrl("https://nb.example.com")).toBe("https://nb.example.com");
  });
});

describe("loadServerConfig — malformed numeric input", () => {
  it("falls back to the default port on a garbage PORT and derives publicBaseUrl from it", () => {
    const config = loadServerConfig({ PORT: "not-a-port" } as NodeJS.ProcessEnv);
    expect(config.http.port).toBe(3000);
    expect(config.http.publicBaseUrl).toBe("http://localhost:3000");
  });
});
