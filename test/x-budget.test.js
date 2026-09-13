import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { XClient } from '../src/api.js';
import { XBudget, XBudgetError, DEFAULT_X_LIMITS } from '../src/x-budget.js';
import { readXLimits, readConfig } from '../src/config.js';
import { Service } from '../src/service.js';

const NOW = 1800000000;
const creds = { key: 'test', secret: 'test', accessToken: 'test', accessSecret: 'test', expectedUserId: '42' };
const response = () => new Response(JSON.stringify({ data: { id: '42', username: 'test' } }), { status: 201 });
const memory = (t) => { const store = new Store(':memory:'); t.after(() => store.close()); return store; };

test('every X network request requires a persistent budget; unsupported endpoints cannot make requests', async (t) => {
  const store = memory(t);
  let calls = 0;
  const fetcher = async () => { calls++; return response(); };
  await assert.rejects(new XClient(creds, fetcher).post('hello'), XBudgetError);
  const client = new XClient(creds, fetcher, new XBudget(store, undefined, () => NOW));
  await assert.rejects(client.request('GET', '/2/tweets'), /not allowed/);
  await assert.rejects(client.request('DELETE', '/2/tweets/42'), /not allowed/);
  assert.equal(calls, 0);
  assert.equal(store.xUsage(NOW).total, 0);
});

test('100 concurrent post attempts cannot overshoot a three-request budget', async (t) => {
  const store = memory(t);
  let time = NOW, calls = 0;
  const budget = new XBudget(store, { maxRequestsTotal: 3, maxRequests24h: 3, maxPosts24h: 3, minPostInterval: 1 }, () => time++);
  const client = new XClient(creds, async () => { calls++; return response(); }, budget);
  const results = await Promise.allSettled(Array.from({ length: 100 }, () => client.post('hello')));
  assert.equal(calls, 3);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal(store.xUsage(time).total, 3);
});

test('failed reads and unreadable write responses spend reservations and eventually stop', async (t) => {
  const store = memory(t);
  let time = NOW, calls = 0;
  const budget = new XBudget(store, { maxRequestsTotal: 3, minPostInterval: 1 }, () => time++);
  const client = new XClient(creds, async () => { calls++; throw new Error('network down'); }, budget);
  for (let n = 0; n < 3; n++) await assert.rejects(client.getAccount(), /connection failed/);
  await assert.rejects(client.getAccount(), /Lifetime/);
  assert.equal(calls, 3);
  assert.equal(store.xUsage(time).total, 3);
  const otherStore = memory(t);
  const malformed = new XClient(creds, async () => new Response('not json'), new XBudget(otherStore, undefined, () => NOW));
  await assert.rejects(malformed.post('hello'), /could not be read/);
  assert.equal(otherStore.xUsage(NOW).posts24h, 1);
});

test('cooldown and rolling limits block locally without reserving another request', (t) => {
  const store = memory(t);
  let time = NOW;
  const budget = new XBudget(store, { maxPosts24h: 2, minPostInterval: 300 }, () => time);
  budget.reserve('POST', '/2/tweets');
  time += 299;
  assert.throws(() => budget.reserve('POST', '/2/tweets'), /cooldown/);
  assert.equal(store.xUsage(time).total, 1);
  time++;
  budget.reserve('POST', '/2/tweets');
  time += 300;
  assert.throws(() => budget.reserve('POST', '/2/tweets'), /24-hour X post cap/);
  time = NOW + 86400;
  budget.reserve('POST', '/2/tweets');
  assert.equal(store.xUsage(time).total, 3);
});

test('mixed reads and writes share rolling and lifetime caps that never auto-renew', (t) => {
  const store = memory(t);
  let time = NOW;
  const budget = new XBudget(store, { maxRequests24h: 2, maxRequestsTotal: 3 }, () => time);
  budget.reserve('GET', '/2/users/me');
  budget.reserve('POST', '/2/tweets');
  assert.throws(() => budget.reserve('GET', '/2/users/me'), /24-hour X request cap/);
  time += 86401;
  budget.reserve('GET', '/2/users/me');
  time += 86401;
  assert.throws(() => budget.reserve('GET', '/2/users/me'), /Lifetime/);
});

