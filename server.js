import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { randomUUID, timingSafeEqual } from 'node:crypto'
if (process.env.NODE_ENV !== 'production') {
    await import('dotenv/config');
}

const app = express();
const port = process.env.PORT || 3000;

// CORS allowlist. Set ALLOWED_ORIGINS in .env as a comma-separated list,
// e.g. "https://doctor.example.com,https://patient.example.com".
// Requests with no Origin header (curl, server-to-server, same-origin) are allowed.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5500,http://127.0.0.1:5500')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
console.log('[Backend] CORS allowed origins:', allowedOrigins);

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        console.warn(`[Backend] CORS blocked origin: ${origin}`);
        return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
    maxAge: 86400,
}));
// Parse JSON bodies
app.use(express.json());

// Cloud Run puts exactly one proxy (Google Frontend) in front of the app, so
// trust one hop of X-Forwarded-For to get the real client IP for rate limiting.
app.set('trust proxy', 1);

// Shared 429 responder; logs which limiter fired and for which client IP.
const onLimit = (limiter) => (req, res) => {
    console.warn(`[Backend] ${req.method} ${req.path} - rate limit hit (${limiter}) ip=${req.ip}`);
    res.status(429).json({ error: 'Too many requests, please try again later' });
};

// /api/start-session mints a Webex meeting AND spawns a WxCC agent task in one
// shot, so it burns both bot-token quota and live-agent capacity. Strict per-IP
// limit plus a global cap as a circuit breaker against distributed floods.
// Counters are in memory (reset on restart; fine with max-instances 1).
const startSessionPerIpLimit = rateLimit({
    windowMs: 60_000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: onLimit('start-session per-ip'),
});
const startSessionGlobalLimit = rateLimit({
    windowMs: 60 * 60_000,
    limit: 60,
    keyGenerator: () => 'global',
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: onLimit('start-session global'),
});

// Per-region WxCC routing config. The token differs per WxCC org, so each
// region carries its own token and routing-api host. Select via the `region`
// field in the /api/start-session request body.
const ROUTING_REGIONS = {
    us: {
        url: 'https://routing-api.produs1.ciscoccservice.com/v2/tasks',
        token: process.env.TASK_ROUTING_TOKEN_US,
    },
    emea: {
        url: 'https://routing-api.prodeu1.ciscoccservice.com/v2/tasks',
        token: process.env.TASK_ROUTING_TOKEN_EMEA,
    },
};
// OAuth refresh for the routing tokens. WxCC access tokens expire (~14 days) but
// come with a refresh token. Each region (tenant) has its own service app, so
// client id/secret and refresh token are all per region. If those three are set
// for a region, its access token is renewed automatically: proactively
// shortly before expiry, and reactively on a 401 from the Routing API. Without
// them, the static TASK_ROUTING_TOKEN_* is used as-is (previous behaviour).
const WEBEX_TOKEN_URL = process.env.WEBEX_TOKEN_URL || 'https://webexapis.com/v1/access_token';
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // renew 5 min before expiry

ROUTING_REGIONS.us.clientId = process.env.WEBEX_CLIENT_ID_US;
ROUTING_REGIONS.us.clientSecret = process.env.WEBEX_CLIENT_SECRET_US;
ROUTING_REGIONS.us.refreshToken = process.env.TASK_ROUTING_REFRESH_TOKEN_US;
ROUTING_REGIONS.emea.clientId = process.env.WEBEX_CLIENT_ID_EMEA;
ROUTING_REGIONS.emea.clientSecret = process.env.WEBEX_CLIENT_SECRET_EMEA;
ROUTING_REGIONS.emea.refreshToken = process.env.TASK_ROUTING_REFRESH_TOKEN_EMEA;
for (const r of Object.values(ROUTING_REGIONS)) {
    r.expiresAt = Infinity;   // unknown expiry for the env token; the 401 retry covers it
    r.refreshing = null;      // in-flight refresh promise (dedupes concurrent requests)
}

const canRefresh = (r) => Boolean(r.clientId && r.clientSecret && r.refreshToken);

