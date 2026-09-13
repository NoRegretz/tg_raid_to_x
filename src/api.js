import OAuth from 'oauth-1.0a';
import { createHmac, createHash } from 'node:crypto';
import { XBudgetError } from './x-budget.js';

export class ApiError extends Error {
  constructor(message, { status = 0, uncertain = false, retryAt = 0 } = {}) {
    super(message); Object.assign(this, { status, uncertain, retryAt });
  }
}

export class Telegram {
  constructor(token, fetcher = fetch) { this.token = token; this.fetcher = fetcher; }
  async call(method, body = {}, signal) {
    let response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000),
      });
    } catch { throw new ApiError(`Telegram ${method} connection failed.`); }
    let data;
    try { data = await response.json(); }
    catch { throw new ApiError(`Telegram ${method} returned an unreadable response.`, { status: response.status }); }
    if (!response.ok || !data.ok) {
      throw new ApiError(`Telegram ${method} failed (${data.error_code || response.status}).`, {
        status: data.error_code || response.status,
        retryAt: data.parameters?.retry_after ? Date.now() + data.parameters.retry_after * 1000 : 0,
      });
    }
    return data.result;
  }
  send(ownerId, text, replyMarkup) {
    return this.call('sendMessage', { chat_id: ownerId, text, link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }
}

export class XClient {
  constructor(config, fetcher = fetch, budget) {
    this.config = config; this.fetcher = fetcher; this.budget = budget;
    this.oauth = new OAuth({
      consumer: { key: config.key, secret: config.secret }, signature_method: 'HMAC-SHA1',
      hash_function: (base, key) => createHmac('sha1', key).update(base).digest('base64'),
    });
  }
  async request(method, path, body) {
    if (!this.budget) throw new XBudgetError('X client requires a persistent request budget.');
    this.budget.reserve(method, path);
    const url = `https://api.x.com${path}`;
    const auth = this.oauth.toHeader(this.oauth.authorize({ url, method }, {
      key: this.config.accessToken, secret: this.config.accessSecret,
    }));
    let response;
    try {
      response = await this.fetcher(url, {
        method, headers: { ...auth, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20000), redirect: 'error',
      });
    } catch { throw new ApiError('X connection failed; delivery outcome is unknown.', { uncertain: method === 'POST' }); }
    if (!response.ok) {
      const retrySeconds = Number(response.headers.get('retry-after'));
      const reset = Number(response.headers.get('x-rate-limit-reset'));
      throw new ApiError(`X API rejected the request (HTTP ${response.status}).`, {
        status: response.status,
        uncertain: method === 'POST' && (response.status >= 500 || response.status === 408),
        retryAt: response.status === 429 ? Math.max(Date.now() + Math.max(1, retrySeconds || 60) * 1000, reset * 1000) : 0,
      });
    }
    let data;
    try { data = await response.json(); }
    catch { throw new ApiError('X response could not be read; delivery outcome is unknown.', { uncertain: method === 'POST' }); }
    if (!data.data?.id) throw new ApiError('X response omitted the result ID.', { uncertain: method === 'POST' });
    return data.data;
  }
  async verifyAccount() {
    const account = await this.getAccount();
    if (account.id !== this.config.expectedUserId) throw new Error('X account ID mismatch. Check X_EXPECTED_USER_ID and user access tokens.');
    return account;
  }
  async getAccount() {
    const fingerprint = createHash('sha256').update(JSON.stringify([
      this.config.key, this.config.secret, this.config.accessToken, this.config.accessSecret,
    ])).digest('hex');
    const store = this.budget?.store;
    let cached;
    try { cached = JSON.parse(store?.get('x_account_cache') || 'null'); } catch { /* Cache miss. */ }
    if (cached?.fingerprint === fingerprint && cached.account?.id && cached.account?.username) return cached.account;
    const account = await this.request('GET', '/2/users/me');
    if (store) store.set('x_account_cache', JSON.stringify({ fingerprint, account: { id: account.id, username: account.username } }));
    return account;
  }
  post(text) { return this.request('POST', '/2/tweets', { text }); }
}
