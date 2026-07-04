/**
 * CineHub Telegram Bridge Server
 * Streams movie/series/animation files from Telegram Saved Messages or
 * TDrive [TD]-tagged channels.
 *
 * Storage convention:
 *   - Saved Messages → single movies
 *   - [TD] channels   → series & animation (one channel per show, episodes as separate messages)
 *
 * Supported URL patterns:
 *   /download/:key                — registry key lookup (movies-data.js references these)
 *   /download/home/:messageId     — direct Saved Messages stream
 *   /download/:channelId/:msgId   — direct channel stream
 *   /channels                     — list all [TD]-tagged channels
 *   /channel/:channelId           — list files inside a specific channel
 *   /ping                         — keep-alive (pinged by cron-job.org every 10 min)
 */

const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const { Api }            = require('telegram');
const express            = require('express');
const cors               = require('cors');

const app = express();
app.use(cors());

const API_ID      = parseInt(process.env.TELEGRAM_API_ID  || '0');
const API_HASH    = process.env.TELEGRAM_API_HASH          || '';
const SESSION_STR = process.env.TELEGRAM_SESSION           || '';
const PORT        = parseInt(process.env.PORT              || '3000');

if (!API_ID || !API_HASH) {
    console.error('[FATAL] TELEGRAM_API_ID and TELEGRAM_API_HASH must be set as environment variables on Render.');
    console.error('[FATAL] Dashboard → cinehub-bridge → Environment → add both values.');
}

// ── MOVIES / EPISODES REGISTRY ────────────────────────────────────────────────
// Two supported formats per key:
//   'key': MESSAGE_ID                              → Saved Messages (single movies)
//   'key': { messageId: ID, channelId: 'CHAN_ID' }  → a [TD] channel (series/animation episodes)
//
// The admin panel updates this file automatically when you add content,
// and correctly writes the object format whenever a channel is involved.
const MOVIES = {
    'the-boys-s5e8'     : 422,
    'the-rip-2026'      : 420,
    'in-the-grey'       : 478,
    'gran-turismo-2023' : 479,
    'off-campus-s1e1'   : { messageId: 2, channelId: '3506869277' },
    // Add more here — or let the admin panel do it automatically:
    // 'movie-key': MESSAGE_ID,                              // Saved Messages
    // 'show-key' : { messageId: ID, channelId: 'CHANNEL_ID' }, // [TD] channel
};

// ── TELEGRAM CLIENT ───────────────────────────────────────────────────────────
let client = null;

async function getClient() {
    if (client && client.connected) return client;
    console.log('[Telegram] Connecting...');
    client = new TelegramClient(new StringSession(SESSION_STR), API_ID, API_HASH, {
        connectionRetries: 5,
        retryDelay       : 1000,
        autoReconnect    : true,
    });
    await client.connect();
    console.log('[Telegram] Connected ✓');
    return client;
}

// ── RESOLVE MOVIES[key] INTO {messageId, channelId} ───────────────────────────
function resolveEntry(movieEntry) {
    if (movieEntry === undefined || movieEntry === null) return null;
    if (typeof movieEntry === 'object') {
        return {
            messageId: movieEntry.messageId,
            channelId: movieEntry.channelId || null,
        };
    }
    return { messageId: movieEntry, channelId: null };
}

// ── RESOLVE A CHANNEL ID INTO AN ENTITY ───────────────────────────────────────
// GramJS (like Telethon) can only turn a bare numeric ID into a usable entity
// if it already has that peer cached with its access hash. If the client
// hasn't personally "seen" this channel yet in the current session, it can't
// tell a channel ID from a user ID and throws exactly the PeerUser error this
// bridge was hitting on every request. Calling getDialogs() forces GramJS to
// fetch and cache every peer the account has, including this channel — after
// that, getEntity() works. This only works if the account is actually a
// member of the channel; if it still fails after this, the account needs to
// (re)join that channel/group on Telegram.
const resolvedChannelCache = new Set();

