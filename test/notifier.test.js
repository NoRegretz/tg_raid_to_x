import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { readConfig } from '../src/config.js';
import { detectRaid, targetId } from '../src/detect.js';
import { validateText, parseCommand, renderText } from '../src/text.js';
import { ApiError, XClient, Telegram } from '../src/api.js';
import { checkTelegramAccess } from '../src/diagnostics.js';

const NOW = 1800000000;
const defaults = readConfig({ TELEGRAM_BOT_TOKEN: 'test', OWNER_TELEGRAM_ID: '42' });
const screenshots = JSON.parse(readFileSync(new URL('./fixtures/raidar-screenshots.json', import.meta.url), 'utf8'));
const config = { ownerId: 42, chatId: -10012345, topicId: 17, raidarId: 999,
  maxAge: 300, dryRun: false, watchMode: 'always', startPattern: defaults.startPattern,
  endPattern: defaults.endPattern, raidIdPattern: null };
function raid(updateId = 1, overrides = {}, edited = false) {
  return { update_id: updateId, [edited ? 'edited_message' : 'message']: {
    message_id: updateId, date: NOW, chat: { id: config.chatId, type: 'supergroup' },
    message_thread_id: config.topicId, from: { id: config.raidarId, is_bot: true },
    text: '⚡ Raid Started!\n\nhttps://x.com/vibevibe/status/12345', ...overrides,
  } };
}
function dm(id, text, overrides = {}) {
  return { update_id: id, message: { message_id: id, date: NOW,
    from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, text, ...overrides } };
}
function harness(t, overrides = {}) {
  const store = overrides.store || new Store(':memory:');
  if (!overrides.store) t.after(() => store.close());
  const posts = [], dms = [];
  const service = new Service({ config: { ...config, ...overrides.config }, store,
    telegram: { send: async (_, text) => dms.push(text) },
    x: { post: async (text) => { posts.push(text); return { id: String(1000 + posts.length) }; } },
    username: 'VibeNotifyBot', now: () => NOW, startedAt: NOW - 1, log: () => {}, ...overrides,
    config: { ...config, ...overrides.config },
  });
  // Preserve merged config when only individual config properties were overridden.
  service.config = { ...config, ...overrides.config };
  store.set('text', '🚨 We are raiding!\n\nJoin us  now.');
  return { service, store, posts, dms };
}

test('manual watching ignores off-window starts and stops queued delivery; immediate new starts notify', async (t) => {
  let time = NOW;
  const { service, posts, store } = harness(t, { config: { watchMode: 'manual' }, now: () => time });
  await service.handleUpdate(raid(1));
  await service.deliverOne();
  assert.equal(posts.length, 0);
  await service.handleUpdate(dm(2, '/watch'));
  assert.equal(service.watching, true);
  await service.handleUpdate(raid(3)); // Same-second start is conservatively skipped.
  time++;
  await service.handleUpdate(raid(4, { date: time }));
  await service.handleUpdate(dm(5, '/watch', { date: time })); // Idempotent, preserves pending start.
  await service.deliverOne();
  await service.handleUpdate(raid(6, { date: time })); // Instant restart, same target.
  await service.deliverOne();
  assert.equal(posts.length, 2);
  await service.handleUpdate(raid(7, { date: time }));
  await service.handleUpdate(dm(8, '/unwatch', { date: time }));
  assert.equal(service.watching, false);
  await service.deliverOne();
  time += 2;
  await service.handleUpdate(dm(9, '/watch', { date: time }));
  await service.handleUpdate(raid(10, { date: time - 1 })); // Delayed from off window.
  await service.deliverOne();
  assert.equal(posts.length, 2);
  assert.equal(store.get('watch_mode'), 'manual');
});

test('watch mode and manual activation persist, while offline activation cannot change the saved mode', async (t) => {
  const { service, store } = harness(t, { config: { watchMode: 'manual' } });
  await service.handleUpdate(dm(1, '/watch'));
  assert.equal(service.watching, true);
  const restarted = harness(t, { store, config: { watchMode: 'manual' }, startedAt: NOW, now: () => NOW + 2 }).service;
  assert.equal(restarted.watching, true);
  await restarted.handleUpdate(dm(2, '/watch'));
  await restarted.handleUpdate(dm(3, '/mode always'));
  assert.equal(restarted.watching, true);
  assert.equal(restarted.watchMode, 'manual');
  await restarted.handleUpdate(dm(4, '/mode always', { date: NOW + 2 }));
  assert.equal(restarted.watching, true);
  const always = harness(t, { store, config: { watchMode: 'manual' } }).service;
  assert.equal(always.watching, true);
  await always.handleUpdate(dm(5, '/unwatch'));
  const stopped = harness(t, { store, config: { watchMode: 'always' } }).service;
  assert.equal(stopped.watching, false);
  assert.equal(stopped.watchMode, 'manual');
});

