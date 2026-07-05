import express from 'express'
import cors from 'cors'
if (process.env.NODE_ENV !== 'production') {
    await import('dotenv/config');
}

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS for all routes. Change in production
app.use(cors());
// Parse JSON bodies
app.use(express.json());

// Create Instant Connect Meeting Links
app.post('/api/create-meeting', async (req, res) => {
    const { verticalType, uri } = req.body;

    if (!verticalType) {
        console.error('[Backend] /api/create-meeting - missing "verticalType" in request body');
        return res.status(400).json({ error: 'Missing required body field: verticalType' });
    }

    // get the bot token from the environment variables
    const botToken = process.env.BOT_TOKEN_G2G;
    if (!botToken) {
        console.error('[Backend] /api/create-meeting - missing "BOT_TOKEN_G2G" in environment variables');
        return res.status(500).json({ error: 'Missing required environment variable: BOT_TOKEN_G2G' });
    }
    console.log("[Backend] /api/create-meeting - creating Instant Connect meeting links");
    const now = new Date().toISOString();
    console.log(`[Backend] /api/create-meeting - jwt.sub will be: "Instant Connect ${now}"`);
    try {
        const response = await fetch("https://mtg-broker-a.wbx2.com/api/v2/joseencrypt", {
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
                "aud": "a4d886b0-979f-4e2c-a958-3e8c14605e51",
                provideShortUrls: true,
                verticalType
            }),
        });

        const data = await response.json();

        if (!response.ok) {
            console.error(`[Backend] /api/create-meeting - Instant Connect Meeting Links API error ${response.status}:`, data);
            return res.status(response.status).json({ error: 'Instant Connect Meeting Links API error', details: data });
        }
        // console.log('[Backend] ', data);
        const hostUrl = data.baseUrl + data.host[0].short;
        const guestUrl = data.baseUrl + data.guest[0].short;
        console.log(`[Backend] /api/create-meeting - Instant Connect Meeting Links created successfully. Host URL: ${hostUrl}, Guest URL: ${guestUrl}`);
        res.json(data); // Sending back entire API reponse, we could sned only host and guest URLs
    } catch (err) {
        console.error('[Backend] /api/create-meeting - unexpected error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Request video agent using WxCC Task Routing API  
app.post('/api/request-video-agent', async (req, res) => {
    // const { name, email, phone, package: pkg, elvisStyle, date, guests, requests, destinationId, channel } = req.body;
    const { name, email, destinationId, channel, hostUrl, region } = req.body;

    const requiredFields = { name, email, destinationId, channel, region };
    for (const [field, value] of Object.entries(requiredFields)) {
        if (value === undefined || value === null || value === '') {
            console.error(`[Backend] /api/request-video-agent - missing "${field}" in request body`);
            return res.status(400).json({ error: `Missing required body field: ${field}` });
        }
    }

    const routing = ROUTING_REGIONS[region];
    if (!routing) {
        console.error(`[Backend] /api/request-video-agent - unknown region "${region}"`);
        return res.status(400).json({ error: `Invalid region: ${region}. Expected one of: ${Object.keys(ROUTING_REGIONS).join(', ')}` });
    }
    if (!routing.token) {
        console.error(`[Backend] /api/request-video-agent - missing token for region "${region}"`);
        return res.status(500).json({ error: `Missing routing token for region: ${region}` });
    }

    console.log('[Backend] /api/request-video-agent - requesting video agent with:', {
        name,
        email,
        destinationId,
        channel,
        hostUrl,
        region
    });

    const originId = randomUUID();

    try {
        const response = await fetch(routing.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${routing.token}`
            },
            body: JSON.stringify({
                origin: {
                    id: originId,
                    name: name
                },
                destination: {
                    id: destinationId,
                    type: 'businessAddress'
                },
                channelType: 'workItem',
                channel,
                channelParams: {
                    type: 'work-item-form',
                    message: {
                        aliasId: 'form-001',
                        "workItemData": {
                            name,
                            email,
                            hostUrl
                        },
                        timestamp: Date.now()
                    }
                }
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error(`[Backend] /api/request-video-agent - Routing API error ${response.status}:`, data);
            return res.status(response.status).json({ error: 'Routing API error', details: data });
        }

        console.log(`[Backend] /api/request-video-agent - task created successfully (originId=${originId})`, data);
        res.json({ ...data, originId });
    } catch (err) {
        console.error('[Backend] /api/request-video-agent - unexpected error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check endpoint - used to verify the server is running
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK' });
      console.log("[Backend] Health Check endpoint hit");
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});