// Persistence of the latest tokens in Google Secret Manager (optional). Cloud Run
// can restart or scale to zero at any time and a refresh may rotate the refresh
// token, so the newest values are saved after every refresh and loaded at
// startup. Enabled only when SECRETS_PROJECT is set (not needed for local dev).
// One secret per region, named ic-work-items-routing-tokens-<region> (e.g. ic-work-items-routing-tokens-us),
// created beforehand; each refresh adds a new version.
const SECRETS_PROJECT = process.env.SECRETS_PROJECT;
const secretPath = (name) => `projects/${SECRETS_PROJECT}/secrets/ic-work-items-routing-tokens-${name}`;
let secretClient = null;
async function getSecretClient() {
    if (!secretClient) {
        const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
        secretClient = new SecretManagerServiceClient();
    }
    return secretClient;
}

// The env refresh token the region started from. If it differs from the one
// stored with the saved tokens, you re-authorized by hand: the env value wins.
for (const r of Object.values(ROUTING_REGIONS)) r.seedRefreshToken = r.refreshToken ?? '';

async function loadStoredTokens(name, r) {
    if (!SECRETS_PROJECT) return;
    try {
        const client = await getSecretClient();
        const [version] = await client.accessSecretVersion({ name: `${secretPath(name)}/versions/latest` });
        const stored = JSON.parse(version.payload.data.toString('utf8'));
        if (stored.seedRefreshToken !== r.seedRefreshToken) {
            console.warn(`[Backend] Region "${name}": env refresh token differs from the stored one, ignoring stored tokens`);
            return;
        }
        r.refreshToken = stored.refreshToken;
        r.token = stored.accessToken;
        r.expiresAt = stored.expiresAt ?? 0;
        console.log(`[Backend] Region "${name}": loaded stored tokens from Secret Manager`);
    } catch (err) {
        if (err.code === 5) { // NOT_FOUND: secret empty or no versions yet
            console.log(`[Backend] Region "${name}": no stored tokens yet, using env values`);
        } else {
            console.error(`[Backend] ERROR region "${name}": could not load stored tokens, using env values:`, err.message);
        }
    }
}

async function persistTokens(name, r) {
    const client = await getSecretClient();
    await client.addSecretVersion({
        parent: secretPath(name),
        payload: {
            data: Buffer.from(JSON.stringify({
                accessToken: r.token,
                refreshToken: r.refreshToken,
                expiresAt: r.expiresAt,
                seedRefreshToken: r.seedRefreshToken,
            })),
        },
    });
    console.log(`[Backend] Region "${name}": tokens saved to Secret Manager`);
}

async function refreshRoutingToken(name, r) {
    console.log(`[Backend] Refreshing routing access token for region "${name}"`);
    const response = await fetch(WEBEX_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: r.clientId,
            client_secret: r.clientSecret,
            refresh_token: r.refreshToken,
        }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
        throw new Error(`Token refresh failed for region "${name}" (${response.status}): ${data.message || data.error_description || data.error || 'unknown error'}`);
    }
    r.token = data.access_token;
    r.expiresAt = Date.now() + (data.expires_in ?? 0) * 1000;
    if (data.refresh_token && data.refresh_token !== r.refreshToken) {
        r.refreshToken = data.refresh_token;
        console.warn(SECRETS_PROJECT
            ? `[Backend] Region "${name}": a new refresh token was issued and will be saved to Secret Manager.`
            : `[Backend] Region "${name}": a new refresh token was issued. It is only kept in memory; update TASK_ROUTING_REFRESH_TOKEN_${name.toUpperCase()} before the next restart.`);
    }
    console.log(`[Backend] Region "${name}": access token renewed, valid for ${data.expires_in}s`);
    return r.token;
}

// Refresh, then save the result. A failed save does not fail the request that
// triggered it (the in-memory token is still good), but it is logged as an ERROR
// and flagged so the scheduled endpoint can report it.
async function refreshAndPersist(name, r) {
    await refreshRoutingToken(name, r);
    r.persistOk = true;
    if (SECRETS_PROJECT) {
        try {
            await persistTokens(name, r);
        } catch (err) {
            r.persistOk = false;
            console.error(`[Backend] ERROR region "${name}": could not save tokens to Secret Manager:`, err.message);
        }
    }
    return r.token;
}

