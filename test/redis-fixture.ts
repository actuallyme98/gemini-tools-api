import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Redis from 'ioredis';

export async function redisFixture() {
  const external = process.env.REDIS_TEST_URL;
  if (external) return { url: external, close: () => Promise.resolve() };
  const directory = await mkdtemp(path.join(tmpdir(), 'lcg-redis-queue-'));
  const binary =
    process.env.REDIS_TEST_BINARY ??
    (process.platform === 'win32'
      ? path.join(
          process.env.USERPROFILE ?? '',
          '.codex/cache/redis-queue-tests/bin/Redis-7.4.2-Windows-x64-msys2/redis-server.exe',
        )
      : 'redis-server');
  if (process.platform === 'win32' && !existsSync(binary))
    throw new Error(
      'Set REDIS_TEST_BINARY or REDIS_TEST_URL to run real queue integration tests.',
    );
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No Redis test port');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const child = spawn(
    binary,
    [
      '--bind',
      '127.0.0.1',
      '--port',
      String(port),
      '--appendonly',
      'yes',
      '--appendfsync',
      'always',
      '--dir',
      directory.replaceAll('\\', '/'),
      '--save',
      '',
      '--maxmemory-policy',
      'noeviction',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  let startError: Error | undefined;
  child.on('error', (error) => {
    startError = error;
  });
  const url = `redis://127.0.0.1:${port}/0`;
  const client = new Redis(url, {
    lazyConnect: true,
    retryStrategy: () => null,
    connectTimeout: 500,
  });
  client.on('error', () => undefined);
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      await client.connect();
      if ((await client.ping()) === 'PONG') break;
    } catch {
      client.disconnect();
    }
    if (startError || child.exitCode !== null || attempt === 79)
      throw new Error(
        'Redis test server did not start. Configure REDIS_TEST_URL or REDIS_TEST_BINARY.',
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  client.disconnect();
  return {
    url,
    async close() {
      const connection = new Redis(url, { retryStrategy: () => null });
      connection.on('error', () => undefined);
      await connection.shutdown('SAVE').catch(() => undefined);
      connection.disconnect();
      if (child.exitCode === null)
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
          setTimeout(() => {
            child.kill();
            resolve();
          }, 3000).unref();
        });
      await rm(directory, { recursive: true, force: true });
    },
  };
}
