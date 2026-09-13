import { DEFAULT_X_LIMITS } from './x-budget.js';

export const DEFAULT_START_PATTERN = '^[\\s\\p{Emoji_Presentation}\\uFE0F\\u200D]*Raid[ \\t]+Started[ \\t]*!?[ \\t]*$';

export function readXLimits(env = process.env) {
  const names = { maxRequestsTotal: 'X_MAX_REQUESTS_TOTAL', maxRequests24h: 'X_MAX_REQUESTS_24H',
    maxPosts24h: 'X_MAX_POSTS_24H', minPostInterval: 'X_MIN_POST_INTERVAL_SECONDS' };
  return Object.fromEntries(Object.entries(names).map(([key, name]) => {
    const raw = env[name]?.trim();
    const value = raw ? Number(raw) : DEFAULT_X_LIMITS[key];
    if (!Number.isSafeInteger(value) || value < (key === 'minPostInterval' ? 0 : 1)) {
      throw new Error(`${name} must be a ${key === 'minPostInterval' ? 'nonnegative' : 'positive'} integer.`);
    }
    return [key, value];
  }));
}

export function readConfig(env = process.env) {
  const required = (name) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Set ${name} in .env.`);
    return value;
  };
  const integer = (name, { negative = false, optional = false } = {}) => {
    const raw = env[name]?.trim();
    if (!raw && optional) return null;
    if (!raw || !/^-?\d+$/.test(raw)) throw new Error(`${name} must be a numeric ID.`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || (negative ? value >= 0 : value <= 0)) {
      throw new Error(`${name} must be a safe ${negative ? 'negative' : 'positive'} integer.`);
    }
    return value;
  };
  const pattern = (name, fallback) => {
    const source = env[name]?.trim() || fallback;
    if (!source) return null;
    try { return new RegExp(source, 'iu'); }
    catch { throw new Error(`${name} is not a valid regular expression.`); }
  };
  const dryValue = env.DRY_RUN ?? 'true';
  if (!['true', 'false'].includes(dryValue)) throw new Error('DRY_RUN must be true or false.');
  const dryRun = dryValue === 'true';
  const watchMode = env.WATCH_MODE?.trim() || 'manual';
  if (!['manual', 'always'].includes(watchMode)) throw new Error('WATCH_MODE must be manual or always.');
  const chatId = integer('TELEGRAM_CHAT_ID', { negative: true, optional: dryRun });
  // Blank selects messages without a topic, not every topic in a forum.
  // Startup checks getChat so a forum cannot silently run with this setting.
  const topicId = integer('TELEGRAM_TOPIC_ID', { optional: true });
  const raidarId = integer('RAIDAR_BOT_ID', { optional: dryRun });
  const maxAge = Number(env.MAX_EVENT_AGE_SECONDS || 300);
  if (!Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 86400) {
    throw new Error('MAX_EVENT_AGE_SECONDS must be between 1 and 86400.');
  }
  return {
    token: required('TELEGRAM_BOT_TOKEN'), ownerId: integer('OWNER_TELEGRAM_ID'),
    chatId, topicId, raidarId, dryRun, watchMode, maxAge, xLimits: readXLimits(env),
    dbPath: env.DATABASE_PATH || './data/raid-notifier.sqlite',
    startPattern: pattern('RAID_START_PATTERN', DEFAULT_START_PATTERN),
    endPattern: pattern('RAID_END_PATTERN', '\\b(?:raid\\s+(?:(?:is|has)\\s+)?(?:completed?|finished|ended|stopped|cancelled|canceled)|(?:completed?|finished|ended|stopped|cancelled|canceled)\\s+raid)\\b'),
    raidIdPattern: pattern('RAID_ID_PATTERN', null),
    x: dryRun ? null : {
      key: required('X_API_KEY'), secret: required('X_API_SECRET'),
      accessToken: required('X_ACCESS_TOKEN'), accessSecret: required('X_ACCESS_TOKEN_SECRET'),
      expectedUserId: required('X_EXPECTED_USER_ID'),
    },
  };
}