// Returns a usable access token for the region, refreshing if needed.
async function getRoutingToken(name, r, { force = false } = {}) {
    if (!canRefresh(r)) return r.token;
    if (force || !r.token || Date.now() >= r.expiresAt - REFRESH_MARGIN_MS) {
        r.refreshing ??= refreshAndPersist(name, r).finally(() => { r.refreshing = null; });
        return r.refreshing;
    }
    return r.token;
}

for (const [name, r] of Object.entries(ROUTING_REGIONS)) await loadStoredTokens(name, r);

// Per region: 'set' (static access token), 'will refresh on first request'
// (no access token but refresh credentials present), or 'MISSING' (neither).
const tokenStatus = (r) => r.token ? 'set' : canRefresh(r) ? 'will refresh on first request' : 'MISSING';
console.log('[Backend]: Task Routing tokens:', {
    us: tokenStatus(ROUTING_REGIONS.us),
    emea: tokenStatus(ROUTING_REGIONS.emea),
});
console.log('[Backend]: Task Routing token auto-refresh:', {
    us: canRefresh(ROUTING_REGIONS.us) ? 'enabled' : 'disabled',
    emea: canRefresh(ROUTING_REGIONS.emea) ? 'enabled' : 'disabled',
});

const INSTANT_CONNECT_URL = "https://mtg-broker-a.wbx2.com/api/v2/joseencrypt";
const INSTANT_CONNECT_AUD = "a4d886b0-979f-4e2c-a958-3e8c14605e51";

// Parse an upstream response as JSON without throwing on HTML/empty bodies
// (gateways return HTML error pages for bad credentials or blocked requests).
async function readJson(response, label) {
    const text = await response.text();
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        console.error(`[Backend] ${label} returned non-JSON (status ${response.status}):`, text.slice(0, 200));
        return { error: `Non-JSON response from ${label}`, status: response.status };
    }
}

