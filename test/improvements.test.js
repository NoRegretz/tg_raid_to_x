import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { XClient } from '../src/api.js';
import { XBudget } from '../src/x-budget.js';
import { readConfig } from '../src/config.js';
import { Service } from '../src/service.js';
import { detectRaid } from '../src/detect.js';
import { clip } from '../src/text.js';

const NOW = 1800000000;
const defaults = readConfig({ TELEGRAM_BOT_TOKEN: 'test', OWNER_TELEGRAM_ID: '42' });
const config = { ownerId: 42, chatId: -10012345, topicId: null, raidarId: 999, maxAge: 300,
  dryRun: false, watchMode: 'always', startPattern: defaults.startPattern,
  endPattern: defaults.endPattern, raidIdPattern: null };
const creds = { key: 'test', secret: 'test', accessToken: 'test', accessSecret: 'test', expectedUserId: '42' };
const raid = (id, date, target = '12345', extra = {}) => ({ update_id: id, message: { message_id: id, date,
  chat: { id: config.chatId, type: 'supergroup' }, from: { id: 999, is_bot: true },
  text: `⚡ Raid Started!\nhttps://x.com/u/status/${target}`, ...extra } });
const dm = (id, text, date = NOW) => ({ update_id: id, message: { message_id: id, date,
  from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, text } });
const duplicate = () => new Response(JSON.stringify({ title: 'Forbidden', status: 403,
  detail: 'You are not allowed to create a Tweet with duplicate content.' }), { status: 403 });
const created = (id) => new Response(JSON.stringify({ data: { id, text: 'x' } }), { status: 201 });

function setup(t, fetcher) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let time = NOW;
  const clock = { get: () => time, tick: (n = 1) => { time += n; } };
  const x = new XClient(creds, fetcher, new XBudget(store, undefined, () => time));
  const dms = [], logs = [];
  const service = new Service({ config, store, x, telegram: { send: async (_, text) => dms.push(text) },
    username: 'testbot', now: () => time, startedAt: NOW - 1, log: (line) => logs.push(line) });
  return { store, service, dms, logs, clock };
}

test('X duplicate rejection is recognised from the response, other 403s are not', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const budget = new XBudget(store, undefined, () => NOW);
  await assert.rejects(new XClient(creds, async () => duplicate(), budget).post('a'),
    (error) => error.duplicate === true && error.uncertain === false && error.status === 403);
  await assert.rejects(new XClient(creds, async () => new Response('{}', { status: 403 }), budget).post('b'),
    (error) => error.duplicate === false);
  await assert.rejects(new XClient(creds, async () => new Response('not json', { status: 403 }), budget).post('c'),
    (error) => error.duplicate === false);
});

test('a duplicate rejection does not pause posting; the same text is then skipped without an X request', async (t) => {
  let calls = 0;
  const responses = [duplicate()];
  const { store, service, dms, clock } = setup(t, async () => { calls++; return responses.shift() || created(String(500 + calls)); });
  store.set('text', 'Static notification');
  await service.handleUpdate(raid(1, clock.get()));
  await service.deliverOne();
  assert.equal(calls, 1);
  assert.equal(store.recent()[0].status, 'duplicate');
  assert.equal(store.get('posting_paused'), undefined);
  assert.equal(dms.length, 1);
  assert.match(dms[0], /NOT paused/);

  clock.tick(60);
  await service.handleUpdate(raid(2, clock.get()));
  await service.deliverOne();
  assert.equal(calls, 1, 'identical text must not spend another X request');
  assert.equal(store.recent()[0].status, 'skipped');
  assert.equal(dms.length, 1, 'repeat duplicates must not spam the owner');

  await service.handleUpdate(dm(3, '/text Raid at {started_at}', clock.get()));
  assert.match(dms.at(-1), /^Saved/);
  assert.doesNotMatch(dms.at(-1), /Tip:/);
  clock.tick();
  await service.handleUpdate(raid(4, clock.get()));
  await service.deliverOne();
  assert.equal(calls, 2);
  assert.equal(store.recent()[0].status, 'posted');
});

test('saving text without {started_at} includes a duplicate-avoidance tip', async (t) => {
  const { service, dms } = setup(t, async () => created('1'));
  await service.handleUpdate(dm(1, '/text Same words every time'));
  assert.match(dms.at(-1), /Tip: include \{started_at\}/);
});

test('blank topic accepts reply-thread IDs in a group without topics but still rejects forum topics', () => {
  const reply = raid(1, NOW, '12345', { message_thread_id: 777, reply_to_message: { message_id: 777 } });
  assert.ok(detectRaid(reply, config)?.key);
  assert.equal(detectRaid(raid(2, NOW, '12345', { message_thread_id: 5, is_topic_message: true }), config), null);
  const topicConfig = { ...config, topicId: 17 };
  assert.equal(detectRaid(raid(3, NOW, '12345', { message_thread_id: 777 }), topicConfig), null);
  assert.ok(detectRaid(raid(4, NOW, '12345', { message_thread_id: 17, is_topic_message: true }), topicConfig)?.key);
});

test('/where reports no topic for a reply thread and the real ID for a forum topic', async (t) => {
  const { service, dms } = setup(t, async () => created('1'));
  const where = (id, extra) => ({ update_id: id, message: { message_id: id, date: NOW,
    chat: { id: config.chatId, type: 'supergroup' }, from: { id: 42, is_bot: false }, text: '/where', ...extra } });
  await service.handleUpdate(where(1, { message_thread_id: 555, reply_to_message: { message_id: 555, from: { id: 999, is_bot: true } } }));
  assert.match(dms.at(-1), /Topic ID: \(none/);
  await service.handleUpdate(where(2, { message_thread_id: 17, is_topic_message: true }));
  assert.match(dms.at(-1), /Topic ID: 17\n/);
});

test('an update that throws is logged and skipped instead of stopping the bot', async (t) => {
  const { store, service, logs } = setup(t, async () => created('1'));
  service.handleUpdate = async () => { throw new Error('boom'); };
  await service.processUpdate({ update_id: 9 });
  assert.equal(store.get('offset'), '10');
  assert.match(logs.at(-1), /Update 9 could not be processed.*boom/);
});

test('clip never splits an emoji surrogate pair', () => {
  const text = 'a'.repeat(3999) + '🚀tail';
  assert.equal(clip(text), 'a'.repeat(3999));
  assert.equal(clip('a'.repeat(4001)).length, 4000);
  assert.equal(clip('short'), 'short');
});
