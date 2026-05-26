/**
 * Session Generator
 * Run this ONCE locally to generate a session string: npm run auth
 * Then paste the session string into your .env file
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
require('dotenv').config();

async function generateSession() {
  console.log('\n=== Telegram Session String Generator ===\n');
  console.log('This will log into your Telegram account and generate a session string.');
  console.log('You only need to do this ONCE.\n');

  const apiId = parseInt(process.env.API_ID, 10);
  const apiHash = process.env.API_HASH;

  if (!apiId || !apiHash) {
    console.error('❌ API_ID and API_HASH must be set in .env file');
    console.error('   Get them from: https://my.telegram.org/apps\n');
    process.exit(1);
  }

  const session = new StringSession('');

  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text('📱 Enter your phone number (with country code): '),
    password: async () => await input.text('🔑 Enter your 2FA password (if any): '),
    phoneCode: async () => await input.text('💬 Enter the code you received: '),
    onError: (err) => console.error('Error:', err),
  });

  const sessionString = client.session.save();

  console.log('\n✅ Successfully logged in!\n');
  console.log('='.repeat(60));
  console.log('YOUR SESSION STRING (copy this to .env as SESSION_STRING):');
  console.log('='.repeat(60));
  console.log(`\n${sessionString}\n`);
  console.log('='.repeat(60));
  console.log('\n⚠️  KEEP THIS SECRET! Anyone with this string can access your account.\n');

  // Verify the group
  const groupId = process.env.GROUP_ID;
  if (groupId) {
    try {
      const entity = await client.getEntity(BigInt(groupId));
      console.log(`✅ Group verified: ${entity.title || entity.id}`);
    } catch (err) {
      console.log(`⚠️  Could not verify group ${groupId}: ${err.message}`);
      console.log('   Make sure the bot account is a member of the group.\n');
    }
  }

  await client.disconnect();
  process.exit(0);
}

generateSession().catch((err) => {
  console.error('❌ Session generation failed:', err);
  process.exit(1);
});