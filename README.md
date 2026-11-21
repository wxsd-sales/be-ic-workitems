# be-ic-work-items

Backend for Cisco **Instant Connect** integration into **Webex Contact Center (WxCC)** via the Work Items / Task Routing API.

It exposes a single endpoint that a customer-facing web page can call to start a
video session. The server:

1. Creates an Instant Connect meeting, producing a **host** link and a **guest** link.
2. Requests an available agent through the WxCC Task Routing API, handing the agent
   the **host** link as work-item data.
3. Returns **only the guest link** to the browser.

The host link is a privileged, moderator-level credential, so it is created and
forwarded entirely server-side and is never sent to the client.

## Requirements

- Node.js 18+ (uses the built-in `fetch` and `node:crypto`).

## Setup

```bash
npm install
cp .env.example .env   # then fill in real values
```

## Environment variables

| Variable                  | Required | Description                                              |
| ------------------------- | -------- | -------------------------------------------------------- |
| `PORT`                    | no       | Port to listen on (default `3000`).                      |
| `BOT_TOKEN_G2G`           | yes      | Instant Connect bot token used to create meeting links.  |
| `TASK_ROUTING_TOKEN_US`   | yes\*    | WxCC Task Routing token for the `us` region.             |
| `TASK_ROUTING_TOKEN_EMEA` | yes\*    | WxCC Task Routing token for the `emea` region.           |

\* You only need the token(s) for the region(s) you actually route to.

Optional variables:

| Variable                          | Description                                                                 |
| --------------------------------- | --------------------------------------------------------------------------- |
| `ALLOWED_ORIGINS`                 | Comma-separated CORS allowlist of browser origins (scheme + host + port, no path or trailing slash). Defaults to `http://localhost:5500,http://127.0.0.1:5500`. |
| `WEBEX_CLIENT_ID_US` / `_EMEA`     | Client ID of the Webex service app of that region's tenant.                 |
| `WEBEX_CLIENT_SECRET_US` / `_EMEA` | Client secret of that service app.                                          |
| `TASK_ROUTING_REFRESH_TOKEN_US`   | Refresh token for the `us` region.                                          |
| `TASK_ROUTING_REFRESH_TOKEN_EMEA` | Refresh token for the `emea` region.                                        |
| `WEBEX_TOKEN_URL`                 | Token endpoint (default `https://webexapis.com/v1/access_token`).           |
| `SECRETS_PROJECT`                 | GCP project id. When set, refreshed tokens are saved to / loaded from Secret Manager. |
| `CRON_SECRET`                     | Shared secret for `POST /internal/refresh-tokens`. The endpoint is disabled when unset. |

### CORS

Browser requests are only accepted from the origins in `ALLOWED_ORIGINS`, for example:

```
ALLOWED_ORIGINS=https://wazquez.github.io,http://localhost:5500,http://127.0.0.1:5500
```

Origins match exactly and never include a path. Setting the variable replaces
the default, so keep the localhost entries if you still use Live Server.
Requests without an `Origin` header (curl, server-to-server) are allowed. On
start the server logs the loaded list.

### Automatic token refresh

WxCC routing access tokens expire. Each region (tenant) has its own service app, so
client ID, client secret and refresh token are configured per region. If all
three are set for a region (`WEBEX_CLIENT_ID_<REGION>`,
`WEBEX_CLIENT_SECRET_<REGION>`, `TASK_ROUTING_REFRESH_TOKEN_<REGION>`), the
server renews that region's access token automatically (standard OAuth `refresh_token` grant against the Webex
token endpoint):

- **Proactively**, 5 minutes before the known expiry.
- **Reactively**, on a `401` from the Routing API (it refreshes and retries once).

Without these variables the static `TASK_ROUTING_TOKEN_*` value is used as-is
until it expires. The startup log shows `enabled` / `disabled` per region.

Renewed tokens are kept in memory only. After a restart (including Cloud Run
scale-to-zero) the server starts again from the env vars, which works as long
as the refresh token is still valid. If Webex issues a new refresh token the
server logs a warning; update `TASK_ROUTING_REFRESH_TOKEN_*` before the next
restart. `BOT_TOKEN_G2G` is not refreshed.

