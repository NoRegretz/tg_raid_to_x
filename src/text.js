import twitterText from 'twitter-text';

export function parseCommand(text, botUsername) {
  if (typeof text !== 'string') return null;
  const match = /^\/([a-z]+)(?:@([a-z0-9_]+))?(?=$|\s)/i.exec(text);
  if (!match || (match[2] && match[2].toLowerCase() !== botUsername.toLowerCase())) return null;
  // Remove exactly one separator, never trim/split/rejoin the owner's text.
  const rest = text.slice(match[0].length);
  const body = rest.startsWith('\r\n') ? rest.slice(2) : /^\s/u.test(rest) ? rest.slice(1) : rest;
  return { name: match[1].toLowerCase(), body };
}

export function validateText(text) {
  const parsed = twitterText.parseTweet(text);
  return {
    valid: text.trim().length > 0 && parsed.valid,
    length: parsed.weightedLength,
    error: `Text must be nonempty and valid for a standard X post (280 weighted characters). Current count: ${parsed.weightedLength}.`,
  };
}

// Only these explicit placeholders are expanded. All other text is untouched.
export function renderText(text, raid) {
  if (text.includes('{raid_url}') && !raid.targetId) throw new Error('Template uses {raid_url}, but no unique target X post was detected.');
  return text.replaceAll('{raid_url}', `https://x.com/i/web/status/${raid.targetId || '0'}`)
    .replaceAll('{started_at}', new Date(raid.date * 1000).toISOString());
}

export function validateTemplate(text) {
  return validateText(renderText(text, { targetId: '1234567890123456789', date: 0 }));
}
