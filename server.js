import express from 'express'
import cors from 'cors'
import { randomUUID } from 'node:crypto'
if (process.env.NODE_ENV !== 'production') {
    await import('dotenv/config');
}

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS for all routes. Change in production
app.use(cors());
// Parse JSON bodies
app.use(express.json());

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
app.post('/api/start-session', async (req, res) => {
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
    res.json({ status: 'OK' });
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
