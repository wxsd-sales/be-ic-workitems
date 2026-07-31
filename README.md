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

## Running

```bash
npm run dev    # with nodemon (auto-reload)
npm run run    # plain node
```

On start, the server logs which routing tokens were loaded (`set` / `MISSING`).

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

### `GET /api/health`

Returns `{ "status": "OK" }`.

## License

ISC
