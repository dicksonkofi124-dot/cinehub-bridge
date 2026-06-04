const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
const API_ID = parseInt(process.env.TELEGRAM_API_ID || '30876082');
const API_HASH = process.env.TELEGRAM_API_HASH || '5c98a0330c3ee4c0b337fece870cd953';
const SESSION_STR = process.env.TELEGRAM_SESSION || '';
const PORT = parseInt(process.env.PORT || '3000');
const MOVIES = { 'the-boys-s5e8': 422, 'the-rip-2026': 420 };
let client = null;
async function getClient() {
    if (client && client.connected) return client;
    client = new TelegramClient(new StringSession(SESSION_STR), API_ID, API_HASH, { connectionRetries: 5, autoReconnect: true });
    await client.connect();
    console.log('[Telegram] Connected');
    return client;
}
app.get('/', (req, res) => res.json({ status: 'CineHub Bridge OK' }));
app.get('/download/:key', async (req, res) => {
    const key = req.params.key;
    const messageId = MOVIES[key];
    if (!messageId) return res.status(404).json({ error: 'Movie not found' });
    try {
        const tg = await getClient();
        const result = await tg.invoke(new Api.messages.GetMessages({ id: [new Api.InputMessageID({ id: messageId })] }));
        const msg = result.messages?.[0];
        if (!msg?.media?.document) return res.status(404).json({ error: 'File not found' });
        const doc = msg.media.document;
        const nameAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeFilename');
        const fileName = nameAttr?.fileName || key + '.mkv';
        const fileSize = Number(doc.size);
        const range = req.headers.range;
        let start = 0, end = fileSize - 1;
        if (range) { const [s, e] = range.replace(/bytes=/, '').split('-'); start = parseInt(s); end = e ? parseInt(e) : fileSize - 1; }
        const chunkSize = end - start + 1;
        res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
        res.setHeader('Content-Length', chunkSize);
        res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
        res.setHeader('Accept-Ranges', 'bytes');
        if (range) { res.status(206); res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + fileSize); } else res.status(200);
        const iter = tg.iterDownload({ file: new Api.InputDocumentFileLocation({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: '' }), requestSize: 1024 * 1024, offset: BigInt(start), limit: Math.ceil(chunkSize / (1024 * 1024)) + 1 });
        let streamed = 0;
        for await (const chunk of iter) {
            if (res.destroyed) break;
            const remaining = chunkSize - streamed;
            const toWrite = chunk.length <= remaining ? chunk : chunk.slice(0, remaining);
            res.write(toWrite); streamed += toWrite.length;
            if (streamed >= chunkSize) break;
        }
        res.end();
    } catch (err) { console.error(err.message); if (!res.headersSent) res.status(500).json({ error: err.message }); }
});
app.listen(PORT, async () => { console.log('CineHub Bridge on port ' + PORT); if (SESSION_STR) { try { await getClient(); } catch(e) { console.error(e.message); } } });
