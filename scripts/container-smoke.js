// Executed only by CI in isolated containers with an isolated volume and no network.
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { readConfig } from '../src/config.js';
import { XBudget } from '../src/x-budget.js';

assert.equal(typeof process.getuid, 'function', 'This smoke check requires a Linux container.');
assert.notEqual(process.getuid(), 0, 'The standard Docker image must run as non-root.');
assert.equal(process.env.DATABASE_PATH, '/app/data/raid-notifier.sqlite');
const phase = process.argv[2];
assert.ok(['write', 'read'].includes(phase));
const NOW = 1800000000;
let time = phase === 'write' ? NOW - 10 : NOW;
const config = { ...readConfig({ TELEGRAM_BOT_TOKEN: 'ci-placeholder', OWNER_TELEGRAM_ID: '42' }),
  chatId: -100123, raidarId: 999 };
const store = new Store(process.env.DATABASE_PATH);
const dms = [];
try {
  const service = new Service({ config, store, telegram: { send: async (_, text) => dms.push(text) },
    x: { post: async () => { throw new Error('No X request is allowed in this check.'); } },
    username: 'cibot', now: () => time, startedAt: time - (phase === 'write' ? 1 : 0), log: () => {} });
  const raid = (id, date) => ({ update_id: id, message: { message_id: id, date,
    chat: { id: config.chatId, type: 'supergroup' }, from: { id: 999, is_bot: true },
    text: '⚡ Raid Started!\nhttps://x.com/test/status/12345' } });
  if (phase === 'write') {
    store.set('text', '🚀 Saved\n\n  exactly  ');
    await service.handleUpdate({ update_id: 1, message: { message_id: 1, date: time,
      chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false }, text: '/watch' } });
    new XBudget(store, undefined, () => time).reserve('GET', '/2/users/me'); // Ledger only, no API call.
    time++;
    await service.handleUpdate(raid(2, time)); // Intentionally leave queued at shutdown.
    assert.equal(store.recent()[0].status, 'pending');
    store.set('posting_paused', 'Persisted CI pause');
  } else {
    assert.equal(service.watching, true);
    assert.equal(service.watchMode, 'manual');
    assert.equal(store.get('text'), '🚀 Saved\n\n  exactly  ');
    assert.equal(store.get('posting_paused'), 'Persisted CI pause');
    assert.equal(store.xUsage(time).total, 1);
    assert.equal(store.recent()[0].status, 'skipped');
    assert.equal(await service.deliverOne(), false);
    store.set('posting_paused', ''); // Exercise the cutoff independently of the pause.
    await service.handleUpdate(raid(3, NOW - 1));
    assert.equal(await service.deliverOne(), false);
    assert.equal(dms.length, 0);
    time++;
    await service.handleUpdate(raid(4, time));
    assert.equal(await service.deliverOne(), true);
    assert.equal(store.recent()[0].status, 'dry_run');
    assert.equal(dms.length, 2);
  }
  console.log(`Container ${phase} check passed: non-root SQLite volume and session boundaries.`);
} finally { store.close(); }
