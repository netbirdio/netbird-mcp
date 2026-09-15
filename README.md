# NetBird MCP Server

An [MCP](https://modelcontextprotocol.io) server for [NetBird](https://netbird.io) that lets
you manage your network — peers, setup keys, groups, policies, networks and DNS — from Claude
in natural language, instead of the dashboard or raw REST calls.

**One codebase, two ways to run:**

- **Local (stdio)** — runs as a subprocess of Claude Desktop / Claude Code. Credentials from env.
- **Cloud (Streamable HTTP)** — hosted and added to Claude as a remote/custom connector.
  Stateless and multi-tenant; each request carries its own NetBird token.

Everything below the entrypoint (tools, API client) is shared, so both modes expose the
identical tool set. See [`PLAN.md`](PLAN.md) for the full design and roadmap.

---

## Install & build

```bash
npm install
npm run build
npm test        # unit tests (mocked NetBird API)
```

## Getting a NetBird token

Create a **service user** in the NetBird dashboard and issue a **Personal Access Token (PAT)**
for it (NetBird's recommendation for org-wide API flows). The server sends it as
`Authorization: Token <PAT>` on every call.

---

## Run locally (stdio)

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "netbird": {
      "command": "npx",
      "args": ["-y", "@netbird/mcp"],
      "env": {
        "NETBIRD_API_TOKEN": "nb_pat_xxx",
        "NETBIRD_API_URL": "https://api.netbird.io"
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add netbird -e NETBIRD_API_TOKEN=nb_pat_xxx -- npx -y @netbird/mcp
```

**Local dev / debugging** with the MCP Inspector:

```bash
cp .env.example .env   # fill in NETBIRD_API_TOKEN
npm run inspect
```

---

## Run in the cloud (Streamable HTTP)

```bash
docker build -t netbird-mcp .
docker run -p 3000:3000 netbird-mcp
```

Set `PUBLIC_BASE_URL` to the externally reachable HTTPS origin (used in the OAuth metadata):

```bash
docker run -p 3000:3000 -e PUBLIC_BASE_URL=https://netbird-mcp.example.com netbird-mcp
```

The server exposes:

- `POST /mcp` — the MCP endpoint (stateless)
- `GET /healthz` — health check
- OAuth 2.1 endpoints (see below): `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource/mcp`, `/authorize`, `/token`, `/register`, `/revoke`

### Connect it to your Claude account (OAuth)

Add it in Claude as a **remote / custom connector** pointing at `https://<your-host>/mcp`.
Claude then runs a standard OAuth 2.1 flow — it registers itself dynamically, and you'll be
sent to a **"Connect NetBird"** login page where you paste your NetBird PAT once. Claude
receives an OAuth access token bound to that PAT server-side; the PAT itself never goes to
Claude. This is the recommended path.

The flow implemented: OAuth 2.0 Protected Resource + Authorization Server metadata discovery
(RFC 9728 / 8414), Dynamic Client Registration (RFC 7591), authorization-code grant with
**PKCE (S256)**, and refresh tokens. An unauthenticated `POST /mcp` returns `401` with a
`WWW-Authenticate: Bearer resource_metadata="…"` header so Claude can discover the endpoints.

> The prototype keeps OAuth token→PAT bindings **in memory**. For production, back them with a
> shared, encrypted store (e.g. Redis) so tokens survive restarts and work across replicas.

> Behind a reverse proxy or load balancer, set `NETBIRD_TRUST_PROXY` (see Configuration) so the
> per-IP rate limits — the OAuth routes, the `/oauth/netbird-login` form, and per-source login
> PAT verification — key on the real client IP rather than the proxy's. Left unset behind a proxy,
> every client collapses into one bucket, which throttles everyone instead of isolating abusers.

### Direct-PAT alternative (testing / simple deploys)

Instead of OAuth you can pass the NetBird PAT directly per request via the `x-netbird-token`
header (configurable with `NETBIRD_TOKEN_HEADER`) or `Authorization: Token <pat>`. The token is
used only for the life of the request and never persisted, so one deployment still serves many
tenants. `Authorization: Bearer` is reserved for OAuth.

This path is **off by default whenever OAuth is enabled** — turn it on explicitly with
`NETBIRD_ENABLE_DIRECT_PAT=true` (it is on automatically when OAuth is disabled, since it is then
the only way to authenticate). When it is on, each request's base URL must be on the host
allowlist — the configured `NETBIRD_API_URL` host plus anything in `NETBIRD_ALLOWED_API_HOSTS` —
and the presented PAT is verified against NetBird before any tool runs, so the server can't be
steered at an arbitrary host or driven with an unverified token.

---

## Configuration

| Variable | Mode | Default | Purpose |
|----------|------|---------|---------|
| `NETBIRD_API_TOKEN` | local | — | NetBird PAT (required for stdio) |
| `NETBIRD_API_URL` | both | `https://api.netbird.io` | API base URL; set for self-hosted |
| `NETBIRD_ALLOWED_API_HOSTS` | both | (the `NETBIRD_API_URL` host) | Extra hosts a request-supplied base URL may target, comma-separated |
| `NETBIRD_ENABLE_DESTRUCTIVE` | both | `false` | Enable `delete_*` tools |
| `NETBIRD_MAX_RPM` | both | `110` | Client-side rate cap (under NetBird's 120/min) |
| `NETBIRD_TIMEOUT_MS` | both | `30000` | Per-request timeout |
| `LOG_LEVEL` | both | `info` | `debug` \| `info` \| `warn` \| `error` |
| `HOST` | cloud | `0.0.0.0` | Interface the HTTP server binds to; use `127.0.0.1` for a local-only daemon |
| `PORT` | cloud | `3000` | HTTP listen port |
| `PUBLIC_BASE_URL` | cloud | `http://localhost:PORT` | Public HTTPS origin advertised in OAuth metadata |
| `NETBIRD_ENABLE_OAUTH` | cloud | `true` | Enable the OAuth 2.1 authorization server |
| `NETBIRD_ENABLE_DIRECT_PAT` | cloud | off when OAuth on | Allow the direct-PAT header path (auto-on when OAuth is off) |
| `NETBIRD_VERIFY_PAT_ON_LOGIN` | cloud | `true` | Live-check the PAT during OAuth login |
| `NETBIRD_TRUST_PROXY` | cloud | `false` | Express `trust proxy` for real client IPs behind a proxy: hop count (e.g. `1`) or preset (`loopback`). Bare booleans are rejected — trusting every proxy allows IP spoofing |
| `NETBIRD_TOKEN_HEADER` | cloud | `x-netbird-token` | Header carrying the caller's PAT (direct-PAT mode) |
| `NETBIRD_URL_HEADER` | cloud | `x-netbird-api-url` | Optional per-tenant base URL header |

Boolean variables accept `1`, `true`, `yes`, or `on` (case-insensitive) as true; any other
value — including a typo — is treated as **false**, so a misspelled flag fails closed rather
than silently enabling something.

---

## Tools (v1)

Read tools are always on. Writes use a **draft-and-confirm** flow: call once to preview the
exact request, then again with `confirm: true` to apply. Deletes are **off by default** — set
`NETBIRD_ENABLE_DESTRUCTIVE=true` to enable them, and they require the exact resource id.

| Group | Tools |
|-------|-------|
| Peers | `list_peers`, `get_peer`, `list_accessible_peers`, `update_peer`, `delete_peer`\* |
| Setup keys | `list_setup_keys`, `create_setup_key`, `update_setup_key` |
| Groups | `list_groups`, `create_group`, `update_group`, `delete_group`\* |
| Policies | `list_policies`, `get_policy`, `create_policy`, `update_policy`, `delete_policy`\* |
| Networks | `list_networks`, `get_network` |
| DNS | `list_nameserver_groups`, `get_dns_settings` |
| Visibility | `list_posture_checks`, `list_events` |

\* destructive — gated behind `NETBIRD_ENABLE_DESTRUCTIVE`.

**Out of scope for v1:** Users/Accounts admin, Tokens, MSP, Invoice/Usage, and cloud-only
IDP/EDR integration configs. DNS writes and posture-check authoring are v2. (OAuth is
implemented — see "Connect it to your Claude account" above. Binding it to an upstream IdP
login instead of a PAT is the remaining v2 auth step.)

---

## Safety

- Client-side rate limiting under NetBird Cloud's 120 req/min, with exponential backoff
  honoring `Retry-After` on 429/5xx.
- Writes preview before applying; deletes are opt-in and require an exact id (never a batch).
- Tokens are never written to logs.