test('saved ON/OFF, mode, text, pause and usage survive database reopen without replaying downtime raids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'raid-watch-persistence-'));
  try {
    for (const [mode, enabled, paused] of [['manual', true, false], ['manual', false, false], ['manual', true, true], ['always', true, false]]) {
      const path = join(dir, `${mode}-${enabled}-${paused}.sqlite`);
      let store = new Store(path), time = NOW;
      const posts = [];
      const create = (watchMode, startedAt) => new Service({ config: { ...config, watchMode }, store,
        telegram: { send: async () => {} }, x: { post: async text => { posts.push(text); return { id: '123' }; } },
        username: 'testbot', now: () => time, startedAt, log: () => {} });
      try {
        const first = create('manual', NOW - 1);
        await first.handleUpdate(dm(1, '/text 🚀 Saved\n\n  exactly  '));
        await first.handleUpdate(dm(2, mode === 'always' ? '/mode always' : enabled ? '/watch' : '/unwatch'));
        time++;
        await first.handleUpdate(raid(3, { date: time })); // Leave a notification pending at shutdown.
        if (paused) store.set('posting_paused', 'Previous X error');
        store.db.prepare('INSERT INTO x_requests (created_at,method,path) VALUES (?,?,?)').run(time, 'GET', '/2/users/me');
        store.close();
        store = new Store(path);
        time = NOW + 20;
        const second = create(mode === 'manual' ? 'always' : 'manual', time);
        assert.equal(second.watchMode, mode); // Saved owner choice beats environment fallback.
        assert.equal(second.watching, enabled);
        assert.equal(store.get('text'), '🚀 Saved\n\n  exactly  ');
        assert.equal(store.get('posting_paused') || '', paused ? 'Previous X error' : '');
        assert.equal(store.xUsage(time).total, 1);
        assert.equal(await second.deliverOne(), false); // Old outbox was discarded.
        await second.handleUpdate(raid(4, { date: time - 1 })); // Downtime.
        await second.handleUpdate(raid(5, { date: time })); // Startup second.
        await second.deliverOne();
        assert.equal(posts.length, 0);
        time++;
        await second.handleUpdate(raid(6, { date: time }));
        await second.deliverOne();
        assert.equal(posts.length, enabled && !paused ? 1 : 0);
        if (!enabled) {
          await second.handleUpdate(dm(7, '/watch', { date: NOW + 19 }));
          assert.equal(second.watching, false);
          assert.equal(store.get('watch_enabled'), 'false');
        }
      } finally { store.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('watch controls require original private owner commands and never clear safety pause', async (t) => {
  const { service, store } = harness(t, { config: { watchMode: 'manual' } });
  const invalid = [
    { from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' } },
    { chat: { id: config.chatId, type: 'supergroup' } },
    { forward_origin: { type: 'user' } },
    { from: { id: 42, is_bot: true } },
    { sender_chat: { id: 42 } },
  ];
  let id = 1;
  for (const override of invalid) await service.handleUpdate(dm(id++, '/mode always', override));
  const edited = dm(id++, '/watch');
  await service.handleUpdate({ update_id: edited.update_id, edited_message: edited.message });
  assert.equal(service.watching, false);
  store.set('posting_paused', 'X error');
  await service.handleUpdate(dm(id++, '/watch'));
  assert.equal(service.watching, true);
  assert.equal(store.get('posting_paused'), 'X error');
  await service.handleUpdate(dm(id++, '/mode manual'));
  await service.handleUpdate(dm(id++, '/resume'));
  assert.equal(service.watching, false);
  assert.equal(store.get('posting_paused'), '');
});

test('watch defaults to manual and rejects invalid configuration', () => {
  assert.equal(defaults.watchMode, 'manual');
  assert.equal(readConfig({ TELEGRAM_BOT_TOKEN: 'test', OWNER_TELEGRAM_ID: '42', WATCH_MODE: 'always' }).watchMode, 'always');
  assert.throws(() => readConfig({ TELEGRAM_BOT_TOKEN: 'test', OWNER_TELEGRAM_ID: '42', WATCH_MODE: 'yes' }), /WATCH_MODE/);
});

test('one X post for a start, edit, refreshed new messages and duplicate updates', async (t) => {
  const { service, store, posts } = harness(t);
  await service.handleUpdate(raid());
  await service.deliverOne();
  await service.handleUpdate(raid(2, { message_id: 1, text: 'Raid 50% https://twitter.com/other/status/12345?s=20' }, true));
  await service.handleUpdate(raid(3, { text: '⚡ Raid Tweet\nhttps://x.com/vibevibe/status/12345' }));
  await service.handleUpdate(raid(3, { message_id: 1 }));
  await service.handleUpdate(raid(4, { message_id: 1 }));
  await service.deliverOne();
  assert.equal(posts.length, 1);
  assert.equal(store.recent()[0].status, 'posted');
  assert.equal(store.get('offset'), '5');
});

test('SQLite deduplication and saved text survive an actual database reopen', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'raid-notifier-test-'));
  const path = join(dir, 'state.sqlite');
  const first = new Store(path);
  const one = harness(t, { store: first });
  await one.service.handleUpdate(dm(1, '/text Saved\n\n   exactly 🚀'));
  await one.service.handleUpdate(raid(2));
  await one.service.deliverOne();
  first.close();
  const second = new Store(path);
  try {
    assert.equal(second.get('text'), 'Saved\n\n   exactly 🚀');
    const two = harness(t, { store: second });
    await two.service.handleUpdate(raid(3, { message_id: 2 }));
    await two.service.deliverOne();
    assert.equal(two.posts.length, 0);
  } finally { second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('later explicit starts can notify again for the same target; old starts stay deduplicated', async (t) => {
  const { service, posts } = harness(t);
  await service.handleUpdate(raid(1)); await service.deliverOne();
  service.now = () => NOW + 86400;
  await service.handleUpdate(raid(2, { message_id: 1, date: NOW + 86400 }));
  await service.handleUpdate(raid(3, { date: NOW + 86400 }));
  await service.deliverOne();
  assert.equal(posts.length, 2);
  await service.handleUpdate(raid(4, { date: NOW + 86400, text: '⚡ Raid Started!\nhttps://x.com/i/web/status/67890' }));
  await service.deliverOne();
  assert.equal(posts.length, 3);
});

test('only the numeric owner in private chat can change text; edits/forwards are rejected', async (t) => {
  const { service, store } = harness(t);
  const original = store.get('text');
  await service.handleUpdate(dm(1, '/text intruder', { from: { id: 7 } }));
  await service.handleUpdate(dm(2, '/text group', { chat: { id: -1, type: 'supergroup' } }));
  await service.handleUpdate(dm(3, '/text forwarded', { forward_origin: { type: 'user' } }));
  await service.handleUpdate(dm(4, '/text@AnotherBot wrong bot'));
  const edit = dm(5, '/text edited');
  await service.handleUpdate({ update_id: 5, edited_message: edit.message });
  assert.equal(store.get('text'), original);
  const desired = '  🚀 Raid time!\n\n    Spaced line\nLast line  ';
  await service.handleUpdate(dm(6, `/text@VibeNotifyBot ${desired}`));
  assert.equal(store.get('text'), desired);
  await service.handleUpdate(raid(7));
  await service.deliverOne();
  assert.equal(store.recent()[0].text, desired);
});

test('X weighted validation handles complex emojis, URLs, and rejects overlong text without replacing saved text', async (t) => {
  assert.equal(validateText('👨‍👩‍👧‍👦').length, 2);
  assert.equal(validateText('https://example.com/' + 'a'.repeat(400)).length, 23);
  assert.equal(validateText('中'.repeat(141)).valid, false);
  const { service, store } = harness(t);
  const previous = store.get('text');
  await service.handleUpdate(dm(1, '/text ' + 'a'.repeat(281)));
  await service.handleUpdate(dm(2, '/text    '));
  assert.equal(store.get('text'), previous);
  assert.equal(parseCommand('/text\nA\n\nB ', 'bot').body, 'A\n\nB ');
  assert.equal(parseCommand('/text\r\nA', 'bot').body, 'A');
});

test('wrong group/topic/sender, spoofed forwards, human messages and ambiguous targets never post', async (t) => {
  const { service, posts } = harness(t);
  const variants = [
    { chat: { id: -7 } }, { message_thread_id: 2 }, { from: { id: 11, is_bot: true } },
    { from: { id: 999, is_bot: false } }, { forward_origin: { type: 'user' } },
    { sender_chat: { id: -5 } }, { text: 'Unrelated news https://x.com/u/status/12345' },
    { text: 'Raid Started!\nhttps://x.com/u/status/1 https://x.com/u/status/2' },
  ];
  for (let i = 0; i < variants.length; i++) await service.handleUpdate(raid(i + 1, variants[i]));
  await service.deliverOne(); assert.equal(posts.length, 0);
});

test('copying the exact start message cannot trigger or reserve a raid identity for anyone except Raidar', async (t) => {
  const { service, store, posts, dms } = harness(t);
  const variants = [
    { from: { id: 7, is_bot: false, first_name: 'Raidar' } },
    { from: { id: config.ownerId, is_bot: false } },
    { from: { id: 8, is_bot: true, first_name: 'Raidar', username: 'raidar' } },
    { from: { id: 7, is_bot: false }, forward_origin: { type: 'user', sender_user: { id: config.raidarId, is_bot: true } } },
    { from: { id: 7, is_bot: false }, reply_to_message: raid().message },
    { sender_chat: { id: config.chatId, title: 'Raidar' } },
  ];
  let updateId = 1;
  for (const variant of variants) {
    for (const edited of [false, true]) {
      for (const caption of [false, true]) {
        await service.handleUpdate(raid(updateId++, {
          // Reuse one message ID to prove rejected senders cannot poison deduplication.
          message_id: 50,
          text: caption ? undefined : screenshots.start,
          ...(caption ? { caption: screenshots.start } : {}),
          ...variant,
        }, edited));
        assert.equal(await service.deliverOne(), false);
      }
    }
  }
  assert.equal(posts.length, 0);
  assert.equal(dms.length, 0);
  assert.equal(store.recent().length, 0);
  await service.handleUpdate(raid(updateId, { message_id: 50, text: screenshots.start }));
  await service.deliverOne();
  assert.equal(posts.length, 1);
});

test('blank topic accepts a non-topic test group but never acts as an all-topics wildcard', async (t) => {
  const { service, posts } = harness(t, { config: { topicId: null } });
  await service.handleUpdate(raid(1, { message_thread_id: undefined, text: screenshots.start }));
  await service.deliverOne();
  assert.equal(posts.length, 1);
  await service.handleUpdate(raid(2, { text: screenshots.start }));
  await service.handleUpdate(raid(3, { message_thread_id: undefined, is_topic_message: true, text: screenshots.start }));
  await service.handleUpdate(raid(4, { message_thread_id: undefined, from: { id: 7, is_bot: false }, text: screenshots.start }));
  await service.deliverOne();
  assert.equal(posts.length, 1);
});

test('status distinguishes a received Raidar message in the wrong topic from no received messages', async (t) => {
  const { service, store, posts, dms } = harness(t);
  await service.handleUpdate(raid(1, { message_thread_id: 99 }));
  await service.deliverOne();
  assert.equal(posts.length, 0);
  assert.match(store.get('last_raidar_update'), /topic=99/);
  assert.equal(store.get('last_observed'), undefined);
  await service.handleUpdate(dm(2, '/status'));
  assert.match(dms.at(-1), /Last Raidar update received:/);
  assert.match(dms.at(-1), /topic=99/);
});

test('Telegram doctor checks chat access, topics and membership without consuming updates', async () => {
  const me = { id: 123, username: 'testbot', can_read_all_group_messages: false };
  const mock = (chat, member) => ({ call: async (method) => {
    if (method === 'getChat') return chat;
    if (method === 'getChatMember') return member;
    assert.fail(`Unexpected method: ${method}`);
  } });
  const plain = { type: 'supergroup' }, forum = { type: 'supergroup', is_forum: true };
  const admin = { status: 'administrator' };
  assert.equal((await checkTelegramAccess({ ...config, topicId: null }, mock(plain, admin), me)).ok, true);
  assert.equal((await checkTelegramAccess(config, mock(forum, admin), me)).ok, true);
  assert.equal((await checkTelegramAccess({ ...config, topicId: null }, mock(forum, admin), me)).ok, false);
  assert.equal((await checkTelegramAccess(config, mock(plain, admin), me)).ok, false);
  const privacy = await checkTelegramAccess(config, mock(forum, { status: 'member' }), me);
  assert.equal(privacy.ok, false);
  assert.match(privacy.lines.join('\n'), /Group Privacy is enabled/);
  const inaccessible = await checkTelegramAccess(config, { call: async () => { throw new ApiError('missing', { status: 400 }); } }, me);
  assert.equal(inaccessible.ok, false);
  assert.match(inaccessible.lines.join('\n'), /Cannot access configured chat/);
});

test('caption hidden links, emoji-containing text entities, and inline intent buttons identify the target', () => {
  const variants = [
    { text: undefined, caption: 'Raid Started!', caption_entities: [{ type: 'text_link', url: 'https://x.com/user/status/12345' }] },
    { text: '⚡ Raid Started!\n🚀 Go', entities: [{ type: 'text_link', offset: 18, length: 2, url: 'https://x.com/user/status/12345' }] },
    { text: 'Raid Started!', reply_markup: { inline_keyboard: [[{ text: 'Like', url: 'https://twitter.com/intent/like?tweet_id=12345' }], [{ text: 'Repost', url: 'https://x.com/intent/retweet?tweet_id=12345' }]] } },
  ];
  for (const msg of variants) assert.equal(detectRaid(raid(1, msg), config).targetId, '12345');
  assert.equal(targetId('https://x.com.evil.test/u/status/12345'), null);
  assert.equal(targetId('https://x.com/u/status/12345fake'), null);
});

test('screenshot start posts once; screenshot refreshes never post as edits or new messages', async (t) => {
  const { service, posts, store } = harness(t);
  await service.handleUpdate(raid(1, { text: screenshots.start }));
  await service.deliverOne();
  for (let id = 2; id <= 6; id++) {
    await service.handleUpdate(raid(id, { text: screenshots.refresh, message_id: id % 2 ? id : 1 }, id % 2 === 0));
    await service.deliverOne();
  }
  assert.equal(posts.length, 1);
  assert.equal(store.recent()[0].target_id, '2096332571554595311');
  assert.equal(store.recent()[0].key, `${config.chatId}:${config.topicId}:start:1`);
});

test('a start and immediate refreshes in one batch preserve the start before the X worker runs', async (t) => {
  const { service, store, posts } = harness(t);
  const batch = [
    raid(1, { text: screenshots.start }),
    raid(2, { message_id: 1, text: screenshots.refresh }, true),
    raid(3, { text: screenshots.refresh }),
    raid(4, { message_id: 3, text: screenshots.refresh }, true),
  ];
  // No time passes and no delivery occurs between the original and its refreshes.
  for (const update of batch) await service.handleUpdate(update);
  assert.equal(posts.length, 0);
  assert.equal(store.get('offset'), '5');
  assert.equal(store.recent().length, 1);
  assert.equal(store.recent()[0].status, 'pending');
  assert.equal(store.recent()[0].message_id, 1);
  await service.deliverOne();
  assert.equal(posts.length, 1);
  assert.equal(await service.deliverOne(), false);
});

test('a captured but unposted start is skipped on restart even if refreshes arrive afterwards', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'raid-notifier-pending-test-'));
  const path = join(dir, 'state.sqlite');
  const first = new Store(path);
  try {
    const one = harness(t, { store: first });
    await one.service.handleUpdate(raid(1, { text: screenshots.start }));
    assert.equal(first.get('offset'), '2');
    assert.equal(first.recent()[0].status, 'pending');
  } finally { first.close(); }
  const second = new Store(path);
  try {
    const two = harness(t, { store: second, startedAt: NOW + 10, now: () => NOW + 10 });
    assert.equal(second.recover(), 0);
    await two.service.handleUpdate(raid(2, { message_id: 1, text: screenshots.refresh }, true));
    await two.service.handleUpdate(raid(3, { text: screenshots.refresh }));
    await two.service.deliverOne();
    assert.equal(two.posts.length, 0);
    assert.equal(second.recent()[0].status, 'skipped');
    assert.match(second.recent()[0].detail, /restarted/);
  } finally { second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('starting the bot mid-raid ignores refreshes even with no stored history', async (t) => {
  const { service, posts, store } = harness(t);
  await service.handleUpdate(raid(1, { text: screenshots.refresh }));
  await service.deliverOne();
  assert.equal(posts.length, 0);
  assert.equal(store.recent().length, 0);
  // A future genuine start of that same post must still notify.
  await service.handleUpdate(raid(2, { text: screenshots.start }));
  await service.deliverOne();
  assert.equal(posts.length, 1);
});

test('queued downtime starts and the startup second are skipped; a post-start raid still sends', async (t) => {
  const { service, store, posts } = harness(t, { startedAt: NOW, now: () => NOW + 2 });
  // All are younger than MAX_EVENT_AGE_SECONDS, which used to allow catch-up posts.
  const dates = [NOW - 200, NOW - 1, NOW];
  for (let i = 0; i < dates.length; i++) {
    await service.handleUpdate(raid(i + 1, { date: dates[i], text: screenshots.start }));
    await service.deliverOne();
    const recorded = store.getRaid(`${config.chatId}:${config.topicId}:start:${i + 1}`);
    assert.equal(recorded.status, 'skipped');
    assert.match(recorded.detail, /before this bot session/);
  }
  assert.equal(posts.length, 0);
  await service.handleUpdate(raid(4, { date: NOW + 1, text: screenshots.refresh }));
  await service.handleUpdate(raid(5, { date: NOW + 1, text: screenshots.start }));
  await service.deliverOne();
  assert.equal(posts.length, 1);
  assert.equal(store.get('offset'), '6');
});

test('dry run also ignores downtime raids while owner commands queued offline still work', async (t) => {
  const { service, store, posts, dms } = harness(t, { config: { dryRun: true }, startedAt: NOW, now: () => NOW + 2 });
  await service.handleUpdate(dm(1, '/text Saved while offline', { date: NOW - 60 }));
  assert.equal(store.get('text'), 'Saved while offline');
  dms.length = 0;
  await service.handleUpdate(raid(2, { date: NOW - 10 }));
  await service.deliverOne();
  assert.equal(dms.length, 0);
  await service.handleUpdate(raid(3, { date: NOW + 1 }));
  await service.deliverOne();
  assert.equal(dms.length, 2);
  assert.equal(dms[1], 'Saved while offline');
  assert.equal(posts.length, 0);
});

test('a rate-limit error pauses posting across a restart without any automatic retry', async (t) => {
  const first = harness(t);
  first.service.x.post = async () => { throw new ApiError('rate limit', { status: 429, retryAt: (NOW + 30) * 1000 }); };
  await first.service.handleUpdate(raid(1));
  await first.service.deliverOne();
  assert.equal(first.store.recent()[0].status, 'failed');
  assert.ok(first.store.get('posting_paused'));
  const second = harness(t, { store: first.store, startedAt: NOW - 20, now: () => NOW + 30 });
  assert.equal(second.store.recent()[0].status, 'failed');
  assert.ok(second.store.get('posting_paused'));
  assert.equal(await second.service.deliverOne(), false);
  assert.equal(second.posts.length, 0);
});

test('the default service cutoff is set from startup time, and delivery independently rejects older work', async (t) => {
  const { service, store, posts } = harness(t, { startedAt: undefined, now: () => NOW });
  assert.equal(service.startedAt, NOW);
  // Simulate an old queued row appearing after initialization, so delivery must check too.
  store.add({ key: 'old', targetId: '12345', messageId: 1, date: NOW - 1 }, 'Old raid', 'live', 'pending');
  await service.deliverOne();
  assert.equal(posts.length, 0);
  assert.equal(store.getRaid('old').status, 'skipped');
});

test('only the first nonempty line controls lifecycle; quoted post content cannot trigger or cancel', () => {
  assert.ok(detectRaid(raid(1, { text: screenshots.refresh + '\nRaid Started!' }), config).ignored);
  assert.ok(detectRaid(raid(1, { text: 'Some announcement\n' + screenshots.start }), config).ignored);
  const start = detectRaid(raid(1, { text: '\n  ' + screenshots.start + '\nRaid completed' }), config);
  assert.equal(start.ended, false);
  assert.equal(start.targetId, '2096332571554595311');
  assert.ok(detectRaid(raid(1, { text: 'Raid Started yesterday\nhttps://x.com/u/status/1' }), config).ignored);
});

test('a late edit to an old completion cannot cancel a newer start of the same target', async (t) => {
  const { service, posts } = harness(t);
  await service.handleUpdate(raid(1, { message_id: 10, text: screenshots.start }));
  await service.handleUpdate(raid(2, { message_id: 5, text: 'Raid completed\nhttps://x.com/LevsKript/status/2096332571554595311' }, true));
  await service.deliverOne();
  assert.equal(posts.length, 1);
});

test('legacy target records suppress the recorded start, but allow later genuine starts', async (t) => {
  const { service, store, posts } = harness(t);
  store.add({ key: `${config.chatId}:${config.topicId}:post:12345`, targetId: '12345', messageId: 1, date: NOW }, 'old text', 'live', 'posted');
  await service.handleUpdate(raid(2, { message_id: 1 }));
  await service.deliverOne();
  assert.equal(posts.length, 0);
  await service.handleUpdate(raid(3));
  await service.deliverOne();
  assert.equal(posts.length, 1);
});

test('unknown edits, old starts, and completions seed suppression without a delayed notification', async (t) => {
  for (const [overrides, edited] of [ [{}, true], [{ date: NOW - 301 }, false], [{ text: 'Raid completed https://x.com/u/status/12345' }, false] ]) {
    const { service, store, posts } = harness(t);
    await service.handleUpdate(raid(1, overrides, edited));
    await service.handleUpdate(raid(2, { message_id: 1 }));
    await service.deliverOne();
    assert.equal(posts.length, 0);
    assert.equal(store.recent()[0].status, 'skipped');
  }
});

test('unique run IDs permit another raid of the same target but suppress refreshes', async (t) => {
  const { service, posts } = harness(t, { config: { raidIdPattern: /Run:\s*(\w+)/i } });
  for (const [id, run] of [[1, 'A'], [2, 'A'], [3, 'B']]) {
    await service.handleUpdate(raid(id, { text: `Raid Started!\nRun: ${run}\nhttps://x.com/u/status/12345` }));
    await service.deliverOne();
  }
  await service.handleUpdate(raid(4)); await service.deliverOne();
  assert.equal(posts.length, 2);
});

test('crash recovery and uncertain X errors never automatically retry', async (t) => {
  const { service, store, posts } = harness(t);
  await service.handleUpdate(raid(1)); store.claim(NOW);
  assert.equal(store.recover(), 1);
  await service.handleUpdate(raid(2, { message_id: 1 })); await service.deliverOne();
  assert.equal(posts.length, 0);
  assert.equal(store.recent()[0].status, 'uncertain');
  assert.ok(store.get('posting_paused'));
  await service.handleUpdate(dm(3, '/resume'));
  service.now = () => NOW + 1;
  let calls = 0;
  service.x.post = async () => { calls++; throw new ApiError('timeout', { uncertain: true }); };
  await service.handleUpdate(raid(4, { date: NOW + 1, text: 'Raid Started!\nhttps://x.com/u/status/55' }));
  await service.deliverOne();
  await service.handleUpdate(raid(5, { message_id: 4, date: NOW + 1, text: 'Raid Started!\nhttps://x.com/u/status/55' }));
  await service.deliverOne();
  assert.equal(calls, 1);
  assert.equal(store.recent()[0].status, 'uncertain');
});

test('an X rejection pauses later raids; a failed owner DM never repeats a successful X post', async (t) => {
  const { service, store } = harness(t);
  let calls = 0;
  service.x.post = async () => { calls++; return { id: '9999' }; };
  service.telegram.send = async () => { throw new Error('owner blocked bot'); };
  await service.handleUpdate(raid(1)); await service.deliverOne();
  assert.equal(store.recent()[0].status, 'posted');
  assert.equal(await service.deliverOne(), false);
  service.now = () => NOW + 30;
  await service.deliverOne(); await service.handleUpdate(raid(2, { message_id: 1 })); await service.deliverOne();
  assert.equal(calls, 1);
  assert.equal(store.recent()[0].status, 'posted');
  service.x.post = async () => { calls++; throw new ApiError('forbidden', { status: 403 }); };
  await service.handleUpdate(raid(3, { text: 'Raid Started!\nhttps://x.com/u/status/56' }));
  await service.deliverOne(); await service.deliverOne();
  assert.equal(calls, 2);
  assert.equal(store.recent()[0].status, 'failed');
  assert.ok(store.get('posting_paused'));
  await service.handleUpdate(raid(4)); await service.deliverOne();
  assert.equal(calls, 2);
  assert.equal(store.recent()[0].status, 'skipped');
});

test('completion cancels queued delivery; expired work and mode changes cannot send', async (t) => {
  const { service, store, posts } = harness(t);
  await service.handleUpdate(raid(1));
  await service.handleUpdate(raid(2, { text: 'Raid ended https://x.com/u/status/12345' }));
  await service.deliverOne(); assert.equal(posts.length, 0);
  assert.equal(store.recent()[0].status, 'skipped');
  await service.handleUpdate(raid(3, { text: 'Raid Started!\nhttps://x.com/u/status/56' }));
  service.now = () => NOW + 301;
  await service.deliverOne(); assert.equal(posts.length, 0);
  service.now = () => NOW;
  service.config.dryRun = true;
  await service.handleUpdate(raid(4, { text: 'Raid Started!\nhttps://x.com/u/status/57' }));
  service.config.dryRun = false;
  await service.deliverOne(); assert.equal(posts.length, 0);
});

test('dry runs report one notification without calling X', async (t) => {
  const { service, store, posts, dms } = harness(t, { config: { dryRun: true } });
  await service.handleUpdate(raid(1)); await service.deliverOne();
  await service.handleUpdate(raid(2, { text: '⚡ Raid Tweet\nhttps://x.com/u/status/12345' })); await service.deliverOne();
  assert.equal(posts.length, 0);
  assert.equal(dms.length, 2);
  assert.equal(store.recent()[0].status, 'dry_run');
});

test('optional placeholders expand without changing whitespace and text is snapshotted at raid start', async (t) => {
  const { service, posts } = harness(t);
  await service.handleUpdate(dm(1, '/text 🚀\n\n{raid_url}\n  {started_at}  '));
  await service.handleUpdate(raid(2));
  await service.handleUpdate(dm(3, '/text This is for future raids'));
  await service.deliverOne();
  assert.equal(posts[0], `🚀\n\nhttps://x.com/i/web/status/12345\n  ${new Date(NOW * 1000).toISOString()}  `);
  assert.throws(() => renderText('{raid_url}', { date: NOW, targetId: null }), /no unique/);
});

test('config defaults to dry run, rejects unsafe live config, and accepts quoted regex from Node env parser', () => {
  const minimal = { TELEGRAM_BOT_TOKEN: 'test', OWNER_TELEGRAM_ID: '42' };
  assert.equal(readConfig(minimal).dryRun, true);
  assert.throws(() => readConfig({ ...minimal, DRY_RUN: 'FALSE' }), /DRY_RUN/);
  assert.throws(() => readConfig({ ...minimal, DRY_RUN: 'false' }), /TELEGRAM_CHAT_ID/);
  assert.throws(() => readConfig({ ...minimal, RAID_START_PATTERN: '[' }), /regular expression/);
  assert.throws(() => readConfig({ ...minimal, OWNER_TELEGRAM_ID: '9007199254740993' }), /safe/);
  const example = readConfig({ ...parseEnv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8')), ...minimal });
  assert.equal(example.startPattern.source, defaults.startPattern.source);
  assert.equal(example.startPattern.test('⚡ Raid Started!'), true);
  assert.equal(example.startPattern.test('⚡ Raid Tweet'), false);
});

const xConfig = { key: 'key', secret: 'secret', accessToken: 'token', accessSecret: 'token-secret', expectedUserId: '42' };
// These adapter-only tests stub the gate; x-budget.test.js tests the real ledger.
const transportTestBudget = { reserve() {} };
test('X adapter uses signed OAuth user context and sends exact UTF-8 JSON to v2', async () => {
  const text = '🚀\n\n  Go now  ';
  const requests = [];
  const x = new XClient(xConfig, async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ data: { id: '42', username: 'vibevibe' } }), { status: 201 });
  }, transportTestBudget);
  await x.verifyAccount(); await x.post(text);
  assert.equal(requests[0].url, 'https://api.x.com/2/users/me');
  assert.equal(requests[1].url, 'https://api.x.com/2/tweets');
  assert.equal(requests[1].options.method, 'POST');
  assert.match(requests[1].options.headers.Authorization, /^OAuth /);
  assert.match(requests[1].options.headers.Authorization, /oauth_signature=/);
  assert.deepEqual(JSON.parse(requests[1].options.body), { text });
  const wrong = new XClient({ ...xConfig, expectedUserId: '7' }, x.fetcher, transportTestBudget);
  await assert.rejects(wrong.verifyAccount(), /mismatch/);
});

test('X adapter classifies 5xx, lost responses and malformed successes as uncertain, 4xx as rejected', async () => {
  for (const status of [400, 401, 403, 408, 429, 500, 503]) {
    const x = new XClient(xConfig, async () => new Response('{}', { status }), transportTestBudget);
    await assert.rejects(x.post('hello'), (error) => error.status === status && error.uncertain === (status >= 500 || status === 408));
  }
  for (const fetcher of [async () => { throw new Error('secret URL'); }, async () => new Response('not json'), async () => new Response('{}')]) {
    await assert.rejects(new XClient(xConfig, fetcher, transportTestBudget).post('hello'), (error) => error.uncertain && !error.message.includes('secret URL'));
  }
});

test('Telegram replies disable link previews and send no Markdown parse mode; failures redact tokens', async () => {
  const telegram = new Telegram('secret-token', async (url, options) => {
    assert.equal(url, 'https://api.telegram.org/botsecret-token/sendMessage');
    const body = JSON.parse(options.body);
    assert.equal(body.text, '  hello\n\n🚀');
    assert.equal(body.parse_mode, undefined);
    return new Response('{"ok":true,"result":{}}');
  });
  await telegram.send(42, '  hello\n\n🚀');
  telegram.fetcher = async () => { throw new Error('secret-token'); };
  await assert.rejects(telegram.send(42, 'text'), (error) => !error.message.includes('secret-token'));
});