async function resolveChannel(tg, channelId) {
    try {
        return await tg.getEntity(BigInt(channelId));
    } catch (err) {
        if (resolvedChannelCache.has(channelId)) throw err; // already retried once, don't loop forever
        console.warn(`[Telegram] Entity cache miss for channel ${channelId} — refreshing dialogs and retrying...`);
        await tg.getDialogs({ limit: 300 });
        resolvedChannelCache.add(channelId);
        return await tg.getEntity(BigInt(channelId));
    }
}

// ── SHARED: FETCH A MESSAGE'S DOCUMENT (no streaming) ─────────────────────────
// Used by both the size-lookup endpoint and the actual stream endpoint, so
// there's only one place that talks to Telegram for "what is this file".
async function fetchDocument(tg, messageId, channelId) {
    let result;
    if (channelId) {
        const channel = await resolveChannel(tg, channelId);
        result = await tg.invoke(new Api.channels.GetMessages({
            channel : channel,
            id      : [new Api.InputMessageID({ id: messageId })],
        }));
    } else {
        result = await tg.invoke(new Api.messages.GetMessages({
            id: [new Api.InputMessageID({ id: messageId })],
        }));
    }

    const msg = result.messages?.[0];
    if (!msg?.media?.document) return null;

    const doc      = msg.media.document;
    const nameAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeFilename');
    const fileName = nameAttr?.fileName || `file_${messageId}.mkv`;
    const mimeType = doc.mimeType || 'application/octet-stream';
    const fileSize = Number(doc.size);

    return { doc, fileName, mimeType, fileSize };
}

function humanSize(bytes) {
    if (!bytes || isNaN(bytes)) return null;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// ── SHARED STREAM FUNCTION ───────────────────────────────────────────────────
// channelId = null   → stream from Saved Messages
// channelId = string → stream from a [TD] channel
async function streamFile(req, res, messageId, channelId) {
    try {
        const tg = await getClient();
        const info = await fetchDocument(tg, messageId, channelId);

        if (!info) {
            return res.status(404).json({
                ok: false,
                error: channelId
                    ? `File not found in channel ${channelId} (message ${messageId}).`
                    : `File not found in Saved Messages (message ${messageId}).`,
            });
        }

        const { doc, fileName, mimeType, fileSize } = info;

        console.log(`[Stream] ${fileName} — ${(fileSize / 1024 / 1024).toFixed(1)} MB${channelId ? ` (channel ${channelId})` : ' (Saved Messages)'}`);

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

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
    res.json({
        status : 'CineHub Bridge OK ✓',
        movies : Object.keys(MOVIES).length,
        uptime : Math.floor(process.uptime()) + 's',
    });
});

// Keep-alive ping (called by cron-job.org every 10 min)
app.get('/ping', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
});

// List all registered movies/episodes
app.get('/movies', (req, res) => {
    res.json({
        ok    : true,
        count : Object.keys(MOVIES).length,
        movies: Object.keys(MOVIES).map(key => {
            const entry = resolveEntry(MOVIES[key]);
            return {
                key,
                url      : `/download/${key}`,
                location : entry.channelId ? `channel ${entry.channelId}` : 'Saved Messages',
            };
        }),
    });
});