test('two database connections share the cap; reopening and a clock rollback cannot reset it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'raid-credit-test-'));
  const path = join(dir, 'ledger.sqlite');
  const one = new Store(path), two = new Store(path);
  try {
    new XBudget(one, { maxRequestsTotal: 1 }, () => NOW).reserve('GET', '/2/users/me');
    assert.throws(() => new XBudget(two, { maxRequestsTotal: 1 }, () => NOW).reserve('GET', '/2/users/me'), /Lifetime/);
  } finally { one.close(); two.close(); }
  const reopened = new Store(path);
  try {
    assert.throws(() => new XBudget(reopened, { maxRequestsTotal: 1 }, () => NOW + 86401).reserve('GET', '/2/users/me'), /Lifetime/);
    assert.throws(() => new XBudget(reopened, undefined, () => NOW - 1).reserve('GET', '/2/users/me'), /clock moved backward/);
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('repeated account checks use the cache; changing credentials requires a capped read', async (t) => {
  const store = memory(t);
  let calls = 0;
  const fetcher = async () => { calls++; return response(); };
  for (let i = 0; i < 30; i++) {
    const client = new XClient(creds, fetcher, new XBudget(store, undefined, () => NOW));
    await client.verifyAccount();
  }
  assert.equal(calls, 1);
  const wrong = new XClient({ ...creds, expectedUserId: 'other' }, fetcher, new XBudget(store, undefined, () => NOW));
  await assert.rejects(wrong.verifyAccount(), /mismatch/);
  assert.equal(calls, 1);
  const changed = new XClient({ ...creds, accessSecret: 'changed' }, fetcher, new XBudget(store, undefined, () => NOW));
  await changed.verifyAccount();
  assert.equal(calls, 2);
  assert.equal(store.xUsage(NOW).total, 2);
});

test('invalid or unlimited credit configuration is rejected', () => {
  assert.deepEqual(readXLimits({}), DEFAULT_X_LIMITS);
  assert.equal(readXLimits({ X_MIN_POST_INTERVAL_SECONDS: '0' }).minPostInterval, 0);
  assert.throws(() => readXLimits({ X_MIN_POST_INTERVAL_SECONDS: '-1' }), /nonnegative/);
  for (const value of ['0', '-1', 'Infinity', 'NaN', '1.5', '9007199254740993']) {
    assert.throws(() => readXLimits({ X_MAX_REQUESTS_TOTAL: value }), /positive integer/);
  }
});

test('default budget allows 100 immediate attempts, then blocks; watch toggles retain usage', async (t) => {
  const store = memory(t);
  const budget = new XBudget(store, undefined, () => NOW);
  for (let n = 0; n < 100; n++) budget.reserve('POST', '/2/tweets');
  assert.throws(() => budget.reserve('POST', '/2/tweets'), /post cap/);
  const service = new Service({ config, store, telegram: { send: async () => {} }, username: 'testbot',
    now: () => NOW, startedAt: NOW - 1, log: () => {} });
  await service.handleUpdate(dm(1, '/unwatch'));
  await service.handleUpdate(dm(2, '/watch'));
  await service.handleUpdate(dm(3, '/mode always'));
  assert.equal(store.xUsage(NOW).total, 100);
  assert.throws(() => budget.reserve('POST', '/2/tweets'), /post cap/);
});

const config = { ...readConfig({ TELEGRAM_BOT_TOKEN: 'test', OWNER_TELEGRAM_ID: '42' }),
  chatId: -100123, topicId: 17, raidarId: 999, dryRun: false, watchMode: 'always' };
function raid(id, date) {
  return { update_id: id, message: { message_id: id, date, chat: { id: config.chatId, type: 'supergroup' },
    message_thread_id: 17, from: { id: 999, is_bot: true }, text: '⚡ Raid Started!\nhttps://x.com/u/status/12345' } };
}
function dm(id, text, sender = 42, group = false) {
  return { update_id: id, message: { message_id: id, date: NOW, from: { id: sender, is_bot: false },
    chat: { id: group ? config.chatId : sender, type: group ? 'supergroup' : 'private' }, text } };
}

test('many genuine Raidar starts hit the gate, and owner resume cannot reset any request counts', async (t) => {
  const store = memory(t);
  let time = NOW, calls = 0;
  const budget = new XBudget(store, { maxPosts24h: 3 }, () => time);
  const x = new XClient(creds, async () => { calls++; return response(); }, budget);
  const service = new Service({ config, store, x, telegram: { send: async () => {} }, username: 'testbot',
    now: () => time, startedAt: NOW - 1, log: () => {} });
  store.set('text', 'Notification');
  for (let id = 1; id <= 30; id++) {
    time += 600;
    await service.handleUpdate(raid(id, time));
    await service.deliverOne();
  }
  assert.equal(calls, 3);
  const before = store.xUsage(time);
  await service.handleUpdate(dm(31, '/pause'));
  await service.handleUpdate(dm(32, '/resume', 7));
  assert.ok(store.get('posting_paused'));
  await service.handleUpdate(dm(33, '/resume', 42, true));
  assert.ok(store.get('posting_paused'));
  await service.handleUpdate(dm(34, '/resume'));
  assert.equal(store.get('posting_paused'), '');
  assert.deepEqual(store.xUsage(time), before);
  time++;
  await service.handleUpdate(raid(35, time));
  await service.deliverOne();
  assert.equal(calls, 3);
});

test('an actual X error pauses all subsequent raids until owner resume, without losing usage', async (t) => {
  const store = memory(t);
  let time = NOW, calls = 0;
  const budget = new XBudget(store, undefined, () => time);
  const x = new XClient(creds, async () => { calls++; return new Response('{}', { status: 403 }); }, budget);
  const service = new Service({ config, store, x, telegram: { send: async () => {} }, username: 'testbot',
    now: () => time, startedAt: NOW - 1, log: () => {} });
  store.set('text', 'Notification');
  await service.handleUpdate(raid(1, time));
  await service.deliverOne();
  assert.ok(store.get('posting_paused'));
  time += 600;
  await service.handleUpdate(raid(2, time));
  await service.deliverOne();
  assert.equal(calls, 1);
  assert.equal(store.xUsage(time).total, 1);
  await service.handleUpdate(dm(3, '/resume'));
  time++;
  x.fetcher = async () => { calls++; return response(); };
  await service.handleUpdate(raid(4, time));
  await service.deliverOne();
  assert.equal(calls, 2);
  assert.equal(store.xUsage(time).total, 2);
});
