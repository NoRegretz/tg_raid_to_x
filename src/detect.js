function urlsFrom(message) {
  const urls = [];
  for (const [text, entities] of [[message.text, message.entities], [message.caption, message.caption_entities]]) {
    if (!text) continue;
    urls.push(...(text.match(/https?:\/\/[^\s<>]+/giu) || []));
    for (const entity of entities || []) {
      if (entity.type === 'text_link' && entity.url) urls.push(entity.url);
      if (entity.type === 'url') urls.push(text.slice(entity.offset, entity.offset + entity.length));
    }
  }
  for (const row of message.reply_markup?.inline_keyboard || []) {
    for (const button of row) if (button.url) urls.push(button.url);
  }
  return urls;
}

export function targetId(raw) {
  try {
    const url = new URL(raw);
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'mobile.x.com'].includes(url.hostname)) return null;
    const status = /^\/(?:[A-Za-z0-9_]+\/status|i\/web\/status)\/(\d+)(?:\/|$)/.exec(url.pathname);
    if (status) return status[1];
    if (/^\/intent\/(?:like|retweet|tweet)\/?$/.test(url.pathname)) {
      const id = url.searchParams.get('tweet_id') || url.searchParams.get('in_reply_to');
      if (/^\d+$/.test(id || '')) return id;
    }
  } catch { /* Not a usable URL. Never fetch untrusted message links. */ }
  return null;
}

export function detectRaid(update, config) {
  const message = update.message || update.edited_message;
  // Authenticate the sender using Telegram's numeric ID before inspecting text.
  // Display names, usernames, mentions, replies and forwarded origins grant no trust.
  if (!message || message.chat?.id !== config.chatId ||
      (message.message_thread_id ?? null) !== config.topicId ||
      (config.topicId === null && message.is_topic_message) || message.from?.id !== config.raidarId ||
      !message.from?.is_bot || message.sender_chat || message.forward_origin) return null;
  const text = message.text || message.caption || '';
  // Raidar's first line is a lifecycle header; quoted post content is not.
  const header = text.split(/\r?\n/u).find((line) => line.trim())?.trim() || '';
  const urls = urlsFrom(message);
  const targets = [...new Set(urls.map(targetId).filter(Boolean))];
  const ended = config.endPattern.test(header);
  const started = config.startPattern.test(header);
  if (!started && !ended) return { ignored: 'No start/completion header matched (refreshes are ignored).' };
  let identity;
  if (config.raidIdPattern) {
    // An explicitly configured ID must be present; never change key strategies mid-raid.
    const match = config.raidIdPattern.exec([text, ...urls].join('\n'));
    if (!match?.[1]) return { ignored: 'Configured raid ID was not found.' };
    identity = `run:${match[1]}`;
  } else {
    if (targets.length !== 1) return { ignored: `Expected one target X post; found ${targets.length}.` };
    // Only explicit start headers reach this point. Refresh message IDs never
    // become raid identities, while a later genuine start may reuse the target.
    identity = `start:${message.message_id}`;
  }
  return {
    key: `${config.chatId}:${config.topicId}:${identity}`,
    targetId: targets.length === 1 ? targets[0] : null,
    messageId: message.message_id, date: message.date,
    edited: Boolean(update.edited_message), ended,
    scope: `${config.chatId}:${config.topicId}:`,
  };
}
