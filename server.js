const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const API_ID      = parseInt(process.env.TELEGRAM_API_ID || '30876082');
const API_HASH    = process.env.TELEGRAM_API_HASH || '5c98a0330c3ee4c0b337fece870cd953';
const SESSION_STR = process.env.TELEGRAM_SESSION || '';
const PORT        = parseInt(process.env.PORT || '3000');

// Movie registry — message ID in Saved Messages
// To add a new movie: upload via TDrive, get ID from generate-session.js, add here
const MOVIES = {
    'the-boys-s5e8' : 422,
    'the-rip-2026'  : 420,
    'in-the-grey'       : 478,
    'gran-turismo-2023'  : 479,
    'off-campus-s1e1'    : 2,     // Channel: 3506869277
    // Add more below as you upload them:
    // 'movie-key': MESSAGE_ID,
};

let client = null;

async function getClient() {
    if (client && client.connected) return client;
    console.log('[Telegram] Connecting...');
    client = new TelegramClient(new StringSession(SESSION_STR), API_ID, API_HASH, {
        connectionRetries: 5,
        retryDelay: 1000,
        autoReconnect: true,
    });
    await client.connect();
    console.log('[Telegram] Connected ✓');
    return client;
}

// Health check
app.get('/', (req, res) => {
    res.json({
        status : 'CineHub Bridge OK ✓',
        movies : Object.keys(MOVIES).length,
        uptime : Math.floor(process.uptime()) + 's',
    });
});

// Keep-alive ping
app.get('/ping', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
});

// List movies
app.get('/movies', (req, res) => {
    res.json({
        ok: true,
        movies: Object.keys(MOVIES).map(key => ({
            key,
            url: `/download/${key}`,
        })),
    });
});

// Stream/download endpoint - supports:
// /download/movie-key (from MOVIES registry)
// /download/home/MESSAGE_ID (TDrive Saved Messages format)
// /download/CHANNEL_ID/MESSAGE_ID (TDrive folder/channel format)
app.get('/download/:key', async (req, res) => {
    const key = req.params.key;
    let messageId = MOVIES[key];
    let channelId = null;

    // Check if this is a numeric channel ID (TDrive folder format)
    if (!messageId && /^\d+$/.test(key)) {
        channelId = key;
        return res.status(400).json({ ok: false, error: 'Use /download/CHANNEL_ID/MESSAGE_ID format' });
    }

    if (!messageId) {
        return res.status(404).json({ ok: false, error: `Movie "${key}" not found. Add it to MOVIES registry in server.js` });
    }

    try {
        const tg = await getClient();

        let result;
        if (channelId) {
            // Get from channel (TDrive folder)
            try {
                const channel = await tg.getEntity(BigInt(channelId));
                result = await tg.invoke(new Api.channels.GetMessages({
                    channel: channel,
                    id: [new Api.InputMessageID({ id: messageId })],
                }));
            } catch(e) {
                // Fallback to GetMessages without entity
                result = await tg.invoke(new Api.messages.GetMessages({
                    id: [new Api.InputMessageID({ id: messageId })],
                }));
            }
        } else {
            // Get from Saved Messages
            result = await tg.invoke(new Api.messages.GetMessages({
                id: [new Api.InputMessageID({ id: messageId })],
            }));
        }

        const msg = result.messages?.[0];
        if (!msg?.media?.document) {
            return res.status(404).json({ ok: false, error: 'File not found.' });
        }

        const doc      = msg.media.document;
        const nameAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeFilename');
        const fileName = nameAttr?.fileName || `file_${messageId}.mkv`;
        const mimeType = doc.mimeType || 'application/octet-stream';
        const fileSize = Number(doc.size);

        console.log(`[Stream] ${fileName} — ${(fileSize / 1024 / 1024).toFixed(1)} MB`);

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Length', fileSize);
        res.setHeader('Accept-Ranges', 'none');
        res.status(200);

        const iter = tg.iterDownload({
            file: new Api.InputDocumentFileLocation({
                id            : doc.id,
                accessHash    : doc.accessHash,
                fileReference : doc.fileReference,
                thumbSize     : '',
            }),
            requestSize: 512 * 1024,
        });

        for await (const chunk of iter) {
            if (res.destroyed) break;
            res.write(chunk);
        }

        res.end();
        console.log(`[Done] ${fileName}`);

    } catch (err) {
        console.error('[Error]', err.message);
        if (!res.headersSent) {
            res.status(500).json({ ok: false, error: err.message });
        }
    }
}


// TDrive format: /download/home/MESSAGE_ID (Saved Messages)
app.get('/download/home/:messageId', async (req, res) => {
    const messageId = parseInt(req.params.messageId);
    if (isNaN(messageId)) return res.status(400).json({ ok: false, error: 'Invalid message ID' });
    await streamFile(req, res, messageId, null);
});

// TDrive format: /download/CHANNEL_ID/MESSAGE_ID (folder channels)
app.get('/download/:channelId/:messageId', async (req, res) => {
    const channelId = req.params.channelId;
    const messageId = parseInt(req.params.messageId);
    if (isNaN(messageId)) return res.status(400).json({ ok: false, error: 'Invalid message ID' });
    // For Saved Messages, channelId is 'home' or null
    if (channelId === 'home') {
        await streamFile(req, res, messageId, null);
    } else {
        await streamFile(req, res, messageId, channelId);
    }
});

async function streamFile(req, res, messageId, channelId) {

app.listen(PORT, async () => {
    console.log(`CineHub Bridge running on port ${PORT}`);
    if (SESSION_STR) {
        try { await getClient(); }
        catch (e) { console.error('[Startup Error]', e.message); }
    } else {
        console.warn('[Warning] No TELEGRAM_SESSION set!');
    }
});