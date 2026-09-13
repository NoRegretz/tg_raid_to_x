import { detectRaid } from './detect.js';
import { parseCommand, renderText, validateText, validateTemplate } from './text.js';
import { DEFAULT_X_LIMITS } from './x-budget.js';
import { OwnerPanel, isOwnerDM, CONTROLS_KEYBOARD } from './owner-panel.js';

export class Service {
  constructor({ config, store, telegram, x, username, now = () => Math.floor(Date.now() / 1000), startedAt = now(), log = console.log }) {
    Object.assign(this, { config, store, telegram, x, username, now, startedAt, log });
    this.bootedAt = startedAt;
    this.watchMode = store.get('watch_mode') || config.watchMode || 'manual';
    // Restore the owner's choice, but always use a fresh event cutoff below.
    // Older databases without a saved choice keep the mode's initial default.
    this.watching = this.watchMode === 'always' || store.get('watch_enabled') === 'true';
    this.panel = new OwnerPanel(this);
    // Never resume an old notification outbox on a new process session, even if
    // the previous process stopped only a moment ago or the clock moved backward.
    const skipped = store.skipPendingFromPreviousSession();
    if (skipped) log(`Skipped ${skipped} pending notification(s) from the previous bot session.`);
  }
  async notify(text) {
    try { await this.telegram.send(this.config.ownerId, text, CONTROLS_KEYBOARD); }
    catch { this.log('Owner DM could not be delivered. Check /status after starting the bot in DM.'); }
  }
  async handleUpdate(update) {
    const offset = Number(this.store.get('offset') || 0);
    if (update.update_id < offset) return;
    if (update.callback_query) {
      await this.panel.callback(update);
      return;
    }
    const incoming = update.message || update.edited_message;
    if (incoming && ['group', 'supergroup'].includes(incoming.chat?.type)) {
      // Metadata only: enough to distinguish missing delivery from a filter mismatch.
      // This is diagnostic evidence, never permission to trigger a notification.
      const info = `${new Date(this.now() * 1000).toISOString()}: chat=${incoming.chat.id}, topic=${incoming.message_thread_id ?? 'none'}, sender=${incoming.from?.id ?? 'anonymous'}, bot=${Boolean(incoming.from?.is_bot)}`;
      if (incoming.chat.id === this.config.chatId) this.store.set('last_group_update', info);
      if (incoming.from?.id === this.config.raidarId && incoming.from?.is_bot && !incoming.forward_origin && !incoming.sender_chat) {
        this.store.set('last_raidar_update', info);
      }
    }
    const message = update.message;
    const command = message && !message.from?.is_bot && !message.forward_origin && !message.sender_chat && !message.via_bot
      ? parseCommand(message.text, this.username) : null;
    if (isOwnerDM(message, this.config.ownerId) && (!command || ['start', 'menu', 'help', 'guide'].includes(command.name))) {
      if (command) {
        this.panel.invalidate();
        this.store.set('offset', update.update_id + 1);
        await this.notify('Your private owner controls. Use the buttons below, or 🎛 Controls beside the message box to reopen them.');
        await this.panel.show(command.name === 'guide' ? 'guide' : 'home');
      } else await this.panel.text(message, update.update_id);
      return;
    }
    if (command && message.from.id === this.config.ownerId) {
      this.panel.invalidate();
      const replies = this.store.transaction(() => {
        const replies = this.command(message, command);
        this.store.set('offset', update.update_id + 1);
        return replies;
      });
      for (const reply of replies) await this.notify(reply);
      return;
    }
    this.store.transaction(() => {
      const raid = detectRaid(update, this.config);
      if (raid) {
        const observation = raid.ignored || `Matched ${raid.key}${raid.ended ? ' (ended)' : raid.edited ? ' (edit)' : ''}`;
        this.store.set('last_observed', `${new Date(this.now() * 1000).toISOString()}: ${observation}`);
        if (!raid.ignored) {
          if (raid.ended) this.store.cancelPending(raid, Boolean(this.config.raidIdPattern));
          const existing = this.store.getRaid(raid.key);
          // Preserve suppression for a start already recorded by the initial
          // target-keyed implementation, without blocking later new starts.
          const legacy = !this.config.raidIdPattern && this.store.getRaid(`${raid.scope}post:${raid.targetId}`);
          if (!existing && !(legacy && legacy.message_id === raid.messageId)) {
            let text = this.store.get('text') || '';
            let status = 'pending';
            let detail = '';
            if (raid.ended || raid.edited) {
              status = 'skipped'; detail = 'First observation was an edit or completion, not a new raid.';
            } else if (!Number.isSafeInteger(raid.date) || this.now() - raid.date > this.config.maxAge || raid.date > this.now() + 30) {
              status = 'skipped'; detail = 'Old or invalid event timestamp.';
            } else if (!this.watching) {
              status = 'skipped'; detail = 'Watching is off. This raid will not be sent when watching starts.';
            } else if (raid.date <= this.startedAt) {
              // Telegram dates have whole-second precision. Reject the startup
              // second too; its earlier messages cannot be distinguished safely.
              status = 'skipped'; detail = 'Raid started before this bot session was listening (or in the same second).';
            } else if (this.store.get('posting_paused')) {
              status = 'skipped'; detail = 'Posting is paused. This raid will not be sent after resuming.';
            } else {
              try {
                text = renderText(text, raid);
                if (!validateText(text).valid) throw new Error('Set valid notification text using /text in owner DM.');
              } catch (error) { status = 'failed'; detail = error.message; }
            }
            this.store.add(raid, text, this.config.dryRun ? 'dry' : 'live', status, detail);
            this.log(`Raid ${raid.key}: ${status}${detail ? ` (${detail})` : ''}`);
          }
        }
      }
      // Identity and update offset commit together, before acknowledging Telegram.
      this.store.set('offset', update.update_id + 1);
    });
  }
  command(message, command) {
    if (command.name === 'where') {
      const replied = message.reply_to_message;
      return [`Chat ID: ${message.chat.id}\nTopic ID: ${message.message_thread_id || '(none; leave TELEGRAM_TOPIC_ID blank for a group without topics)'}\nYour ID: ${message.from.id}` +
        (replied ? `\nReplied sender ID: ${replied.from?.id || '(anonymous)'}\nReplied sender is bot: ${Boolean(replied.from?.is_bot)}` : '\nReply to a Raidar message with /where to get its sender ID.')];
    }
    if (message.chat.type !== 'private' || message.chat.id !== this.config.ownerId) return [];
    if (['watch', 'unwatch', 'mode'].includes(command.name)) {
      const mode = command.body?.trim();
      if (command.name === 'mode' && !['manual', 'always'].includes(mode)) {
        return [`Watch mode: ${this.watchMode}. Watching: ${this.watching ? 'ON' : 'OFF'}.\nUse /mode manual or /mode always.`];
      }
      const enable = command.name === 'watch' || (command.name === 'mode' && mode === 'always');
      // An activation left in Telegram's offline queue must not re-arm a VPS.
      if (enable && (!Number.isSafeInteger(message.date) || message.date <= this.bootedAt ||
        this.now() - message.date > this.config.maxAge || message.date > this.now() + 30)) {
        return ['Old watch activation ignored. Send the command again now that the bot is running.'];
      }
      if (command.name === 'mode' || command.name === 'unwatch') {
        this.watchMode = command.name === 'unwatch' ? 'manual' : mode;
        this.store.set('watch_mode', this.watchMode);
      }
      if (enable && !this.watching) {
        this.store.skipPending('Skipped when enabling watch; only new starts may notify.');
        this.startedAt = this.now();
      } else if (!enable) {
        this.store.skipPending('Watching stopped before delivery.');
      }
      this.watching = enable;
      this.store.set('watch_mode', this.watchMode);
      this.store.set('watch_enabled', enable);
      const paused = this.store.get('posting_paused');
      return [`Watching: ${enable ? 'ON — only starts after this cutoff can notify: ' + new Date(this.startedAt * 1000).toISOString() : 'OFF — queued notifications skipped'}.\nWatch mode: ${this.watchMode}. ${this.watchMode === 'manual' ? 'Your ON/OFF choice is saved across restarts.' : 'Future process restarts watch automatically.'}\n${paused ? 'Posting remains paused: ' + paused + ' Fix the cause, then /resume.' : 'Usage counters and limits are unchanged.'}${enable ? '\nWait until the next second before starting a raid.' : '\nAn X request already in flight cannot be recalled.'}`];
    }
    if (command.name === 'pause') {
      this.store.set('posting_paused', 'Paused by owner.');
      this.store.skipPending('Paused by owner before delivery.');
      return ['Posting paused and queued notifications skipped. An X request already in flight cannot be recalled. /resume allows only future raids.'];
    }
    if (command.name === 'resume') {
      this.store.skipPending('Skipped when resuming; only new raids may notify.');
      this.store.set('posting_paused', '');
      this.startedAt = this.now();
      return [`Posting pause cleared for new raids after this second. ${this.watching ? 'Watching is ON.' : 'Watching is OFF; send /watch to enable it.'} Request limits and previous usage have not been reset.`];
    }
    if (command.name === 'limits') {
      const limits = { ...DEFAULT_X_LIMITS, ...this.config.xLimits };
      const usage = this.store.xUsage(this.now());
      return [`Watching: ${this.watching ? "ON" : "OFF"} (${this.watchMode})\nPosting: ${this.store.get('posting_paused') || 'enabled'}\nLifetime X requests: ${usage.total}/${limits.maxRequestsTotal}\nX requests in last 24h: ${usage.requests24h}/${limits.maxRequests24h}\nPost attempts in last 24h: ${usage.posts24h}/${limits.maxPosts24h}\nMinimum post interval: ${limits.minPostInterval} seconds\nCounts include failed/uncertain requests and account lookups. Dry runs use no X requests.\nChange limits in Railway Variables or the VPS deployment environment; /resume never resets usage.`];
    }
    if (command.name === 'text') {
      const result = validateTemplate(command.body);
      if (!result.valid) return [`Not saved. ${result.error}\n\nUsage: /text followed by a space or newline, then the entire notification.`];
      this.store.set('text', command.body);
      return [`Saved (${result.length}/280 weighted characters). Use /preview to see the exact text.`];
    }
    if (command.name === 'preview') return [this.store.get('text') || 'No text saved. Send /text followed by your notification.'];
    if (command.name === 'diagnose') return [this.store.get('access_check') || 'Restart the bot to run the access check.'];
    if (command.name === 'status') {
      const recent = this.store.recent().map((r) => `${r.status}: ${r.key}\n${r.x_post_id ? `https://x.com/i/web/status/${r.x_post_id}` : r.detail || '(queued)'}`).join('\n\n');
      return [`Watching: ${this.watching ? "ON" : "OFF"} (${this.watchMode})\nPosting pause: ${this.store.get("posting_paused") || "none"}\nMode: ${this.config.dryRun ? 'DRY RUN (no X posts)' : 'LIVE'}\nAccepting starts after: ${new Date(this.startedAt * 1000).toISOString()}\nChat: ${this.config.chatId ?? 'not configured'}\nTopic: ${this.config.topicId ?? 'none (group without topics)'}\nRaidar: ${this.config.raidarId ?? 'not configured'}\nText: ${this.store.get('text') ? 'saved' : 'not set'}\nX account: ${this.store.get('x_account') || 'not connected'}\n\nLast Raidar update received:\n${this.store.get('last_raidar_update') || 'None yet'}\n\nLast configured-group update received:\n${this.store.get('last_group_update') || 'None yet'}\n\nLast detection:\n${this.store.get('last_observed') || 'None yet'}\n\nRecent raids:\n${recent || 'None yet'}`.slice(0, 4000)];
    }
    return ['Raid notifier commands (owner DM only):\n/watch — watch future raid starts\n/unwatch — stop watching (manual mode)\n/mode manual — stop watching; remember future ON/OFF choices\n/mode always — watch now and after restarts\n/text <your full notification> — save text\n/preview — show saved text/template\n/status — settings and delivery results\n/limits — X request counts and pause status\n/pause — stop posting\n/resume — allow future raids (does not reset limits)\n/diagnose — startup Telegram access check\n\nOptional placeholders: {raid_url} for the target X post; {started_at} for the event time in UTC.\n\nIn the raid topic, reply to Raidar with /where to receive setup IDs here.\nSpaces, line breaks and standard emojis are preserved. Telegram bold/italic/custom emoji formatting is not converted to X rich text.'];
  }
  async deliverOne() {
    const raid = this.store.claim(this.now());
    if (!raid) return false;
    if (!this.watching) {
      this.store.update(raid.key, 'skipped', 'Watching is off.');
      return true;
    }
    if (this.store.get('posting_paused')) {
      this.store.update(raid.key, 'skipped', 'Posting is paused.');
      return true;
    }
    if (raid.created_at <= this.startedAt) {
      this.store.update(raid.key, 'skipped', 'Raid predates this bot session; no catch-up posting.');
      return true;
    }
    if (this.now() - raid.created_at > this.config.maxAge) {
      this.store.update(raid.key, 'skipped', 'Notification expired before delivery.');
      await this.notify(`Raid notification expired before delivery:\n${raid.key}`);
      return true;
    }
    // A mode change must never turn queued dry-run work into a real post.
    if (raid.mode !== (this.config.dryRun ? 'dry' : 'live')) {
      this.store.update(raid.key, 'skipped', 'Delivery mode changed after detection.');
      return true;
    }
    if (this.config.dryRun) {
      this.store.update(raid.key, 'dry_run', 'Detected successfully; no X request sent.');
      await this.notify(`DRY RUN — one raid detected:\n${raid.key}\n\nThe following text would be posted to X:`);
      await this.notify(raid.text);
      return true;
    }
    let post;
    try { post = await this.x.post(raid.text); }
    catch (error) {
      if (error.localBlock) {
        this.store.update(raid.key, 'skipped', error.message);
        // A spammed Raidar start cannot also spam the owner's DMs indefinitely.
        if (this.store.get('x_block_notice') !== error.message) {
          this.store.set('x_block_notice', error.message);
          await this.notify(`X request blocked locally; no X call was sent.\n${error.message}\nUse /limits to view usage.`);
        }
        return true;
      }
      // Never blindly repeat a POST after a timeout, 5xx, lost response or crash.
      const uncertain = error.uncertain !== false;
      const status = uncertain ? 'uncertain' : 'failed';
      const detail = uncertain ? 'X delivery may have succeeded. Inspect the X account; no automatic retry.'
        : `X rejected delivery (HTTP ${error.status || 'unknown'}). Check app permissions, credentials, usage limits and post duplication restrictions.`;
      this.store.update(raid.key, status, detail);
      this.store.set('posting_paused', detail);
      this.store.skipPending('Skipped because an X posting error paused delivery.');
      this.log(`Raid ${raid.key}: ${status}`);
      await this.notify(`Raid notification ${status}:\n${raid.key}\n${detail}\nPosting is now paused, including after restart. Fix the cause and use /resume for future raids. There are no automatic retries.`);
      return true;
    }
    // Persist success before owner DM; a failed DM never triggers another X post.
    this.store.update(raid.key, 'posted', '', post.id);
    this.store.set('x_block_notice', '');
    this.log(`Raid ${raid.key}: posted ${post.id}`);
    await this.notify(`Raid notification posted:\nhttps://x.com/i/web/status/${post.id}`);
    return true;
  }
}
