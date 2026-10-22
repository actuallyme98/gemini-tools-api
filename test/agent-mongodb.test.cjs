const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(
  path.join(__dirname, '../deploy/agent-mongodb-init.js'),
  'utf8',
);
const valid = {
  MONGO_INITDB_DATABASE: 'lcgmedia',
  MONGODB_APP_USER: 'lcgmedia_agent',
  MONGODB_APP_PASSWORD: 'a'.repeat(64),
  MONGO_INITDB_ROOT_USERNAME: 'lcgmedia_root',
};

function initialize(overrides = {}) {
  const created = [];
  vm.runInNewContext(script, {
    process: { env: { ...valid, ...overrides } },
    db: {
      getSiblingDB: (name) => ({
        createUser: (user) => created.push({ name, user }),
      }),
    },
  });
  return JSON.parse(JSON.stringify(created));
}

test('Agent database account can access only its own database', () => {
  assert.deepEqual(initialize(), [
    {
      name: 'lcgmedia',
      user: {
        user: valid.MONGODB_APP_USER,
        pwd: valid.MONGODB_APP_PASSWORD,
        roles: [{ role: 'readWrite', db: 'lcgmedia' }],
      },
    },
  ]);
});

test('Invalid settings cannot create a privileged or weak account', () => {
  for (const settings of [
    { MONGO_INITDB_DATABASE: 'admin' },
    { MONGO_INITDB_DATABASE: 'local' },
    { MONGO_INITDB_DATABASE: 'config' },
    { MONGODB_APP_USER: valid.MONGO_INITDB_ROOT_USERNAME },
    { MONGODB_APP_PASSWORD: 'short' },
    { MONGODB_APP_PASSWORD: undefined },
    { MONGO_INITDB_DATABASE: undefined },
  ]) {
    assert.throws(() => initialize(settings), /Invalid Agent MongoDB/);
  }
});
