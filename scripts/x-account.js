import { XClient } from '../src/api.js';
import { Store } from '../src/store.js';
import { XBudget } from '../src/x-budget.js';
import { readXLimits } from '../src/config.js';

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env.`);
  return value;
};

let store;
try {
  store = new Store(process.env.DATABASE_PATH || './data/raid-notifier.sqlite');
  const x = new XClient({
    key: required('X_API_KEY'),
    secret: required('X_API_SECRET'),
    accessToken: required('X_ACCESS_TOKEN'),
    accessSecret: required('X_ACCESS_TOKEN_SECRET'),
    // This script discovers the ID. Live startup still verifies it strictly.
    expectedUserId: '',
  }, fetch, new XBudget(store, readXLimits()));
  const account = await x.getAccount();
  console.log(`Authenticated X account: @${account.username}\nX_EXPECTED_USER_ID=${account.id}`);
  console.log('Account lookup uses the persistent cache and request cap. No post was created.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { store?.close(); }