### Keeping the tokens alive when idle (Cloud Run)

Cloud Run can scale to zero and throttles CPU between requests, so an in-process
timer is not reliable. Instead:

1. **Cloud Scheduler** calls `POST /internal/refresh-tokens` every 3 days with the
   `X-Cron-Secret` header, so the tokens are renewed even if nobody uses the demo.
2. **Secret Manager** stores the latest tokens, one secret per region
   (`ic-work-items-routing-tokens-us`, `ic-work-items-routing-tokens-emea`), enabled with `SECRETS_PROJECT`.
   A new version is added after every refresh and the latest is loaded at startup.
   If you re-authorize and put a new refresh token in the env var, the env value
   wins over the stored one.

A refresh failure is logged with `ERROR`; add a log-based alert on it. A refresh
token that has already expired or been revoked cannot be recovered
automatically: generate a new one in the service app.

Setup (replace the placeholders). Run it from this folder, with `.env` filled in.

```bash
PROJECT=<gcp-project>; REGION=us-central1; SERVICE=consolidated-ic-tr-be

gcloud services enable secretmanager.googleapis.com cloudscheduler.googleapis.com

# Service account the backend runs as. Ideally a dedicated one, not the shared
# default compute account, because anyone using it can read these secrets.
SA=$(gcloud run services describe $SERVICE --region $REGION \
      --format='value(spec.template.spec.serviceAccountName)')
```

**1. Store the credentials as secrets** (inputs the app reads; values come from
`.env` without being printed):

| Env var | Secret name |
| --- | --- |
| `WEBEX_CLIENT_SECRET_US` / `_EMEA` | `ic-work-items-client-secret-us` / `-emea` |
| `TASK_ROUTING_REFRESH_TOKEN_US` / `_EMEA` | `ic-work-items-refresh-token-us` / `-emea` |
| `BOT_TOKEN_G2G` | `ic-work-items-bot-token` |
| `CRON_SECRET` | `ic-work-items-cron-secret` |

The client IDs (`WEBEX_CLIENT_ID_*`) are not confidential and stay plain env vars.

```bash
mk() {  # mk <secret-name> <ENV_KEY>: create the secret from the value in .env
  grep "^$2=" .env | cut -d= -f2- | tr -d '\n' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" \
    | gcloud secrets create "$1" --replication-policy=automatic --data-file=-
}
mk ic-work-items-client-secret-us    WEBEX_CLIENT_SECRET_US
mk ic-work-items-client-secret-emea  WEBEX_CLIENT_SECRET_EMEA
mk ic-work-items-refresh-token-us    TASK_ROUTING_REFRESH_TOKEN_US
mk ic-work-items-refresh-token-emea  TASK_ROUTING_REFRESH_TOKEN_EMEA
mk ic-work-items-bot-token           BOT_TOKEN_G2G
mk ic-work-items-cron-secret         CRON_SECRET   # generate one first: openssl rand -hex 32

# Read-only access for the backend's service account
for s in ic-work-items-client-secret-us ic-work-items-client-secret-emea \
         ic-work-items-refresh-token-us ic-work-items-refresh-token-emea \
         ic-work-items-bot-token ic-work-items-cron-secret; do
  gcloud secrets add-iam-policy-binding $s \
    --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
done
```

`tr -d '\n'` strips the trailing newline (a stray newline in a secret breaks
auth) and `sed` strips surrounding quotes. `dotenv` removes quotes from `.env`
values when running locally, but Secret Manager would store them literally and
the upstream APIs would then reject the token (typically an HTML error page).

**2. Create the secrets the app writes to** (empty; the first refresh writes the
first version, see above):

```bash
gcloud secrets create ic-work-items-routing-tokens-us   --replication-policy=automatic
gcloud secrets create ic-work-items-routing-tokens-emea --replication-policy=automatic

# Read and add versions
for s in ic-work-items-routing-tokens-us ic-work-items-routing-tokens-emea; do
  gcloud secrets add-iam-policy-binding $s --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
  gcloud secrets add-iam-policy-binding $s --member="serviceAccount:$SA" --role=roles/secretmanager.secretVersionAdder
done
```

