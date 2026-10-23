import { diagnosticDetails, readAdminDiagnostics } from './admin-diagnostics';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

describe('admin request diagnostics', () => {
  it('redacts secrets before truncation, omits unknown fields and bounds event payloads', () => {
    const jwt = 'eyJ' + 'a'.repeat(100) + '.payload.signature';
    const result = diagnosticDetails({
      event: 'ai_request',
      parts: Array.from({ length: 50 }, () => ({
        text:
          `Bearer secret-value ${jwt} token=private-token ` + 'x'.repeat(60000),
        type: 'text',
      })),
      headers: { authorization: 'hidden' },
      image: {
        base64: 'hidden',
        file: '/private/path',
        sha256: 'hash',
        bytes: 42,
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /secret-value|eyJ|private-token|hidden|private\/path/,
    );
    expect(serialized.length).toBeLessThan(70000);
    expect(result).toMatchObject({
      truncated: true,
      image: { sha256: 'hash', bytes: 42 },
    });
  });
  it('rejects linked log directories instead of following them', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'admin-log-link-'),
    );
    try {
      const target = path.join(directory, 'actual');
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'events.jsonl'), '{}\n');
      await fs.symlink(
        target,
        path.join(directory, '2026-10-23'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await expect(
        readAdminDiagnostics(
          directory,
          {
            day: '2026-10-23',
            cursor: 0,
            search: '',
            errorsOnly: false,
            limit: 50,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
