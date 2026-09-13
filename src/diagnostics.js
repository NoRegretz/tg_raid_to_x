export async function checkTelegramAccess(config, telegram, me) {
  const lines = [`Bot: @${me.username}`, `Configured chat: ${config.chatId ?? '(not set)'}`,
    `Configured topic: ${config.topicId ?? '(none; group without topics)'}`,
    `Configured Raidar ID: ${config.raidarId ?? '(not set)'}`];
  let ok = Boolean(config.chatId && config.raidarId);
  if (!config.chatId) {
    lines.push(`Set the chat ID returned by /where@${me.username} in your group.`);
    return { ok: false, lines };
  }
  let chat;
  try { chat = await telegram.call('getChat', { chat_id: config.chatId }); }
  catch (error) {
    lines.push(`Cannot access configured chat (${error.status || 'connection error'}). Check the ID and add this exact bot to the group. Use /where@${me.username} there to discover the actual ID.`);
    return { ok: false, lines };
  }
  lines.push(`Chat type: ${chat.type}; topics: ${chat.is_forum ? 'enabled' : 'disabled'}`);
  if (!['group', 'supergroup'].includes(chat.type)) {
    ok = false; lines.push('The configured chat must be a group or supergroup.');
  }
  if (chat.is_forum && config.topicId === null) {
    ok = false; lines.push('This group uses topics. Set TELEGRAM_TOPIC_ID using /where in the raid topic.');
  } else if (!chat.is_forum && config.topicId !== null) {
    ok = false; lines.push('This group has no topics. Leave TELEGRAM_TOPIC_ID blank.');
  }
  try {
    const member = await telegram.call('getChatMember', { chat_id: config.chatId, user_id: me.id });
    lines.push(`Bot membership: ${member.status}`);
    const present = ['creator', 'administrator', 'member'].includes(member.status) ||
      (member.status === 'restricted' && member.is_member);
    if (!present) { ok = false; lines.push('Add this bot to the configured group.'); }
    if (!['creator', 'administrator'].includes(member.status) && !me.can_read_all_group_messages) {
      ok = false; lines.push('Bot is not an admin and Group Privacy is enabled. Make it admin or disable Group Privacy in BotFather.');
    }
  } catch {
    ok = false; lines.push('Could not verify bot membership in this group.');
  }
  lines.push('Also enable Bot-to-Bot Communication Mode in BotFather; this check cannot verify that switch or actual Raidar delivery.');
  return { ok, lines };
}
