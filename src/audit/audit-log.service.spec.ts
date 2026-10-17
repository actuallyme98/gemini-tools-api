import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AuditLogService } from './audit-log.service';

describe('Private persistent audit journal', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-audit-test-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (
      path.dirname(directory) !== os.tmpdir() ||
      !path.basename(directory).startsWith('gemini-audit-test-')
    )
      throw new Error('Invalid test cleanup path');
    await fs.rm(directory, { recursive: true, force: true });
  });
  const trace = () => ({
    requestId: randomUUID(),
    method: 'POST',
    path: '/api/backgrounds/replace',
  });
  const day = () => new Date().toISOString().slice(0, 10);
  const events = async (root: string) =>
    (await fs.readFile(path.join(root, day(), 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const create = (root: string, config: Record<string, unknown> = {}) =>
    new AuditLogService(new ConfigService({ AUDIT_LOG_DIR: root, ...config }));

  it('preserves exact prompts, input order and images, deduplicates bytes, and survives a new service instance', async () => {
    const journal = create(directory);
    await journal.onModuleInit();
    const context = trace();
    const prompt = '  Chỉnh sửa ẢNH 2.\nGiữ nguyên màu sắc.  ';
    await journal.run(context, () =>
      journal.aiRequest('shopaikey', 'gpt-image-1.5-all', 'images/edits', [
        { text: prompt },
        { buffer: Buffer.from('source'), mimeType: 'image/png' },
        { buffer: Buffer.from('reference'), mimeType: 'image/jpeg' },
      ]),
    );
    const restarted = create(directory);
    await restarted.onModuleInit();
    await restarted.run(context, () =>
      restarted.generatedImage(Buffer.from('source'), 'image/png'),
    );
    const records = await events(directory);
    expect(records.map((event) => event.requestId)).toEqual([
      context.requestId,
      context.requestId,
    ]);
    const parts = records[0].parts as {
      text?: string;
      file?: string;
      type: string;
    }[];
    expect(parts.map((part) => part.type)).toEqual(['text', 'image', 'image']);
    expect(parts[0].text).toBe(prompt);
    expect(await fs.readFile(path.join(directory, parts[1].file))).toEqual(
      Buffer.from('source'),
    );
    expect(await fs.readFile(path.join(directory, parts[2].file))).toEqual(
      Buffer.from('reference'),
    );
    expect(
      await fs.readdir(path.join(directory, day(), 'images')),
    ).toHaveLength(2);
    await restarted.write('http_completed', { status: 201 }, context);
    const cli = path.resolve(__dirname, '../../scripts/read-audit-logs.cjs');
    const recent = execFileSync(process.execPath, [cli, '--dir', directory], {
      encoding: 'utf8',
    });
    expect(recent).not.toContain(prompt);
    expect(JSON.parse(recent)).toMatchObject({
      event: 'http_completed',
      requestId: context.requestId,
    });
    const details = execFileSync(
      process.execPath,
      [cli, '--dir', directory, '--request', context.requestId],
      { encoding: 'utf8' },
    );
    const first: unknown = JSON.parse(details.split('\n')[0]);
    expect(first).toMatchObject({ parts: [{ text: prompt }, {}, {}] });
  });

  it('retains prompt/hash metadata when the image budget is exceeded and counts prior bytes after restart', async () => {
    const journal = create(directory, { AUDIT_IMAGE_MAX_BYTES_PER_DAY: 3 });
    await journal.run(trace(), () =>
      journal.generatedImage(Buffer.from('one'), 'image/png'),
    );
    const restarted = create(directory, { AUDIT_IMAGE_MAX_BYTES_PER_DAY: 3 });
    await restarted.run(trace(), () =>
      restarted.aiRequest('gemini', 'model', 'generateContent', [
        { text: 'prompt' },
        { buffer: Buffer.from('two'), mimeType: 'image/png' },
      ]),
    );
    const records = await events(directory);
    expect((records[1].parts as unknown[])[1]).toMatchObject({
      archiveUnavailable: true,
      bytes: 3,
      sha256: expect.any(String) as unknown,
    });
    expect(
      await fs.readdir(path.join(directory, day(), 'images')),
    ).toHaveLength(1);
  });

  it('prunes only expired day directories and leaves unrelated files alone', async () => {
    await fs.mkdir(path.join(directory, '2000-01-01'));
    await fs.writeFile(
      path.join(directory, '2000-01-01', 'events.jsonl'),
      'expired',
    );
    await fs.mkdir(path.join(directory, 'manual-backup'));
    await fs.writeFile(path.join(directory, 'keep.txt'), 'keep');
    const journal = create(directory, { AUDIT_LOG_RETENTION_DAYS: 1 });
    await journal.onModuleInit();
    expect(await fs.readdir(directory)).toEqual(
      expect.arrayContaining(['keep.txt', 'manual-backup']),
    );
    await expect(
      fs.access(path.join(directory, '2000-01-01')),
    ).rejects.toThrow();
    await journal.run(trace(), () => journal.write('http_started'));
    expect(await fs.readFile(path.join(directory, 'keep.txt'), 'utf8')).toBe(
      'keep',
    );
  });

  it('redacts credentials without changing ordinary prompt text and records that redaction occurred', async () => {
    const journal = create(directory);
    const secret = 'sk-audit12345678901234567890';
    await journal.run(trace(), () =>
      journal.aiRequest('gemini', 'model', 'generateContent', [
        { text: `Keep https://example.com/scene and secret ${secret}` },
      ]),
    );
    const raw = await fs.readFile(
      path.join(directory, day(), 'events.jsonl'),
      'utf8',
    );
    expect(raw).not.toContain(secret);
    expect(raw).toContain('https://example.com/scene');
    expect((await events(directory))[0].parts).toEqual([
      expect.objectContaining({
        redacted: true,
        text: 'Keep https://example.com/scene and secret [redacted]',
      }),
    ]);
  });

  it('reports a disk error without throwing into an AI request', async () => {
    const file = path.join(directory, 'not-a-directory');
    await fs.writeFile(file, 'occupied');
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const journal = create(file);
    await expect(
      journal.run(trace(), () =>
        journal.aiRequest('gemini', 'model', 'generateContent', [
          { text: 'prompt' },
          { buffer: Buffer.from('source'), mimeType: 'image/png' },
        ]),
      ),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Audit log write failed'),
    );
    expect(await fs.readFile(file, 'utf8')).toBe('occupied');
  });
});
