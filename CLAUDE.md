# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev    # run with nodemon (auto-reload) — primary dev command
npm run run    # run once with node
```

No tests, lint, or build step exist (`npm test` is a placeholder that errors). The server listens on `PORT` (default 3000).

## Architecture

This is the **backend** for Cisco Webex Instant Connect integrated with Webex Contact Center (WxCC) via the Work Items / Task Routing API. It's a single-file Express 5 app (ESM, `"type": "module"`) in `server.js` with one business endpoint. There is no bundled frontend — the browser client is served separately (typically VS Code Live Server on port **5500** in demos).

### Request flow — why a single endpoint
`/api/start-session` does both halves of the handoff server-side:

1. Calls the Webex Instant Connect broker (`mtg-broker-a.wbx2.com/.../joseencrypt`) to mint a **host** + **guest** link.
2. Calls the WxCC Task Routing API (`routing-api.{produs1|prodeu1}.ciscoccservice.com/v2/tasks`) to create an agent work item, passing the **host** link in `workItemData`.
3. Returns **only the guest link** (plus `originId`) to the browser.

The host link is a privileged, moderator-level credential — the whole point of this design is that it never leaves the server. Do not add an endpoint that returns `hostUrl` to the client.

### Endpoints (`server.js`)
- `POST /api/start-session` — the combined meeting+agent flow above. Required body: `name`, `email`, `verticalType`, `destinationId`, `channel`, `region` (`us`|`emea`). Optional: `uri` (when present, a `sip-no-knock` flow block is injected into the JWT so the meeting dials a SIP endpoint without a knock/lobby). Response: `{guestUrl, originId}`. The `aud` passed to Instant Connect is a hardcoded Cisco app GUID (`INSTANT_CONNECT_AUD`).
- `GET /api/health` — returns `{status: 'OK'}`.

### Environment
`.env` (loaded via `dotenv` only when `NODE_ENV !== 'production'`) holds tokens and config:
- `BOT_TOKEN_G2G` — Webex Instant Connect bot token (always guest-to-guest here; `loginUrlForHost: false` is hardcoded).
- `TASK_ROUTING_TOKEN_US`, `TASK_ROUTING_TOKEN_EMEA` — per-region WxCC routing tokens. Only need the one(s) for the region(s) you actually route to; the startup log prints `set` / `MISSING` for each.
- `ALLOWED_ORIGINS` — comma-separated CORS allowlist (e.g. `https://your-frontend.example.com`). Defaults to `http://localhost:5500,http://127.0.0.1:5500` for Live Server demos.
- `WEBEX_CLIENT_ID_US`/`_EMEA`, `WEBEX_CLIENT_SECRET_US`/`_EMEA` — client credentials of each tenant's Webex **service app** (they differ per tenant, so there is no shared pair). Optional; enable token auto-refresh (see below).
- `TASK_ROUTING_REFRESH_TOKEN_US`, `TASK_ROUTING_REFRESH_TOKEN_EMEA` — per-region refresh tokens. Optional.
- `WEBEX_TOKEN_URL` — optional override, defaults to `https://webexapis.com/v1/access_token`.
- `SECRETS_PROJECT` — optional GCP project id; enables saving/loading refreshed tokens in Secret Manager (secrets `ic-work-items-routing-tokens-us` / `ic-work-items-routing-tokens-emea`, must exist; each refresh adds a version).
- `CRON_SECRET` — shared secret for `POST /internal/refresh-tokens`; the endpoint returns 503 when unset.
- `PORT` — defaults to 3000.

`.env.example` documents all of these. `.env` is gitignored and **not** deployed; on Cloud Run set them with `gcloud run deploy/services update --update-env-vars` (use a custom delimiter such as `"^@^KEY=a,b,c"` when a value contains commas).

