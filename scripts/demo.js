import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { readConfig } from '../src/config.js';
import { readFileSync } from 'node:fs';

// Screenshot-transcribed text in synthetic Telegram envelopes; no network calls.
const screenshots = JSON.parse(readFileSync(new URL('../test/fixtures/raidar-screenshots.json', import.meta.url), 'utf8'));
const defaults = readConfig({ TELEGRAM_BOT_TOKEN: 'demo', OWNER_TELEGRAM_ID: '42' });
const now = Math.floor(Date.now() / 1000);
const store = new Store(':memory:');
const config = { ownerId: 42, chatId: -10012345, topicId: 17, raidarId: 999, maxAge: 300,
  dryRun: false, watchMode: 'always', startPattern: defaults.startPattern, endPattern: defaults.endPattern, raidIdPattern: null };
const posts = [];
const service = new Service({ config, store, username: 'DemoBot', now: () => now, startedAt: now - 1,
  telegram: { send: async (_, text) => console.log(`[Owner DM] ${text}`) },
  x: { post: async (text) => { posts.push(text); return { id: `demo-${posts.length}` }; } },
});
try {
  await service.handleUpdate({ update_id: 1, message: { message_id: 1, date: now,
    from: { id: 42 }, chat: { id: 42, type: 'private' },
    text: '/text 🚨 A raid just started!\n\nJoin us: https://t.me/vibevibefun\nTarget: {raid_url}',
  } });
  for (const [id, text, edited] of [[2, screenshots.start, false], [3, screenshots.refresh, true], [4, screenshots.refresh, false], [5, screenshots.start, false]]) {
    await service.handleUpdate({ update_id: id, [edited ? 'edited_message' : 'message']: {
      message_id: edited ? 2 : id, date: now, from: { id: 999, is_bot: true },
      chat: { id: -10012345, type: 'supergroup' }, message_thread_id: 17,
      text,
    } });
    await service.deliverOne();
  }
  console.log(`\n${posts.length} simulated X posts for two explicit starts of the same target; the first raid's edit and refresh were ignored.`);
  console.log('No network requests were made. First post:\n' + posts[0]);
  if (posts.length !== 2) process.exitCode = 1;
} finally { store.close(); }
