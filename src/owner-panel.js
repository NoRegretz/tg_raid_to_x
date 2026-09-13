import { randomBytes } from 'node:crypto';
import { DEFAULT_X_LIMITS } from './x-budget.js';
import { validateTemplate } from './text.js';
import { OWNER_GUIDE } from './owner-guide.js';

export const CONTROLS_KEYBOARD = { keyboard: [[{ text: '🎛 Controls' }]], resize_keyboard: true, is_persistent: true };
const PANEL_AGE = 15 * 60;
const ACTIONS = new Set(['home', 'watch', 'unwatch', 'manual', 'always', 'text', 'preview', 'health', 'limits', 'history', 'pause', 'resume', 'cancel', ...OWNER_GUIDE.map(page => page.id)]);

export function isOwnerDM(message, ownerId) {
  return message?.from?.id === ownerId && !message.from.is_bot && message.chat?.type === 'private' &&
    message.chat.id === ownerId && !message.forward_origin && !message.sender_chat && !message.via_bot;
}

export class OwnerPanel {
  constructor(service) { this.service = service; this.active = null; this.editing = null; }
  invalidate() { this.active = null; this.editing = null; }
  summary() {
    const s = this.service, paused = s.store.get('posting_paused');
    return `🎛 Raid notifier\n\nWatching: ${s.watching ? '🟢 ON' : '⚪ OFF'}\nSchedule: ${s.watchMode === 'always' ? 'Always on — resumes after restart' : 'Manual — remembers ON/OFF after restart'}\nDelivery: ${s.config.dryRun ? '🧪 Dry run — no X calls' : 'LIVE — posts to X'}\nPosting: ${paused ? '⛔ Paused — ' + paused : 'No error pause'}\nNotification text: ${s.store.get('text') ? '✅ Saved' : '⚠️ Not set'}\nX account: ${s.store.get('x_account') || 'Not verified in this session'}\n\nUpdated: ${new Date(s.now() * 1000).toISOString()}\nUse Refresh for the latest state.`;
  }
  health() {
    const s = this.service, limits = { ...DEFAULT_X_LIMITS, ...s.config.xLimits }, usage = s.store.xUsage(s.now());
    const issues = [];
    if (s.pollError) issues.push('Telegram polling has an error.');
    if (!s.lastPollAt || s.now() - s.lastPollAt > 60) issues.push('No recent successful Telegram poll recorded.');
    if (s.store.get('access_ok') !== 'true') issues.push('Telegram startup access is not confirmed.');
    if (!s.watching) issues.push('Watching is off.');
    if (s.store.get('posting_paused')) issues.push('Posting is paused: ' + s.store.get('posting_paused'));
    if (!s.config.chatId || !s.config.raidarId) issues.push('Group or Raidar ID is missing.');
    if (!validateTemplate(s.store.get('text') || '').valid) issues.push('Save valid notification text.');
    if (!s.config.dryRun) {
      if (usage.total >= limits.maxRequestsTotal || usage.requests24h >= limits.maxRequests24h || usage.posts24h >= limits.maxPosts24h) issues.push('An X request limit has been reached.');
      if (usage.lastPost !== null && s.now() - usage.lastPost < limits.minPostInterval) issues.push('Posting cooldown is active.');
      if (Number(s.store.get('x_request_clock') || 0) > s.now()) issues.push('Clock moved backward; X requests are blocked.');
    }
    return `🩺 Health snapshot\n\n${issues.length ? issues.join('\n') : 'No local posting blockers found.'}\n\nProcess uptime: ${Math.max(0, s.now() - s.bootedAt)} seconds\nTelegram last successful poll: ${s.lastPollAt ? new Date(s.lastPollAt * 1000).toISOString() : 'Not recorded yet'}\nPolling error: ${s.pollError || 'None recorded'}\nDatabase: readable\nX account (startup/cache): ${s.store.get('x_account') || 'Not verified in this session'}\n\nLast Raidar update:\n${s.store.get('last_raidar_update') || 'None received yet — reception is unconfirmed.'}\n\nTelegram access check (at startup):\n${s.store.get('access_check') || 'No check recorded.'}\n\nThis button makes no X requests. It cannot verify current X credentials, balance, or delivery availability. An offline bot cannot answer buttons.`;
  }
  async show(view = 'home', notice = '', messageId) {
    const s = this.service, token = randomBytes(12).toString('hex');
    const button = (text, action) => ({ text, callback_data: `p:${token}:${action}` });
    let text = this.summary();
    let rows = [
      [button(s.watching ? '🟢 Watching ON · Stop' : '⚪ Watching OFF · Start', s.watching ? 'unwatch' : 'watch')],
      [button(`${s.watchMode === 'manual' ? '✅ ' : ''}Manual`, 'manual'), button(`${s.watchMode === 'always' ? '✅ ' : ''}Always on`, 'always')],
      [button('✏️ Edit text', 'text'), button('👁 Preview text', 'preview')],
      [button('🩺 Health', 'health'), button('📊 Usage & limits', 'limits')],
      [button('📋 Recent raids', 'history'), button('🔄 Refresh', 'home')],
      [button('📖 Setup & usage guide', 'guide')],
      [button(s.store.get('posting_paused') ? '▶️ Clear posting pause' : '⏸ Pause posting', s.store.get('posting_paused') ? 'resume' : 'pause')],
    ];
    if (view === 'text') {
      text = '✏️ Edit notification\n\nSend your complete new text as your next message within 10 minutes. Spaces, emojis and line breaks are kept exactly. Maximum: 280 X weighted characters.\n\nOptional: {raid_url} and {started_at}.\nYour saved text stays in use until a valid replacement is saved.\n\nTap Cancel to keep the current text.';
      rows = [[button('Cancel editing', 'cancel')]];
    } else if (view !== 'home') {
      const owner = { from: { id: s.config.ownerId }, chat: { id: s.config.ownerId, type: 'private' } };
      if (view === 'health') text = this.health();
      if (view === 'limits') text = s.command(owner, { name: 'limits' })[0];
      if (view === 'history') text = s.command(owner, { name: 'status' })[0];
      if (view === 'preview') text = s.store.get('text') || 'No notification text saved yet.';
      rows = [[button('⬅️ Controls', 'home'), button('🔄 Refresh', view)]];
    }
    const guideIndex = OWNER_GUIDE.findIndex(page => page.id === view);
    if (guideIndex >= 0) {
      text = OWNER_GUIDE[guideIndex].text;
      const navigation = [];
      if (guideIndex > 0) navigation.push(button('⬅️ Previous', OWNER_GUIDE[guideIndex - 1].id));
      if (guideIndex < OWNER_GUIDE.length - 1) navigation.push(button('Next ➡️', OWNER_GUIDE[guideIndex + 1].id));
      rows = [navigation, [button('🎛 Controls', 'home')]];
    }
    if (notice) {
      notice = notice.replaceAll('/watch', 'Start watching').replaceAll('/resume', 'Clear posting pause')
        .replaceAll('/limits', 'Usage & limits');
      text = `${notice}\n\n${text}`;
    }
    const markup = { inline_keyboard: rows };
    // Bind callbacks to this process, the latest panel and its exact message.
    this.active = null;
    try {
      let sent;
      if (messageId) {
        try { sent = await s.telegram.call('editMessageText', { chat_id: s.config.ownerId, message_id: messageId,
          text: text.slice(0, 4000), reply_markup: markup, link_preview_options: { is_disabled: true } }); }
        catch { messageId = undefined; }
      }
      if (!messageId) sent = await s.telegram.send(s.config.ownerId, text.slice(0, 4000), markup);
      const id = messageId || sent?.message_id;
      if (id) this.active = { token, messageId: id, at: s.now(), actions: new Set(rows.flat().map(b => b.callback_data.split(':')[2])) };
    } catch { s.log('Owner controls could not be delivered. Send any message in owner DM to reopen them.'); }
  }
  async callback(update) {
    const s = this.service, q = update.callback_query;
    const owner = q.from?.id === s.config.ownerId && !q.from.is_bot &&
      q.message?.chat?.type === 'private' && q.message.chat.id === s.config.ownerId &&
      !q.message.forward_origin && !q.message.sender_chat && !q.message.via_bot && !q.inline_message_id;
    const [, token, action] = /^p:([a-f0-9]{24}):([a-z]+)$/.exec(q.data || '') || [];
    const valid = owner && this.active && token === this.active.token && q.message.message_id === this.active.messageId &&
      s.now() >= this.active.at && s.now() - this.active.at <= PANEL_AGE && ACTIONS.has(action) && this.active.actions.has(action);
    let view = 'home', notice = '';
    s.store.transaction(() => {
      if (valid) {
        this.active = null; // Consume before any asynchronous work or action.
        this.editing = null;
        if (['watch', 'unwatch', 'manual', 'always', 'pause', 'resume'].includes(action)) {
          const name = ['manual', 'always'].includes(action) ? 'mode' : action;
          notice = s.command({ from: q.from, chat: q.message.chat, date: s.now() }, { name, body: name === 'mode' ? action : '' }).join('\n');
        } else if (action === 'text') {
          this.editing = { after: s.now(), messageId: q.message.message_id };
          view = 'text';
        } else if (['preview', 'health', 'limits', 'history', ...OWNER_GUIDE.map(page => page.id)].includes(action)) view = action;
      }
      s.store.set('offset', update.update_id + 1);
    });
    try { await s.telegram.call('answerCallbackQuery', { callback_query_id: q.id,
      text: !owner ? 'Owner-only controls.' : valid ? 'Updated' : 'Panel expired. Opening current controls.', show_alert: !owner }); }
    catch { /* An expired callback acknowledgement must never retry an action. */ }
    if (owner) {
      if (!valid) this.editing = null;
      await this.show(view, notice, valid ? q.message.message_id : undefined);
    }
  }
  async text(message, updateId) {
    const s = this.service, editing = this.editing;
    let notice = '';
    const menu = message.text === '🎛 Controls';
    const usable = editing && s.now() >= editing.after && s.now() - editing.after <= 600 && message.date >= editing.after &&
      message.message_id > editing.messageId && message.date <= s.now() + 30;
    if (editing && !menu) {
      if (!usable) notice = 'Text editing expired or the message is old. Tap Edit text again.';
      else if (typeof message.text !== 'string') notice = 'Send a text message, or tap Cancel.';
      else {
        const result = validateTemplate(message.text);
        if (result.valid) {
          s.store.transaction(() => { s.store.set('text', message.text); s.store.set('offset', updateId + 1); });
          notice = `✅ Notification saved (${result.length}/280 weighted characters).`;
          this.editing = null;
        } else notice = `Not saved. ${result.error}`;
      }
    }
    if (!usable || menu) this.editing = null;
    s.store.set('offset', updateId + 1);
    await this.show(this.editing ? 'text' : 'home', notice);
  }
}