**3. Attach everything to the Cloud Run service:**

```bash
gcloud run services update $SERVICE --region $REGION \
  --update-secrets=WEBEX_CLIENT_SECRET_US=ic-work-items-client-secret-us:latest,\
WEBEX_CLIENT_SECRET_EMEA=ic-work-items-client-secret-emea:latest,\
TASK_ROUTING_REFRESH_TOKEN_US=ic-work-items-refresh-token-us:latest,\
TASK_ROUTING_REFRESH_TOKEN_EMEA=ic-work-items-refresh-token-emea:latest,\
BOT_TOKEN_G2G=ic-work-items-bot-token:latest,\
CRON_SECRET=ic-work-items-cron-secret:latest \
  --update-env-vars "^@^SECRETS_PROJECT=$PROJECT@WEBEX_CLIENT_ID_US=<client-id-us>@WEBEX_CLIENT_ID_EMEA=<client-id-emea>@ALLOWED_ORIGINS=https://wazquez.github.io,http://localhost:5500,http://127.0.0.1:5500"
```

Values are not shown in the Console's variable list, only a reference to the
secret. `gcloud run deploy --source .` keeps the attached secrets, so this step
is not repeated on each deploy.

**4. Scheduler job, every 3 days at 03:00 UTC:**

```bash
gcloud scheduler jobs create http ic-work-items-refresh-tokens \
  --location $REGION --schedule "0 3 */3 * *" --time-zone UTC \
  --uri "$(gcloud run services describe $SERVICE --region $REGION --format='value(status.url)')/internal/refresh-tokens" \
  --http-method POST --headers "X-Cron-Secret=<same value as CRON_SECRET>"
```

The job's header holds the secret value as plain text (a Scheduler limitation),
so keep access to the job restricted.

Test it with `gcloud scheduler jobs run ic-work-items-refresh-tokens --location $REGION`
and check the service logs.

**Rotating a value:** add a new version
(`gcloud secrets versions add <name> --data-file=-`) and start a new revision,
since instances read `:latest` when they start. After re-authorizing a service
app, put the new refresh token in `ic-work-items-refresh-token-*`; the app sees
that it differs from the one stored with the saved tokens and uses the new one.
When rotating `CRON_SECRET`, update the Scheduler header too.

## Running

```bash
npm run dev    # with nodemon (auto-reload)
npm run run    # plain node
```

On start, the server logs which routing tokens were loaded (`set` / `MISSING`), whether token auto-refresh is enabled, and the CORS allowlist.

## API

### `POST /api/start-session`

Creates a meeting and requests an agent.

**Request body**

| Field           | Required | Description                                            |
| --------------- | -------- | ------------------------------------------------------ |
| `name`          | yes      | Customer name.                                         |
| `email`         | yes      | Customer email.                                        |
| `verticalType`  | yes      | Instant Connect vertical/template.                     |
| `destinationId` | yes      | WxCC routing destination (business address) id.        |
| `channel`       | yes      | WxCC channel.                                          |
| `region`        | yes      | Routing region: `us` or `emea`.                        |
| `uri`           | no       | Optional SIP URI (enables the `sip-no-knock` flow).    |

**Response** `200`

```json
{
  "guestUrl": "https://.../guest-short-link",
  "originId": "generated-uuid"
}
```

Errors return `{ "error": "..." }` with an appropriate status code (`400` for
missing/invalid input, `4xx/5xx` propagated from upstream APIs).

### `POST /internal/refresh-tokens`

Renews the routing tokens of every region that has refresh credentials. It is
meant for Cloud Scheduler (see below), not for browsers. Requires the header
`X-Cron-Secret: <CRON_SECRET>` (`401` if wrong, `503` if `CRON_SECRET` is unset).

Response: `{ "us": "ok", "emea": "failed" }`, one entry per region (`ok`,
`refreshed but NOT saved`, `failed`, or `skipped (refresh not configured)`).
Status is `200` only if every configured region succeeded, otherwise `500`.

### `GET /api/health`

Returns `{ "status": "OK" }`.

## License

ISC
