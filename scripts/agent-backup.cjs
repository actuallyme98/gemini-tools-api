// Encrypted, streaming backup; restore only into a new isolated database.
const { MongoClient, GridFSBucket, BSON } = require('mongodb');
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} = require('node:crypto');
const { createGzip, createGunzip } = require('node:zlib');
const {
  createReadStream,
  createWriteStream,
  promises: fs,
} = require('node:fs');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createInterface } = require('node:readline');
const path = require('node:path');
const MAGIC = Buffer.from('LCGBKP01');
function secret(env) {
  if (!/^[a-f0-9]{64}$/i.test(env.AGENT_BACKUP_KEY ?? ''))
    throw Error('AGENT_BACKUP_KEY must contain 64 hexadecimal characters.');
  return Buffer.from(env.AGENT_BACKUP_KEY, 'hex');
}
function backupPath(file, env) {
  const root = path.resolve(env.AGENT_BACKUP_DIR || 'backups'),
    target = path.resolve(root, file);
  if (target === root || !target.startsWith(root + path.sep))
    throw Error('Backup path must stay inside AGENT_BACKUP_DIR.');
  return { root, target };
}
async function* records(db, env) {
  yield BSON.EJSON.stringify({
    type: 'header',
    version: 1,
    database: db.databaseName,
    createdAt: new Date().toISOString(),
  }) + '\n';
  let count = 0;
  const digest = createHash('sha256');
  for (const collection of await db
    .listCollections({}, { nameOnly: true })
    .toArray()) {
    if (collection.name.startsWith('system.')) continue;
    const indexes = await db.collection(collection.name).indexes();
    const meta = BSON.EJSON.stringify({
      type: 'collection',
      name: collection.name,
      indexes,
    });
    digest.update(meta);
    yield meta + '\n';
    for await (const document of db.collection(collection.name).find({})) {
      const line = BSON.EJSON.stringify({
        type: 'document',
        collection: collection.name,
        document,
      });
      digest.update(line);
      yield line + '\n';
      count++;
    }
  }
  // Include only this application's encrypted R2 assets, never the shared bucket as a whole.
  let client;
  for await (const row of db
    .collection('agent_records')
    .find({ kind: 'asset' })) {
    const asset = row.data;
    if (typeof asset.id !== 'string' || asset.id !== row.id)
      throw Error('Invalid asset record in backup source.');
    if (asset.storageKey.startsWith('mongo:')) continue;
    const prefix = (env.R2_KEY_PREFIX || 'gemini-tools') + '/agent/';
    if (!asset.storageKey.startsWith(prefix))
      throw Error('Unexpected R2 asset namespace.');
    client ??= new S3Client({
      region: 'auto',
      endpoint:
        env.R2_PRIVATE_URL ||
        `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    const response = await client.send(
      new GetObjectCommand({
        Bucket: env.R2_BUCKET_NAME,
        Key: asset.storageKey,
      }),
      { abortSignal: AbortSignal.timeout(30000) },
    );
    if (
      !response.Body ||
      !response.ContentLength ||
      response.ContentLength > 32 * 1024 * 1024
    )
      throw Error('R2 backup object invalid.');
    const encrypted = Buffer.from(await response.Body.transformToByteArray());
    const line = BSON.EJSON.stringify({
      type: 'object',
      assetId: asset.id,
      encrypted: new BSON.Binary(encrypted),
    });
    digest.update(line);
    yield line + '\n';
    count++;
  }
  client?.destroy();
  yield BSON.EJSON.stringify({
    type: 'footer',
    count,
    sha256: digest.digest('hex'),
  }) + '\n';
}
async function backup(db, file, env = process.env) {
  const key = secret(env),
    { root, target } = backupPath(file, env),
    iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  // The final pathname is created exclusively; a failed file is never reported as valid.
  const handle = await fs.open(target, 'wx', 0o600);
  try {
    await handle.write(Buffer.concat([MAGIC, iv]));
    const output = createWriteStream(target, {
      fd: handle.fd,
      autoClose: false,
      start: 20,
    });
    await pipeline(
      Readable.from(records(db, env)),
      createGzip(),
      cipher,
      output,
    );
    await handle.write(cipher.getAuthTag(), 0, 16, (await handle.stat()).size);
    await handle.sync();
    await handle.close();
    return { file: target, bytes: (await fs.stat(target)).size };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(target).catch(() => undefined);
    throw error;
  }
}
async function decrypt(file, key) {
  const handle = await fs.open(file, 'r');
  let iv, tag, size;
  try {
    size = (await handle.stat()).size;
    const head = Buffer.alloc(20);
    await handle.read(head, 0, 20, 0);
    if (size < 37 || !head.subarray(0, 8).equals(MAGIC))
      throw Error('Invalid backup file.');
    iv = head.subarray(8);
    tag = Buffer.alloc(16);
    await handle.read(tag, 0, 16, size - 16);
  } finally {
    await handle.close();
  }
  const cipher = createDecipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  cipher.setAuthTag(tag);
  return {
    input: createReadStream(file, { start: 20, end: size - 17 }),
    cipher,
  };
}
async function verify(file, env = process.env) {
  const { target } = backupPath(file, env),
    key = secret(env),
    { input, cipher } = await decrypt(target, key);
  // Authenticate the ENTIRE archive before a restore can touch MongoDB.
  await pipeline(
    input,
    cipher,
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
  return target;
}
function replicaConfiguration(env) {
  const names = [
    'BACKUP_S3_ENDPOINT',
    'BACKUP_S3_BUCKET',
    'BACKUP_S3_ACCESS_KEY_ID',
    'BACKUP_S3_SECRET_ACCESS_KEY',
  ];
  if (!names.some((name) => env[name])) return;
  if (!names.every((name) => env[name]))
    throw Error('Backup bucket configuration is incomplete.');
  const endpoint = new URL(env.BACKUP_S3_ENDPOINT);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  )
    throw Error('Backup endpoint must be a plain HTTPS origin.');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.BACKUP_S3_BUCKET))
    throw Error('Invalid backup bucket.');
  const prefix = env.BACKUP_S3_PREFIX || 'gemini-tools/backups';
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix))
    throw Error('Invalid backup namespace.');
  return {
    prefix,
    endpoint: endpoint.origin,
    region:
      env.BACKUP_S3_REGION ||
      (endpoint.hostname.endsWith('.r2.cloudflarestorage.com')
        ? 'auto'
        : 'us-east-1'),
    credentials: {
      accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID,
      secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY,
    },
  };
}
async function replicate(file, env = process.env) {
  const config = replicaConfiguration(env);
  if (!config)
    return { replicated: false, reason: 'backup_bucket_not_configured' };
  if (!/^lcg-\d{8}T\d{6}Z\.enc$/.test(file))
    throw Error('Invalid archive filename.');
  const target = await verify(file, env),
    size = (await fs.stat(target)).size;
  if (size > 5_000_000_000)
    throw Error(
      'Archive exceeds single-upload limit; configure multipart backups.',
    );
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(target)) digest.update(chunk);
  const sha256 = digest.digest('hex'),
    key = config.prefix + '/' + file;
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    maxAttempts: 2,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: env.BACKUP_S3_BUCKET,
        Key: key,
        Body: createReadStream(target),
        ContentLength: size,
        ContentType: 'application/octet-stream',
        Metadata: { sha256 },
      }),
      { abortSignal: AbortSignal.timeout(300000) },
    );
    const response = await client.send(
      new GetObjectCommand({ Bucket: env.BACKUP_S3_BUCKET, Key: key }),
      { abortSignal: AbortSignal.timeout(300000) },
    );
    if (!response.Body || response.ContentLength !== size)
      throw Error('Replica size mismatch.');
    const downloaded = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of response.Body) {
        bytes += chunk.length;
        if (bytes > size) throw Error('Replica exceeds expected size.');
        downloaded.update(chunk);
      }
    } finally {
      response.Body.destroy?.();
    }
    if (bytes !== size || downloaded.digest('hex') !== sha256)
      throw Error('Replica checksum mismatch.');
    await fs.writeFile(target + '.replicated', `${sha256}  ${file}\n`, {
      mode: 0o600,
    });
    return { replicated: true, key, bytes, sha256 };
  } finally {
    client.destroy();
  }
}
async function restore(client, file, targetName, env = process.env) {
  if (!/^[a-zA-Z0-9]+_restore_[a-zA-Z0-9_]+$/.test(targetName))
    throw Error('Restore requires a new <name>_restore_<id> database.');
  const target = await verify(file, env),
    db = client.db(targetName);
  if ((await db.listCollections().toArray()).length)
    throw Error('Restore database must be empty.');
  const { input, cipher } = await decrypt(target, secret(env)),
    gunzip = createGunzip();
  const done = pipeline(input, cipher, gunzip);
  const lines = createInterface({ input: gunzip, crlfDelay: Infinity });
  const indexes = [],
    digest = createHash('sha256');
  let count = 0,
    footer,
    header;
  try {
    for await (const line of lines) {
      const row = BSON.EJSON.parse(line, { relaxed: false });
      if (row.type === 'header') {
        if (header || Number(row.version) !== 1 || row.database === targetName)
          throw Error('Invalid backup header.');
        header = row;
        continue;
      }
      if (row.type === 'footer') {
        if (footer) throw Error('Duplicate footer.');
        footer = row;
        continue;
      }
      if (!header || footer) throw Error('Invalid backup ordering.');
      digest.update(line);
      if (row.type === 'collection') indexes.push(row);
      else if (row.type === 'document') {
        const document = row.document;
        if (row.collection === 'agent_records') {
          if (['session', 'google-nonce'].includes(document.kind)) {
            count++;
            continue;
          }
          if (document.kind === 'user')
            document.data.authVersion =
              (Number(document.data.authVersion) || 0) + 1;
          if (document.kind === 'company-settings')
            document.data.queuePaused = true;
          if (
            document.kind === 'image-job' &&
            ['preparing', 'queued', 'running'].includes(document.data.state)
          ) {
            document.data.state = 'interrupted';
            document.data.error = {
              code: 'RESTORE_REVIEW_REQUIRED',
              statusCode: 409,
              message: 'Khôi phục dữ liệu: đối soát request trước khi gửi lại.',
              requestId: document.data.requestId,
              retryable: false,
            };
          }
          if (
            document.kind === 'step' &&
            ['queued', 'running'].includes(document.data.state)
          ) {
            document.data.state = 'interrupted';
            document.data.errorCode = 'RESTORE_REVIEW_REQUIRED';
            document.data.error =
              'Khôi phục dữ liệu: kiểm tra request và đối soát trước khi chạy lại.';
          }
          if (
            document.kind === 'run' &&
            ['planning', 'queued', 'running'].includes(document.data.state)
          )
            document.data.state = 'failed';
        }
        await db.collection(row.collection).insertOne(document);
        count++;
      } else if (row.type === 'object') {
        const bucket = new GridFSBucket(db, {
            bucketName: 'agent_image_backups',
          }),
          upload = bucket.openUploadStream(`${row.assetId}.bin`);
        await pipeline(Readable.from([row.encrypted.value()]), upload);
        await db
          .collection('agent_records')
          .updateOne(
            { kind: 'asset', id: row.assetId },
            { $set: { 'data.storageKey': `mongo:${upload.id.toHexString()}` } },
          );
        count++;
      } else throw Error('Unknown archive record.');
    }
    await done;
    if (
      !footer ||
      Number(footer.count) !== count ||
      footer.sha256 !== digest.digest('hex')
    )
      throw Error('Backup integrity check failed.');
    for (const item of indexes)
      for (const index of item.indexes) {
        if (index.name === '_id_') continue;
        let { key } = index;
        const { v, ns, key: _key, ...options } = index;
        void v;
        void ns;
        void _key;
        if (key._fts)
          key = {
            ...Object.fromEntries(
              Object.entries(key).filter(([k]) => !k.startsWith('_fts')),
            ),
            ...Object.fromEntries(
              Object.keys(options.weights ?? {}).map((k) => [k, 'text']),
            ),
          };
        await db.collection(item.name).createIndex(key, options);
      }
    return {
      database: targetName,
      records: count,
      verified: true,
      sessionsRevoked: true,
      paidTasksPaused: true,
    };
  } catch (error) {
    lines.close();
    gunzip.destroy();
    await done.catch(() => undefined);
    throw error;
  }
}
module.exports = {
  backup,
  restore,
  verify,
  backupPath,
  replicate,
  replicaConfiguration,
};
if (require.main === module)
  (async () => {
    const [action, file, target] = process.argv.slice(2);
    if (
      !['backup', 'verify', 'replicate', 'restore-test'].includes(action) ||
      !file
    )
      throw Error(
        'Usage: node scripts/agent-backup.cjs backup|verify|replicate|restore-test filename [isolated_database]',
      );
    if (action === 'verify') {
      await verify(file);
      console.log('Archive authentication passed.');
      return;
    }
    if (action === 'replicate') {
      console.log(JSON.stringify(await replicate(file)));
      return;
    }
    if (
      action === 'backup' &&
      !process.argv.includes('--maintenance-confirmed')
    )
      throw Error(
        'Pause API and worker writes first, then pass --maintenance-confirmed.',
      );
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
    });
    await client.connect();
    try {
      const result =
        action === 'backup'
          ? await backup(
              client.db(process.env.MONGODB_DATABASE || 'lcgmedia'),
              file,
            )
          : await restore(client, file, target);
      console.log(JSON.stringify(result));
    } finally {
      await client.close();
    }
  })().catch(() => {
    console.error(
      'Backup/restore failed. Check configuration, maintenance state and archive integrity; no credentials are logged.',
    );
    process.exitCode = 1;
  });
