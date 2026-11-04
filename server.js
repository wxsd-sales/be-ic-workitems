import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { randomUUID } from 'node:crypto'
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
console.log('[Backend]: Task Routing tokens loaded:', {
    us: ROUTING_REGIONS.us.token ? 'set' : 'MISSING',
    emea: ROUTING_REGIONS.emea.token ? 'set' : 'MISSING',
});

const INSTANT_CONNECT_URL = "https://mtg-broker-a.wbx2.com/api/v2/joseencrypt";
const INSTANT_CONNECT_AUD = "a4d886b0-979f-4e2c-a958-3e8c14605e51";

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
    if (!routing.token) {
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

        const meetingData = await meetingResponse.json();
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

        const routingResponse = await fetch(routing.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${routing.token}`
            },
            body: JSON.stringify({
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
            })
        });

        const routingData = await routingResponse.json();
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

// Health check endpoint - used to verify the server is running
app.get('/api/health', (_req, res) => {
    console.log("[Backend] Health Check endpoint hit");
    res.json({ status: 'OK', node: process.version });
});

app.listen(port, () => {
    console.log(`Server is running on port ${port} (Node ${process.version})`);
});