### Routing token auto-refresh
WxCC routing access tokens expire. In `server.js`, `ROUTING_REGIONS[region]` also holds `clientId`, `clientSecret`, `refreshToken`, `expiresAt` and a `refreshing` promise. `getRoutingToken()` returns a valid token: when `canRefresh()` is true (that region's client id + secret + refresh token all set) it renews via the OAuth `refresh_token` grant if the token expires within 5 min (`REFRESH_MARGIN_MS`) or when forced. Concurrent callers share one in-flight refresh. The `/api/start-session` handler also retries the Routing API call **once** after a `401` with a forced refresh. Without the refresh vars the static `TASK_ROUTING_TOKEN_*` is used unchanged.

`BOT_TOKEN_G2G` is not refreshed. Never log token values.

**Persistence and scheduled renewal.** Cloud Run scales to zero and throttles CPU between requests, so in-process timers are unreliable. `refreshAndPersist()` refreshes and then saves `{accessToken, refreshToken, expiresAt, seedRefreshToken}` to Secret Manager (only when `SECRETS_PROJECT` is set); `loadStoredTokens()` reads the latest version at startup (top-level await). `seedRefreshToken` is the env refresh token the stored tokens started from: if the env value differs (manual re-authorization), the env value wins. A failed save is logged as ERROR and flagged via `r.persistOk` but does not fail the triggering request. Without `SECRETS_PROJECT`, tokens live in memory only and a rotated refresh token logs a warning to update the env var.

`POST /internal/refresh-tokens` (rate-limited, `X-Cron-Secret` header checked with `timingSafeEqual` against `CRON_SECRET`; the service is public via `--no-invoker-iam-check`, so this is the only auth) force-refreshes every region that `canRefresh()`. Cloud Scheduler calls it every 3 days. Returns 200 only if all configured regions refreshed and saved, else 500. Setup commands are in README.md. In production the credentials (client secrets, seed refresh tokens, `BOT_TOKEN_G2G`, `CRON_SECRET`) are injected as env vars from Secret Manager secrets named `ic-work-items-*` via `--update-secrets`; the code just reads `process.env`, so no code path differs.

### CORS
Allowlist driven by `ALLOWED_ORIGINS` (exact origin match: scheme + host + port, no path or trailing slash; setting it replaces the localhost default). The parsed list is logged at startup. Requests with no `Origin` header (curl, server-to-server, same-origin) pass through; browser requests from any other origin are rejected and logged. Methods limited to `GET`/`POST`, headers to `Content-Type`/`Authorization`, credentials off, preflight cached 24h.

### Rate limiting
Uses `express-rate-limit`. `app.set('trust proxy', 1)` is on so `req.ip` reads one hop of `X-Forwarded-For` (correct for Cloud Run / single reverse proxy). Counters are in-memory (reset on restart; fine with max-instances 1). All limiters share an `onLimit` helper that logs and returns 429 `{error: 'Too many requests, please try again later'}`.

Per route:
- `/api/start-session` — 5/min per IP + 60/hour global. It burns Webex bot-token quota **and** spawns live-agent work, so it gets the two-layer protection (per-IP for common abusers, global as a circuit breaker against distributed floods).
- `/api/health` — unlimited.

Pattern mirrors `../be-instant-connect/server.js` and `../cisco-live-2026-be/server.js`.

## Known issues / gotchas

- No auth on the endpoint — anyone who can reach the backend can mint meetings and queue agent tasks. Rate limiting slows abuse but is not a substitute for an API key / JWT before exposing publicly.
- `loginUrlForHost` is hardcoded to `false`; this backend only supports the non-G2G host flow. If you need guest-to-guest meetings, surface the field.
- The `aud` value in `/api/start-session` is a hardcoded Cisco app GUID.
- CORS is not authentication: it only restricts browsers. Direct callers (curl) have no `Origin` header and pass; rate limiting is the real abuse control.
- The demo page lives at `https://wazquez.github.io/click-to-video/` (separate repo `click-to-video`) and needs `https://wazquez.github.io` in `ALLOWED_ORIGINS` on the deployed service.
- Deploy from this folder (`gcloud run deploy consolidated-ic-tr-be --source .`); running it from another directory makes the Buildpacks build fail.
