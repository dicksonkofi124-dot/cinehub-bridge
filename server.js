/**
 * CineHub Telegram Bridge Server
 * Streams movie files directly from Telegram Saved Messages.
 * No file size limit — uses full MTProto client.
 */

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
const MOVIES = {
    'the-boys-s5e8' : 422,
    'the-rip-2026'  : 420,
    // Add more here as you upload:
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

// Keep-alive ping endpoint
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

// Stream/download endpoint
app.get('/download/:key', async (req, res) => {
    const key = req.params.key;
    const messageId = MOVIES[key];

    if (!messageId) {
        return res.status(404).json({ ok: false, error: `Movie "${key}" not found.` });
    }

    try {
        const tg = await getClient();

        // Fetch message from Saved Messages
        const result = await tg.invoke(new Api.messages.GetMessages({
            id: [new Api.InputMessageID({ id: messageId })],
        }));

        const msg = result.messages?.[0];
        if (!msg?.media?.document) {
            return res.status(404).json({ ok: false, error: 'File not found in Saved Messages.' });
        }

        const doc      = msg.media.document;
        const nameAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeFilename');
        const fileName = nameAttr?.fileName || `${key}.mkv`;
        const mimeType = doc.mimeType || 'application/octet-stream';
        const fileSize = Number(doc.size);

        console.log(`[Stream] ${fileName} — ${(fileSize / 1024 / 1024).toFixed(1)} MB`);

        // Set headers
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Length', fileSize);
        res.setHeader('Accept-Ranges', 'none');
        res.status(200);

        // Stream in chunks — no BigInt offset to avoid .mod() bug
        const iter = tg.iterDownload({
            file: new Api.InputDocumentFileLocation({
                id            : doc.id,
                accessHash    : doc.accessHash,
                fileReference : doc.fileReference,
                thumbSize     : '',
            }),
            requestSize: 512 * 1024, // 512KB chunks
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
});

// Start server
app.listen(PORT, async () => {
    console.log(`CineHub Bridge running on port ${PORT}`);
    if (SESSION_STR) {
        try { await getClient(); }
        catch (e) { console.error('[Startup Error]', e.message); }
    } else {
        console.warn('[Warning] No TELEGRAM_SESSION set!');
    }
});
