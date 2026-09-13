import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from './config.js';
import { Store } from './store.js';
import { Telegram, XClient } from './api.js';
import { Service } from './service.js';
import { checkTelegramAccess } from './diagnostics.js';
import { XBudget } from './x-budget.js';

async function main() {
  const config = readConfig();
  if (process.argv.includes('--check')) {
    console.log(`Configuration valid. Mode: ${config.dryRun ? 'dry run' : 'live'}. No network requests made.`);
    return;
  }
  const telegram = new Telegram(config.token);
  const me = await telegram.call('getMe');
  const webhook = await telegram.call('getWebhookInfo');
  if (webhook.url) throw new Error('This bot has an active webhook. Remove it before using this long-polling service, or use a separate bot.');
  const access = await checkTelegramAccess(config, telegram, me);
  console.log(access.lines.join('\n'));
  if (!access.ok && !config.dryRun) throw new Error('Telegram access check failed. Correct the settings before running live.');
  const store = new Store(config.dbPath);
  const x = config.dryRun ? null : new XClient(config.x, fetch, new XBudget(store, config.xLimits));
  let account;
  try { account = x ? await x.verifyAccount() : null; }
  catch (error) { store.close(); throw error; }
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const service = new Service({ config, store, telegram, x, username: me.username });
  try {
    const recovered = store.recover();
    store.set('x_account', account ? `@${account.username} (${account.id})` : 'dry run');
    store.set('access_check', access.lines.join('\n'));
    store.set('access_ok', access.ok);
    console.log(`@${me.username} listening. Mode: ${config.dryRun ? 'DRY RUN' : 'LIVE'}.`);
    console.log(`Watching: ${service.watching ? 'ON' : 'OFF'}. Watch mode: ${service.watchMode}. Owner DM: /watch, /unwatch, /mode always, /mode manual.`);
    console.log(`Only raid starts after ${new Date(service.startedAt * 1000).toISOString()} can notify. Downtime raids and previous pending deliveries are skipped.`);
    if (!config.chatId || !config.raidarId) {
      console.log('Discovery mode: DM /start, then use /where in the raid topic to obtain IDs.');
    }
    if (recovered) await service.notify(`${recovered} interrupted X delivery attempt(s) marked uncertain. Posting is paused. Check /status and the X account, then use /resume for future raids. These attempts will not be posted again automatically.`);
    // Keep Telegram reception independent of slow X calls and rate-limit delays.
    const poll = async () => {
      while (!stop.signal.aborted) {
        let updates;
        try {
          // 25 seconds is the maximum idle wait, not a checking interval.
          // Telegram returns queued updates as they arrive. Process every update,
          // including a start immediately followed by its edit/reposted refresh.
          updates = await telegram.call('getUpdates', {
            offset: Number(store.get('offset') || 0), timeout: 25,
            allowed_updates: ['message', 'edited_message', 'callback_query'],
          }, stop.signal);
          service.lastPollAt = service.now();
          service.pollError = '';
        } catch (error) {
          if (stop.signal.aborted) break;
          service.pollError = error.message;
          if ([401, 409].includes(error.status)) throw new Error(`Telegram polling failed (${error.status}). Check the token and ensure only one instance is running.`);
          console.error(error.message);
          await delay(Math.max(1000, Math.min(30000, error.retryAt - Date.now() || 3000)), undefined, { signal: stop.signal }).catch(() => {});
          continue;
        }
        for (const update of updates) {
          if (stop.signal.aborted) break;
          await service.handleUpdate(update);
        }
      }
    };
    const worker = async () => {
      while (!stop.signal.aborted) {
        if (!await service.deliverOne()) await delay(200, undefined, { signal: stop.signal }).catch(() => {});
      }
    };
    const tasks = [poll(), worker()];
    try { await Promise.all(tasks); }
    finally { stop.abort(); await Promise.allSettled(tasks); }
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    store.close();
  }
}

main().catch((error) => {
  // API wrappers deliberately omit credentials, request URLs and response bodies.
  console.error(error.message);
  process.exitCode = 1;
});
