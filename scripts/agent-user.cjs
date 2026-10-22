const { MongoClient } = require('mongodb');
const { randomUUID, randomBytes, scrypt } = require('node:crypto');
const { promisify } = require('node:util');
require('dotenv').config();

async function password() {
  if (process.env.AGENT_BOOTSTRAP_PASSWORD)
    return process.env.AGENT_BOOTSTRAP_PASSWORD;
  if (!process.stdin.isTTY)
    throw new Error(
      'Use an interactive terminal or set AGENT_BOOTSTRAP_PASSWORD for this process only.',
    );
  process.stdout.write('Password (hidden, at least 12 characters): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      process.stdin.removeListener('data', read);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const read = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          finish();
          reject(new Error('Cancelled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', read);
  });
}

async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  const role = process.argv[3] || 'designer';
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !['admin', 'designer'].includes(role)
  )
    throw new Error(
      'Usage: npm run agent:user -- email@example.com [admin|designer]',
    );
  if (!process.env.MONGODB_URI) throw new Error('Configure MONGODB_URI first.');
  const secret = await password();
  if (secret.length < 12 || secret.length > 128)
    throw new Error('Password must contain 12–128 characters.');
  const salt = randomBytes(16).toString('hex');
  const hash = await promisify(scrypt)(secret, salt, 64);
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  try {
    await client.connect();
    const collection = client
      .db(process.env.MONGODB_DATABASE || 'lcgmedia')
      .collection('agent_records');
    await collection.createIndex({ kind: 1, id: 1 }, { unique: true });
    await collection.createIndex(
      { 'data.email': 1 },
      { unique: true, partialFilterExpression: { kind: 'user' } },
    );
    if (await collection.findOne({ kind: 'user', 'data.email': email }))
      throw new Error('Account already exists; no password was changed.');
    const id = randomUUID(),
      now = new Date().toISOString();
    await collection.insertOne({
      kind: 'user',
      id,
      owner: id,
      updatedAt: new Date(),
      data: {
        id,
        owner: id,
        email,
        passwordHash: `${salt}:${hash.toString('hex')}`,
        role,
        createdAt: now,
        updatedAt: now,
      },
    });
    process.stdout.write(`Created ${role} account: ${email}\n`);
  } finally {
    await client.close();
  }
}
main().catch(() => {
  process.stderr.write(
    'Could not create account. Check email/role, password length, duplicate email and MongoDB access. Connection credentials were not printed.\n',
  );
  process.exitCode = 1;
});
