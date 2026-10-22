import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

it('includes asynchronous job failures in recent diagnostics without dumping private model responses', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'audit-reader-test-'),
  );
  try {
    const day = path.join(directory, '2026-10-22');
    await fs.mkdir(day);
    const records = [
      { event: 'http_completed', status: 202 },
      { event: 'ai_response', text: 'private model response' },
      {
        event: 'background_job_failed',
        requestId: 'trace',
        error: { code: 'AI_NO_IMAGE' },
      },
    ];
    await fs.writeFile(
      path.join(day, 'events.jsonl'),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    const output = execFileSync(
      process.execPath,
      [
        path.resolve(__dirname, '../../scripts/read-audit-logs.cjs'),
        '--dir',
        directory,
        '--limit',
        '10',
      ],
      { encoding: 'utf8' },
    );
    expect(output).toContain('AI_NO_IMAGE');
    expect(output).toContain('202');
    expect(output).not.toContain('private model response');
  } finally {
    if (
      path.dirname(directory) === os.tmpdir() &&
      path.basename(directory).startsWith('audit-reader-test-')
    )
      await fs.rm(directory, { recursive: true, force: true });
  }
});