// List all [TD]-tagged channels (series/animation folders)
app.get('/channels', async (req, res) => {
    try {
        const tg = await getClient();
        const dialogs = await tg.getDialogs({});

        const tdChannels = dialogs
            .filter(d => d.title?.includes('[TD]') || d.className === 'Channel')
            .map(d => ({
                id   : d.id.toString(),
                title: d.title,
                url  : `/channel/${d.id}`,
            }));

        res.json({ ok: true, count: tdChannels.length, channels: tdChannels });
    } catch (err) {
        console.error('[Error]', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// List files inside a specific [TD] channel — useful for finding message IDs
// of episodes when adding them to the registry via the admin panel.
app.get('/channel/:channelId', async (req, res) => {
    const channelId = req.params.channelId;
    const limit = parseInt(req.query.limit) || 50;

    try {
        const tg = await getClient();
        const channel = await resolveChannel(tg, channelId);
        const messages = await tg.getMessages(channel, { limit });

        const files = messages
            .filter(m => m.media?.document)
            .map(msg => {
                const attr = msg.media.document.attributes?.find(a => a.className === 'DocumentAttributeFilename');
                const name = attr?.fileName || `file_${msg.id}`;
                const size = (Number(msg.media.document.size) / 1024 / 1024).toFixed(1);
                return {
                    id  : msg.id,
                    name,
                    size: `${size} MB`,
                    url : `/download/${channelId}/${msg.id}`,
                };
            });

        res.json({ ok: true, channel: channel.title || channelId, count: files.length, files });
    } catch (err) {
        console.error('[Error]', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ── FILE SIZE LOOKUP (no streaming — just reads the message's metadata) ──────
// Used by the admin panel to auto-fill file size when you add a link.
async function sendSize(req, res, messageId, channelId) {
    try {
        const tg = await getClient();
        const info = await fetchDocument(tg, messageId, channelId);
        if (!info) {
            return res.status(404).json({ ok: false, error: 'File not found for that message ID.' });
        }
        return res.json({
            ok       : true,
            fileName : info.fileName,
            bytes    : info.fileSize,
            size     : humanSize(info.fileSize),
        });
    } catch (err) {
        console.error('[Error]', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
}

app.get('/filesize/:key', async (req, res) => {
    const key = req.params.key;
    const entry = resolveEntry(MOVIES[key]);
    if (entry) return sendSize(req, res, entry.messageId, entry.channelId);
    if (/^\d+$/.test(key)) return sendSize(req, res, parseInt(key, 10), null);
    return res.status(404).json({ ok: false, error: `"${key}" not found in registry.` });
});

app.get('/filesize/home/:messageId', async (req, res) => {
    const messageId = parseInt(req.params.messageId);
    if (isNaN(messageId)) return res.status(400).json({ ok: false, error: 'Invalid message ID' });
    await sendSize(req, res, messageId, null);
});

app.get('/filesize/:channelId/:messageId', async (req, res) => {
    const channelId = req.params.channelId;
    const messageId = parseInt(req.params.messageId);
    if (isNaN(messageId)) return res.status(400).json({ ok: false, error: 'Invalid message ID' });
    await sendSize(req, res, messageId, channelId === 'home' ? null : channelId);
});

// Registry key lookup — supports both Saved Messages (number) and
// channel entries (object), plus a fallback for bare numeric Saved-Message IDs.
app.get('/download/:key', async (req, res) => {
    const key = req.params.key;
    const entry = resolveEntry(MOVIES[key]);

    if (entry) {
        return streamFile(req, res, entry.messageId, entry.channelId);
    }

    // Fallback: bare numeric key not in registry → treat as a direct
    // Saved Messages ID (covers links like /download/479).
    if (/^\d+$/.test(key)) {
        return streamFile(req, res, parseInt(key, 10), null);
    }

    return res.status(404).json({
        ok    : false,
        error : `"${key}" not found. Add it to the MOVIES registry in server.js, or use /download/CHANNEL_ID/MESSAGE_ID directly.`,
    });
});

// Direct Saved Messages format: /download/home/MESSAGE_ID
app.get('/download/home/:messageId', async (req, res) => {
    const messageId = parseInt(req.params.messageId);
    if (isNaN(messageId)) {
        return res.status(400).json({ ok: false, error: 'Invalid message ID' });
    }
    await streamFile(req, res, messageId, null);
});

// Direct channel format: /download/CHANNEL_ID/MESSAGE_ID
// (Registered LAST so it never shadows /download/:key or /download/home/:id)
app.get('/download/:channelId/:messageId', async (req, res) => {
    const channelId = req.params.channelId;
    const messageId = parseInt(req.params.messageId);
    if (isNaN(messageId)) {
        return res.status(400).json({ ok: false, error: 'Invalid message ID' });
    }
    await streamFile(req, res, messageId, channelId === 'home' ? null : channelId);
});

// ── START ──────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
    console.log(`CineHub Bridge running on port ${PORT}`);
    if (SESSION_STR) {
        try { await getClient(); }
        catch (e) { console.error('[Startup Error]', e.message); }
    } else {
        console.warn('[Warning] No TELEGRAM_SESSION env var set!');
    }
});
