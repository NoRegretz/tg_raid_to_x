import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Telegram } from '../src/api.js';
import { readConfig } from '../src/config.js';
import { OWNER_GUIDE } from '../src/owner-guide.js';

const NOW = 1800000000;
function harness(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const requests = [], posts = [];
  let time = NOW, id = 100, updateId = 0, failEdit = false;
  const telegram = new Telegram('test', async (url, options) => {
    const method = url.split('/').at(-1), body = JSON.parse(options.body);
    requests.push({ method, body });
    if (failEdit && method === 'editMessageText') return new Response('{"ok":false,"error_code":400}', { status: 400 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: body.message_id || ++id } }));
  });
  const config = { ...readConfig({ TELEGRAM_BOT_TOKEN: 'test', OWNER_TELEGRAM_ID: '42' }),
    chatId: -100123, raidarId: 999, dryRun: false };
  const args = { config, store, telegram, x: { post: async text => { posts.push(text); return { id: '123' }; } },
    username: 'testbot', now: () => time, startedAt: NOW - 1, log: () => {} };
  const service = new Service(args);
  const dm = (text, overrides = {}) => service.handleUpdate({ update_id: ++updateId, message: {
    message_id: ++id, date: time, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, text, ...overrides } });
  const query = (action, overrides = {}) => {
    const active = service.panel.active;
    return { id: `q${++id}`, from: { id: 42, is_bot: false }, data: `p:${active.token}:${action}`,
      message: { message_id: active.messageId, date: time, chat: { id: 42, type: 'private' } }, ...overrides };
  };
  const callback = q => service.handleUpdate({ update_id: ++updateId, callback_query: q });
  const tap = action => callback(query(action));
  const raid = async (overrides = {}, edited = false) => {
    const message = { message_id: ++id, date: time, chat: { id: config.chatId, type: 'supergroup' },
      from: { id: config.raidarId, is_bot: true }, text: '⚡ Raid Started!\nhttps://x.com/u/status/12345', ...overrides };
    await service.handleUpdate({ update_id: ++updateId, [edited ? 'edited_message' : 'message']: message });
    return message;
  };
  const screen = () => requests.filter(r => ['sendMessage', 'editMessageText'].includes(r.method)).at(-1).body;
  return { store, service, requests, posts, dm, query, callback, tap, raid, screen, args,
    tick: seconds => { time += seconds; }, failEditing: () => { failEdit = true; } };
}

for (const enableAction of ['watch', 'always']) {
  test(`Stop then ${enableAction} never catches up queued, unseen or refreshed off-window raids`, async t => {
    const h = harness(t);
    h.store.set('text', 'Notification');
    await h.dm('/start');
    await h.tap('watch');
    h.tick(1);
    const queued = await h.raid(); // Valid start, but worker has not dispatched it.
    await h.tap('unwatch');
    assert.equal(await h.service.deliverOne(), false);
    h.tick(1);
    const off = await h.raid(); // Start received while OFF.
    assert.equal(await h.service.deliverOne(), false);
    h.tick(2);
    await h.tap(enableAction); // New cutoff: NOW + 4.
    assert.equal(h.service.startedAt, NOW + 4);
    assert.equal(h.service.watching, true);
    await h.raid({ date: NOW + 3 }); // Previously unseen off-window start, delivered late.
    await h.raid({ date: NOW + 4 }); // Ambiguous activation second also excluded.
    await h.raid({ ...off }); // Re-delivery cannot revive skipped identity.
    await h.raid({ ...queued }); // Re-delivery cannot revive canceled outbox.
    h.tick(1);
    await h.raid({ text: '⚡ Raid Tweet\nhttps://x.com/u/status/12345' });
    await h.raid({ ...off, edit_date: NOW + 5 }, true);
    await h.raid({ text: 'Raid completed\nhttps://x.com/u/status/12345' });
    assert.equal(await h.service.deliverOne(), false);
    assert.equal(h.posts.length, 0);
    assert.equal(h.store.xUsage(NOW + 5).total, 0);
    // A separate genuine start during the new ON window is still allowed.
    await h.raid();
    assert.equal(await h.service.deliverOne(), true);
    assert.deepEqual(h.posts, ['Notification']);
  });
}

