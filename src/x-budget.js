export const DEFAULT_X_LIMITS = Object.freeze({
  maxRequestsTotal: 10000,
  maxRequests24h: 120,
  maxPosts24h: 100,
  minPostInterval: 0,
});

export class XBudgetError extends Error {
  constructor(message) {
    super(message);
    this.localBlock = true;
    this.uncertain = false;
  }
}

export class XBudget {
  constructor(store, limits = DEFAULT_X_LIMITS, now = () => Math.floor(Date.now() / 1000)) {
    this.store = store;
    this.limits = { ...DEFAULT_X_LIMITS, ...limits };
    this.now = now;
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < (key === 'minPostInterval' ? 0 : 1)) throw new Error(`Invalid X request limit: ${key}`);
    }
  }
  reserve(method, path) {
    if (!((method === 'GET' && path === '/2/users/me') || (method === 'POST' && path === '/2/tweets'))) {
      throw new XBudgetError('X endpoint is not allowed by this bot.');
    }
    const post = method === 'POST';
    this.store.transaction(() => {
      const time = this.now();
      const last = this.store.get('x_request_clock');
      if (last && time < Number(last)) throw new XBudgetError('System clock moved backward; X requests are blocked until it catches up.');
      if (post && this.store.get('posting_paused')) throw new XBudgetError('X posting is paused.');
      const counts = this.store.xUsage(time);
      if (counts.total >= this.limits.maxRequestsTotal) throw new XBudgetError('Lifetime X request cap reached. Raise X_MAX_REQUESTS_TOTAL in deployment settings to explicitly approve more usage.');
      if (counts.requests24h >= this.limits.maxRequests24h) throw new XBudgetError('Rolling 24-hour X request cap reached.');
      if (post && counts.posts24h >= this.limits.maxPosts24h) throw new XBudgetError('Rolling 24-hour X post cap reached.');
      if (post && counts.lastPost !== null && time - counts.lastPost < this.limits.minPostInterval) {
        throw new XBudgetError('Posting cooldown is active. This raid will not be queued for later.');
      }
      // Commit BEFORE touching the network. Failures and uncertain/crashed calls
      // spend a reservation too; no result path refunds or deletes this ledger.
      this.store.db.prepare('INSERT INTO x_requests (created_at,method,path) VALUES (?,?,?)').run(time, method, path);
      this.store.set('x_request_clock', time);
    });
  }
}
