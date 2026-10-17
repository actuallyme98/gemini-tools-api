import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sanitizeErrorMessage } from '../common/error-sanitizer';

export type AuditContext = { requestId: string; method: string; path: string };
export type AuditPart = { text: string } | { buffer: Buffer; mimeType: string };
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class AuditLogService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AuditLogService.name);
  private readonly context = new AsyncLocalStorage<AuditContext>();
  readonly directory: string;
  private tail: Promise<unknown> = Promise.resolve();
  private lastCleanup = 0;
  private readonly imageBytes = new Map<string, number>();

  constructor(private readonly config: ConfigService) {
    this.directory = path.resolve(
      config.get<string>('AUDIT_LOG_DIR', './logs'),
    );
  }

  async onModuleInit() {
    await this.schedule(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.cleanup();
    });
  }

  run<T>(context: AuditContext, callback: () => T): T {
    return this.context.run(context, callback);
  }

  private schedule<T>(operation: () => Promise<T>): Promise<T | undefined> {
    const result = this.tail.then(operation);
    // A logging/disk failure must never cause paid AI work to be retried.
    this.tail = result.catch((error) => {
      this.logger.error(
        `Audit log write failed: ${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}`,
      );
    });
    return result.catch(() => undefined);
  }

  async flush() {
    await this.tail;
  }
  async onApplicationShutdown() {
    await this.flush();
  }

  write(
    event: string,
    details: Record<string, unknown> = {},
    context = this.context.getStore(),
  ) {
    if (!context) return Promise.resolve();
    return this.schedule(async () => {
      await this.cleanup();
      const timestamp = new Date().toISOString();
      const day = timestamp.slice(0, 10);
      const directory = path.join(this.directory, day);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.appendFile(
        path.join(directory, 'events.jsonl'),
        JSON.stringify({ ...details, timestamp, event, ...context }) + '\n',
        { mode: 0o600 },
      );
    });
  }

  private redact(value: string) {
    let result = value;
    for (const [name, secret] of Object.entries(process.env)) {
      if (
        /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) &&
        secret &&
        secret.length >= 8
      )
        result = result.split(secret).join('[redacted]');
    }
    return result
      .replace(/\b(?:sk-[\w-]{8,}|AIza[\w-]{8,}|AQ\.[\w-]{8,})/g, '[redacted]')
      .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
      .replace(
        /((?:api[_-]?key|token|secret|password|signature|credential)["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi,
        '$1[redacted]',
      );
  }

  async aiRequest(
    provider: string,
    model: string,
    transport: string,
    parts: AuditPart[],
  ) {
    const context = this.context.getStore();
    if (!context) return;
    const day = new Date().toISOString().slice(0, 10);
    const auditParts = [];
    for (const [index, part] of parts.entries()) {
      if ('text' in part) {
        const text = this.redact(part.text);
        auditParts.push({
          index,
          type: 'text',
          text,
          sha256: hash(part.text),
          characters: part.text.length,
          redacted: text !== part.text,
        });
      } else {
        auditParts.push({
          index,
          type: 'image',
          ...(await this.image(part.buffer, part.mimeType, day)),
        });
      }
    }
    await this.write(
      'ai_request',
      { provider, model, transport, parts: auditParts },
      context,
    );
  }

  async generatedImage(buffer: Buffer, mimeType: string) {
    const context = this.context.getStore();
    if (!context) return;
    await this.write(
      'generated_image',
      {
        image: await this.image(
          buffer,
          mimeType,
          new Date().toISOString().slice(0, 10),
        ),
      },
      context,
    );
  }

  private async image(buffer: Buffer, mimeType: string, day: string) {
    const sha256 = hash(buffer);
    const extension =
      mimeType === 'image/jpeg'
        ? 'jpg'
        : mimeType === 'image/webp'
          ? 'webp'
          : 'png';
    const relativePath = `${day}/images/${sha256}.${extension}`;
    const archived = await this.schedule(async () => {
      const directory = path.join(this.directory, day, 'images');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, relativePath);
      try {
        await fs.access(file);
        return true;
      } catch {
        /* New content. */
      }
      let used = this.imageBytes.get(day);
      if (used === undefined) {
        used = 0;
        for (const entry of await fs.readdir(directory, {
          withFileTypes: true,
        }))
          if (entry.isFile())
            used += (await fs.stat(path.join(directory, entry.name))).size;
      }
      const limit = this.config.get<number>(
        'AUDIT_IMAGE_MAX_BYTES_PER_DAY',
        512 * 1024 * 1024,
      );
      this.imageBytes.set(day, used);
      if (used + buffer.length > limit) return false;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, buffer, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, file);
      } finally {
        await fs.unlink(temporary).catch(() => undefined);
      }
      this.imageBytes.set(day, used + buffer.length);
      return true;
    });
    return {
      mimeType,
      bytes: buffer.length,
      sha256,
      ...(archived ? { file: relativePath } : { archiveUnavailable: true }),
    };
  }

  private async cleanup() {
    const now = Date.now();
    if (now - this.lastCleanup < 60 * 60 * 1000) return;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const days = this.config.get<number>('AUDIT_LOG_RETENTION_DAYS', 7);
    const cutoff = new Date(now - (days - 1) * 86400000)
      .toISOString()
      .slice(0, 10);
    for (const entry of await fs.readdir(this.directory, {
      withFileTypes: true,
    })) {
      // Only our own UTC day directories; never traverse links or arbitrary paths.
      if (
        entry.isDirectory() &&
        dayPattern.test(entry.name) &&
        entry.name < cutoff
      ) {
        const target = path.resolve(this.directory, entry.name);
        if (path.dirname(target) !== this.directory)
          throw new Error('Invalid audit cleanup target');
        await fs.rm(target, { recursive: true, force: true });
        this.imageBytes.delete(entry.name);
      }
    }
    this.lastCleanup = now;
  }
}
