import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, GridFSBucket } from 'mongodb';
import { S3Client } from '@aws-sdk/client-s3';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
// The production CLI is exercised directly so the test validates the actual archive format.
const { backup, restore, verify, backupPath, replicate, replicaConfiguration } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Exercise the shipped CommonJS CLI without a duplicate implementation.
  require('../scripts/agent-backup.cjs') as {
    backup: (
      db: ReturnType<MongoClient['db']>,
      file: string,
      env: Record<string, string>,
    ) => Promise<unknown>;
    restore: (
      client: MongoClient,
      file: string,
      name: string,
      env: Record<string, string>,
    ) => Promise<{ verified: boolean }>;
    verify: (file: string, env: Record<string, string>) => Promise<string>;
    backupPath: (file: string, env: Record<string, string>) => unknown;
    replicate: (
      file: string,
      env: Record<string, string>,
    ) => Promise<{ replicated: boolean }>;
    replicaConfiguration: (env: Record<string, string>) => unknown;
  };
it('restores an authenticated backup into an empty isolated database, revokes sessions and pauses paid tasks', async () => {
  const mongo = await MongoMemoryServer.create(),
    client = new MongoClient(mongo.getUri(), {
      runtimeAdapters: { os },
      serverSelectionTimeoutMS: 5000,
    });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lcg-backup-')),
    env = {
      AGENT_BACKUP_DIR: directory,
      AGENT_BACKUP_KEY: randomBytes(32).toString('hex'),
      R2_PRIVATE_URL: 'https://example.com',
      R2_ACCESS_KEY_ID: 'test',
      R2_SECRET_ACCESS_KEY: 'test',
      R2_BUCKET_NAME: 'test',
      R2_KEY_PREFIX: 'gemini-tools',
    };
  try {
    await client.connect();
    const db = client.db('backup_source');
    await db.collection('agent_records').insertMany([
      { kind: 'user', id: 'user', data: { authVersion: 0 } },
      { kind: 'session', id: 'session', data: {} },
      { kind: 'run', id: 'run', data: { state: 'running' } },
      { kind: 'step', id: 'step', data: { state: 'queued' } },
      {
        kind: 'image-job',
        id: 'image-job',
        data: { state: 'queued', requestId: 'request' },
      },
      { kind: 'company-settings', id: 'company', data: { queuePaused: false } },
      {
        kind: 'knowledge',
        id: 'knowledge',
        data: { title: 'Brand', content: 'Orange guideline' },
      },
      {
        kind: 'asset',
        id: 'r2-image',
        data: {
          id: 'r2-image',
          storageKey: 'gemini-tools/agent/user/r2-image.bin',
        },
      },
    ]);
    await db
      .collection('agent_records')
      .createIndex(
        { 'data.title': 'text', 'data.content': 'text' },
        { default_language: 'none' },
      );
    const encrypted = Buffer.from('encrypted-image-bytes');
    const s3 = jest.spyOn(S3Client.prototype, 'send').mockReturnValue(
      Promise.resolve({
        ContentLength: encrypted.length,
        Body: { transformToByteArray: () => Promise.resolve(encrypted) },
      }) as never,
    );
    try {
      await backup(db, 'test.enc', env);
    } finally {
      s3.mockRestore();
    }
    await expect(verify('test.enc', env)).resolves.toBe(
      path.join(directory, 'test.enc'),
    );
    const archiveName = 'lcg-20261024T000000Z.enc';
    await fs.copyFile(
      path.join(directory, 'test.enc'),
      path.join(directory, archiveName),
    );
    const replicaEnv = {
      ...env,
      BACKUP_S3_ENDPOINT: 'https://backup.example.com',
      BACKUP_S3_BUCKET: 'private-backups',
      BACKUP_S3_ACCESS_KEY_ID: 'replica-key',
      BACKUP_S3_SECRET_ACCESS_KEY: 'replica-secret',
    };
    expect(
      replicaConfiguration({
        ...replicaEnv,
        BACKUP_S3_BUCKET: env.R2_BUCKET_NAME,
      }),
    ).toMatchObject({ prefix: 'gemini-tools/backups' });
    expect(() =>
      replicaConfiguration({ ...replicaEnv, BACKUP_S3_PREFIX: '../escape' }),
    ).toThrow('namespace');
    expect(() => replicaConfiguration({ BACKUP_S3_BUCKET: 'partial' })).toThrow(
      'incomplete',
    );
    await expect(replicate(archiveName, env)).resolves.toEqual({
      replicated: false,
      reason: 'backup_bucket_not_configured',
    });
    let uploaded = Buffer.alloc(0),
      corruptReplica = false;
    const sendReplica = (...args: unknown[]) => {
      const command = args[0] as {
        input: { Body?: AsyncIterable<Buffer>; Bucket: string; Key: string };
      };
      expect(command.input.Bucket).toBe('private-backups');
      expect(command.input.Key).toBe('gemini-tools/backups/' + archiveName);
      if (command.input.Body)
        return (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of command.input.Body) chunks.push(chunk);
          uploaded = Buffer.concat(chunks);
          return {};
        })();
      const bytes = Buffer.from(uploaded);
      if (corruptReplica) bytes[0] ^= 1;
      return Promise.resolve({
        ContentLength: bytes.length,
        Body: Readable.from([bytes]),
      });
    };
    const remote = jest
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(sendReplica as never);
    try {
      await expect(replicate(archiveName, replicaEnv)).resolves.toMatchObject({
        replicated: true,
      });
      expect(uploaded).toEqual(
        await fs.readFile(path.join(directory, archiveName)),
      );
      expect(
        await fs.readFile(
          path.join(directory, archiveName + '.replicated'),
          'utf8',
        ),
      ).toContain(archiveName);
      await fs.unlink(path.join(directory, archiveName + '.replicated'));
      corruptReplica = true;
      await expect(replicate(archiveName, replicaEnv)).rejects.toThrow(
        'checksum',
      );
      await expect(
        fs.access(path.join(directory, archiveName + '.replicated')),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(directory, archiveName)),
      ).resolves.toBeUndefined();
    } finally {
      remote.mockRestore();
    }
    expect(
      (await restore(client, 'test.enc', 'lcg_restore_test', env)).verified,
    ).toBe(true);
    const target = client.db('lcg_restore_test');
    const restored = target.collection<{
      kind: string;
      data: { state?: string; authVersion?: number; queuePaused?: boolean };
    }>('agent_records');
    expect(
      await target
        .collection('agent_records')
        .countDocuments({ kind: 'session' }),
    ).toBe(0);
    expect((await restored.findOne({ kind: 'run' }))?.data.state).toBe(
      'failed',
    );
    expect((await restored.findOne({ kind: 'step' }))?.data.state).toBe(
      'interrupted',
    );
    expect((await restored.findOne({ kind: 'user' }))?.data.authVersion).toBe(
      1,
    );
    expect(await db.collection('agent_records').countDocuments()).toBe(8);
    expect((await restored.findOne({ kind: 'image-job' }))?.data.state).toBe(
      'interrupted',
    );
    expect(
      (await restored.findOne({ kind: 'company-settings' }))?.data.queuePaused,
    ).toBe(true);
    const restoredAsset = await target
      .collection<{
        kind: string;
        data: { storageKey: string };
      }>('agent_records')
      .findOne({ kind: 'asset' });
    expect(restoredAsset?.data.storageKey.startsWith('mongo:')).toBe(true);
    const grid = new GridFSBucket(target, {
      bucketName: 'agent_image_backups',
    });
    const restoredBytes: Buffer[] = [];
    for await (const chunk of grid.openDownloadStreamByName('r2-image.bin'))
      restoredBytes.push(chunk as Buffer);
    expect(Buffer.concat(restoredBytes)).toEqual(encrypted);
    await expect(
      restore(client, 'test.enc', 'lcg_restore_test', env),
    ).rejects.toThrow('empty');
    await expect(restore(client, 'test.enc', 'lcgmedia', env)).rejects.toThrow(
      'new',
    );
    const bytes = await fs.readFile(path.join(directory, 'test.enc'));
    bytes[30] ^= 1;
    await fs.writeFile(path.join(directory, 'tampered.enc'), bytes);
    await expect(
      restore(client, 'tampered.enc', 'lcg_restore_tampered', env),
    ).rejects.toThrow();
    expect(
      (await client.db('lcg_restore_tampered').listCollections().toArray())
        .length,
    ).toBe(0);
    expect(() => backupPath('../escape.enc', env)).toThrow();
  } finally {
    await client.close();
    await mongo.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60000);