// Single browser-facing endpoint: create the Instant Connect meeting AND
// request the agent server-side, so the privileged host link is never exposed
// to the client. The browser receives only the guest link.
app.post('/api/start-session', startSessionPerIpLimit, startSessionGlobalLimit, async (req, res) => {
    const { name, email, verticalType, destinationId, channel, region, uri } = req.body;

    // Validate required fields
    const requiredFields = { name, email, verticalType, destinationId, channel, region };
    for (const [field, value] of Object.entries(requiredFields)) {
        if (value === undefined || value === null || value === '') {
            console.error(`[Backend] /api/start-session - missing "${field}" in request body`);
            return res.status(400).json({ error: `Missing required body field: ${field}` });
        }
    }

    const botToken = process.env.BOT_TOKEN_G2G;
    if (!botToken) {
        console.error('[Backend] /api/start-session - missing "BOT_TOKEN_G2G" in environment variables');
        return res.status(500).json({ error: 'Missing required environment variable: BOT_TOKEN_G2G' });
    }

    const routing = ROUTING_REGIONS[region];
    if (!routing) {
        console.error(`[Backend] /api/start-session - unknown region "${region}"`);
        return res.status(400).json({ error: `Invalid region: ${region}. Expected one of: ${Object.keys(ROUTING_REGIONS).join(', ')}` });
    }
    if (!routing.token && !canRefresh(routing)) {
        console.error(`[Backend] /api/start-session - missing token for region "${region}"`);
        return res.status(500).json({ error: `Missing routing token for region: ${region}` });
    }

    try {
        // 1. Create the Instant Connect meeting (host + guest links)
        const now = new Date().toISOString();
        console.log(`[Backend] /api/start-session - creating meeting, jwt.sub: "Instant Connect ${now}"`);

        const meetingResponse = await fetch(INSTANT_CONNECT_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${botToken}`,
            },
            body: JSON.stringify({
                "jwt": {
                    "sub": `Instant Connect ${now}`,
                    ...(uri && {
                        "flow": {
                            "id": "sip-no-knock",
                            "data": [
                                { "uri": uri }
                            ]
                        }
                    })
                },
                "aud": INSTANT_CONNECT_AUD,
                provideShortUrls: true,
                verticalType,
                "loginUrlForHost": false
            }),
        });

        const meetingData = await readJson(meetingResponse, 'Instant Connect API');
        if (!meetingResponse.ok) {
            console.error(`[Backend] /api/start-session - Instant Connect API error ${meetingResponse.status}:`, meetingData);
            return res.status(meetingResponse.status).json({ error: 'Instant Connect Meeting Links API error', details: meetingData });
        }

        const hostUrl = meetingData.baseUrl + meetingData.host[0].short;
        const guestUrl = meetingData.baseUrl + meetingData.guest[0].short;
        console.log(`[Backend] /api/start-session - links created. Host URL: ${hostUrl}, Guest URL: ${guestUrl}`);

        // 2. Request an agent via WxCC Task Routing. The host link is sent to the
        //    agent as work-item data and never leaves the server.
        const originId = randomUUID();
        console.log('[Backend] /api/start-session - requesting agent:', { name, email, destinationId, channel, region, originId });

        const taskBody = JSON.stringify({
            origin: { id: originId, name },
            destination: { id: destinationId, type: 'businessAddress' },
            channelType: 'workItem',
            channel,
            channelParams: {
                type: 'work-item-form',
                message: {
                    aliasId: 'form-001',
                    workItemData: { name, email, hostUrl },
                    timestamp: Date.now()
                }
            }
        });
        const postTask = (token) => fetch(routing.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: taskBody,
        });

        let routingResponse = await postTask(await getRoutingToken(region, routing));
        if (routingResponse.status === 401 && canRefresh(routing)) {
            console.warn(`[Backend] /api/start-session - Routing API returned 401, refreshing token and retrying once`);
            routingResponse = await postTask(await getRoutingToken(region, routing, { force: true }));
        }

        const routingData = await readJson(routingResponse, 'Routing API');
        if (!routingResponse.ok) {
            console.error(`[Backend] /api/start-session - Routing API error ${routingResponse.status}:`, routingData);
            return res.status(routingResponse.status).json({ error: 'Routing API error', details: routingData });
        }

        console.log(`[Backend] /api/start-session - task created (originId=${originId})`, routingData);

        // Only the guest link leaves the server.
        res.json({ guestUrl, originId });
    } catch (err) {
        console.error('[Backend] /api/start-session - unexpected error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Called by Cloud Scheduler (every 3 days) to renew the routing tokens even when
// the service is idle, so the refresh token never lapses. Cloud Run is deployed
// without IAM invoker checks, so the caller is authenticated here with a shared
// secret in the X-Cron-Secret header (CRON_SECRET env var).
const refreshTokensLimit = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: onLimit('refresh-tokens'),
});
app.post('/internal/refresh-tokens', refreshTokensLimit, async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
        console.error('[Backend] /internal/refresh-tokens - CRON_SECRET not set, endpoint disabled');
        return res.status(503).json({ error: 'Endpoint disabled' });
    }
    const given = Buffer.from(req.get('x-cron-secret') ?? '');
    const expected = Buffer.from(secret);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        console.warn(`[Backend] /internal/refresh-tokens - bad or missing secret, ip=${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const results = {};
    let ok = true;
    for (const [name, r] of Object.entries(ROUTING_REGIONS)) {
        if (!canRefresh(r)) {
            results[name] = 'skipped (refresh not configured)';
            continue;
        }
        try {
            await getRoutingToken(name, r, { force: true });
            if (r.persistOk) {
                results[name] = 'ok';
            } else {
                results[name] = 'refreshed but NOT saved';
                ok = false;
            }
        } catch (err) {
            console.error(`[Backend] ERROR scheduled token refresh failed for region "${name}":`, err.message);
            results[name] = 'failed';
            ok = false;
        }
    }
    console.log('[Backend] /internal/refresh-tokens - result:', results);
    res.status(ok ? 200 : 500).json(results);
});

// Health check endpoint - used to verify the server is running
app.get('/api/health', (_req, res) => {
    console.log("[Backend] Health Check endpoint hit");
    res.json({ status: 'OK', node: process.version });
});

app.listen(port, () => {
    console.log(`Server is running on port ${port} (Node ${process.version})`);
});