test('owner gets buttons with selected state; watch and mode buttons update the same panel', async t => {
  const h = harness(t);
  await h.dm('/start');
  assert.match(h.screen().text, /Watching: ⚪ OFF/);
  assert.ok(h.requests.some(r => r.body.reply_markup?.keyboard?.[0][0].text === '🎛 Controls'));
  assert.ok(h.screen().reply_markup.inline_keyboard.flat().some(b => b.text === '✅ Manual'));
  const panelId = h.service.panel.active.messageId;
  h.store.set('text', 'hello');
  await h.tap('watch');
  assert.equal(h.service.watching, true);
  assert.equal(new Service(h.args).watching, true);
  assert.equal(h.service.panel.active.messageId, panelId);
  assert.match(h.screen().text, /Watching: 🟢 ON/);
  assert.equal(h.posts.length, 0);
  await h.tap('always');
  assert.equal(h.store.get('watch_mode'), 'always');
  assert.ok(h.screen().reply_markup.inline_keyboard.flat().some(b => b.text === '✅ Always on'));
  await h.tap('unwatch');
  assert.equal(h.service.watching, false);
  assert.equal(new Service(h.args).watching, false);
  assert.equal(h.store.get('watch_mode'), 'manual');
  for (const request of h.requests) {
    if (request.body.chat_id) assert.equal(request.body.chat_id, 42);
    for (const button of request.body.reply_markup?.inline_keyboard?.flat() || []) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
});

test('ordinary users, admins, forwards and bot senders cannot open owner UI or change text', async t => {
  const h = harness(t);
  h.store.set('text', 'original');
  for (const overrides of [
    { from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' } },
    { from: { id: 7, is_bot: false, status: 'administrator' }, chat: { id: -100123, type: 'supergroup' } },
    { chat: { id: -100123, type: 'supergroup' } },
    { forward_origin: { type: 'user' } }, { sender_chat: { id: 42 } },
    { from: { id: 42, is_bot: true } }, { via_bot: { id: 9 } },
  ]) {
    await h.dm('/start', overrides);
    await h.dm('/guide', overrides);
    await h.dm('/text hijacked', overrides);
    await h.dm('🎛 Controls', overrides);
  }
  assert.equal(h.requests.length, 0);
  assert.equal(h.store.get('text'), 'original');
  assert.equal(h.service.watching, false);
});

test('forged, group, forwarded, inline and non-owner callbacks are rejected before any action or disclosure', async t => {
  const h = harness(t);
  await h.dm('/start');
  const active = h.service.panel.active;
  const message = { message_id: active.messageId, date: NOW, chat: { id: 42, type: 'private' } };
  for (const overrides of [
    { from: { id: 7, is_bot: false } }, { from: { id: 42, is_bot: true } },
    { message: { ...message, chat: { id: -100123, type: 'supergroup' } } },
    { message: { ...message, chat: { id: 7, type: 'private' } } },
    { message: { ...message, forward_origin: { type: 'user' } } },
    { message: { ...message, sender_chat: { id: 42 } } },
    { message: { ...message, via_bot: { id: 9 } } },
    { inline_message_id: 'inline' }, { message: undefined },
  ]) {
    const before = h.requests.length;
    await h.callback(h.query('watch', overrides));
    assert.equal(h.service.watching, false);
    assert.equal(h.requests.length, before + 1);
    assert.equal(h.requests.at(-1).method, 'answerCallbackQuery');
    assert.equal(h.requests.at(-1).body.text, 'Owner-only controls.');
    assert.equal(h.service.panel.active, active);
  }
  await h.callback(h.query('watch', { message: { ...message, message_id: -1 } }));
  assert.equal(h.service.watching, false);
  await h.callback(h.query('resume')); // Not displayed; cannot invent hidden actions.
  assert.equal(h.service.watching, false);
  await h.callback(h.query('watch', { data: 'p:invalid:watch' }));
  assert.equal(h.service.watching, false);
});

test('expired, replayed, superseded and previous-process buttons never activate watching', async t => {
  const h = harness(t);
  await h.dm('/start');
  const stale = h.query('watch');
  h.tick(901);
  await h.callback(stale);
  assert.equal(h.service.watching, false);
  const valid = h.query('watch');
  await h.callback(valid);
  assert.equal(h.service.watching, true);
  await h.tap('unwatch');
  await h.callback(valid);
  assert.equal(h.service.watching, false);
  const superseded = h.query('watch');
  await h.dm('/unwatch');
  await h.callback(superseded);
  assert.equal(h.service.watching, false);
  const offline = h.query('watch');
  const restarted = new Service({ ...h.args, startedAt: NOW + 901 });
  await restarted.handleUpdate({ update_id: 99999, callback_query: offline });
  assert.equal(restarted.watching, false);
});

test('text editor preserves exact whitespace, validates length, rejects outsiders and supports cancel', async t => {
  const h = harness(t);
  h.store.set('text', 'original');
  await h.dm('/start');
  await h.tap('text');
  await h.dm('hijack', { from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' } });
  await h.dm('forwarded', { forward_origin: { type: 'user' } });
  assert.equal(h.store.get('text'), 'original');
  await h.dm('a'.repeat(281));
  assert.match(h.screen().text, /Not saved/);
  assert.equal(h.store.get('text'), 'original');
  const text = '  🚀 Hello\n\n   Join now!  ';
  await h.dm(text);
  assert.equal(h.store.get('text'), text);
  assert.equal(h.service.panel.editing, null);
  await h.tap('preview');
  assert.equal(h.screen().text, text);
  assert.equal(h.screen().parse_mode, undefined);
  await h.tap('home');
  await h.tap('text');
  await h.tap('cancel');
  await h.dm('not a replacement');
  assert.equal(h.store.get('text'), text);
  assert.equal(h.posts.length, 0);
});

test('expired/old text, commands and restarts cannot accidentally save a pending replacement', async t => {
  const h = harness(t);
  h.store.set('text', 'original');
  await h.dm('/start');
  await h.tap('text');
  await h.dm('old', { date: NOW - 1 });
  assert.equal(h.store.get('text'), 'original');
  await h.tap('text');
  h.tick(601);
  await h.dm('expired');
  assert.equal(h.store.get('text'), 'original');
  await h.tap('text');
  await h.dm('/status');
  await h.dm('not a replacement');
  assert.equal(h.store.get('text'), 'original');
  await h.tap('text');
  const restarted = new Service(h.args);
  assert.equal(restarted.panel.editing, null);
});

test('health, preview, usage and history make no X calls; health labels unavailable checks honestly', async t => {
  const h = harness(t);
  await h.dm('/start');
  await h.tap('health');
  assert.match(h.screen().text, /No recent successful Telegram poll/);
  assert.match(h.screen().text, /reception is unconfirmed/);
  assert.match(h.screen().text, /cannot verify current X credentials, balance/);
  h.service.lastPollAt = NOW;
  h.service.pollError = 'Telegram getUpdates connection failed.';
  await h.tap('health');
  assert.match(h.screen().text, /Telegram polling has an error/);
  for (const action of ['preview', 'limits', 'history']) {
    await h.tap('home');
    await h.tap(action);
  }
  assert.equal(h.posts.length, 0);
  assert.equal(h.store.xUsage(NOW).total, 0);
  assert.ok(h.requests.every(r => ['sendMessage', 'editMessageText', 'answerCallbackQuery'].includes(r.method)));
});

test('UI watch does not clear posting errors or reset budgets; failed edit falls back without repeating action', async t => {
  const h = harness(t);
  h.store.set('posting_paused', 'X error');
  h.store.db.prepare('INSERT INTO x_requests (created_at,method,path) VALUES (?,?,?)').run(NOW, 'POST', '/2/tweets');
  await h.dm('/start');
  h.failEditing();
  await h.tap('watch');
  assert.equal(h.service.watching, true);
  assert.equal(h.store.get('posting_paused'), 'X error');
  assert.match(h.screen().text, /Posting remains paused/);
  await h.tap('resume');
  assert.equal(h.store.get('posting_paused'), '');
  assert.equal(h.store.xUsage(NOW).total, 1);
  assert.equal(h.posts.length, 0);
});

test('owner guide pages navigate in place, stay within Telegram limits, and never change settings or call X', async t => {
  const h = harness(t);
  h.store.set('text', 'Saved text');
  h.store.set('posting_paused', 'Keep this pause');
  await h.dm('/start');
  const settings = () => h.store.db.prepare("SELECT * FROM settings WHERE key != 'offset' ORDER BY key").all();
  const before = settings();
  const messageId = h.service.panel.active.messageId;
  for (const page of OWNER_GUIDE) {
    await h.tap(page.id);
    assert.equal(h.screen().text, page.text);
    assert.ok(page.text.length <= 4000);
    assert.equal(h.service.panel.active.messageId, messageId);
    for (const button of h.screen().reply_markup.inline_keyboard.flat()) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
  await h.tap('guidetext'); // Back from the last page.
  assert.equal(h.screen().text, OWNER_GUIDE[2].text);
  await h.tap('home');
  assert.match(h.screen().text, /Watching: ⚪ OFF/);
  assert.deepEqual(settings(), before);
  assert.equal(h.posts.length, 0);
  assert.equal(h.store.xUsage(NOW).total, 0);
  assert.ok(h.requests.every(r => ['sendMessage', 'editMessageText', 'answerCallbackQuery'].includes(r.method)));
});

test('guide shortcut works for owner only and non-owner callbacks reveal no guide content', async t => {
  const h = harness(t);
  await h.dm('/guide', { from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' } });
  assert.equal(h.requests.length, 0);
  await h.dm('/guide');
  assert.equal(h.screen().text, OWNER_GUIDE[0].text);
  const before = h.requests.length;
  await h.callback(h.query('guidewatch', { from: { id: 7, is_bot: false } }));
  assert.equal(h.requests.length, before + 1);
  assert.equal(h.requests.at(-1).body.text, 'Owner-only controls.');
  assert.equal(h.screen().text, OWNER_GUIDE[0].text);
});
