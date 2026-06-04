const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

const API_ID = 30876082;
const API_HASH = '5c98a0330c3ee4c0b337fece870cd953';

(async () => {
    const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 5 });

    await client.start({
        phoneNumber: async () => await input.text('Phone number (e.g. +233594522059): '),
        password: async () => await input.text('2FA password (or press Enter): '),
        phoneCode: async () => await input.text('Telegram code: '),
        onError: (err) => console.log(err),
    });

    console.log('\n✅ SESSION STRING:');
    console.log(client.session.save());

    console.log('\n📁 Your Saved Messages files:');
    const messages = await client.getMessages('me', { limit: 50 });
    messages.filter(m => m.media?.document).forEach(msg => {
        const attr = msg.media.document.attributes?.find(a => a.className === 'DocumentAttributeFilename');
        const name = attr?.fileName || 'Unknown';
        const size = (Number(msg.media.document.size) / 1024 / 1024).toFixed(1);
        console.log(`  ID: ${msg.id}  |  ${size} MB  |  ${name}`);
    });

    await client.disconnect();
    process.exit(0);
})();
