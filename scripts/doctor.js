import { readConfig } from '../src/config.js';
import { Telegram } from '../src/api.js';
import { checkTelegramAccess } from '../src/diagnostics.js';

try {
  const config = readConfig();
  const telegram = new Telegram(config.token);
  const me = await telegram.call('getMe');
  const result = await checkTelegramAccess(config, telegram, me);
  console.log(result.lines.join('\n'));
  console.log('\nRead-only check: no updates consumed, no messages sent, no X requests.');
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
