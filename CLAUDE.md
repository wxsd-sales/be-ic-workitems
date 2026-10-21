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
- `PORT` — defaults to 3000.

### CORS
Allowlist driven by `ALLOWED_ORIGINS`. Requests with no `Origin` header (curl, server-to-server, same-origin) pass through; browser requests from any other origin are rejected and logged. Methods limited to `GET`/`POST`, headers to `Content-Type`/`Authorization`, credentials off, preflight cached 24h.

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
- No `.env.example` is checked in; see the Environment section above for required keys.
