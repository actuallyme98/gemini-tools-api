import { constants, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { ApiError } from '../common/api-error';
import { sanitizeErrorMessage } from '../common/error-sanitizer';

export type DiagnosticQuery = {
  day: string;
  cursor: number;
  limit: number;
  search: string;
  errorsOnly: boolean;
  source?: 'api' | 'worker';
};
const redact = (value: string, length = 1000) =>
  sanitizeErrorMessage(
    value
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted]')
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
        '[redacted private key]',
      ),
    length,
  );
export function diagnosticSummary(input: Record<string, unknown>) {
  const result: Record<string, string | number | boolean> = {};
  for (const field of [
    'timestamp',
    'event',
    'requestId',
    'method',
    'path',
    'provider',
    'model',
    'runId',
    'stepId',
    'code',
    'message',
    'actorEmail',
  ])
    if (typeof input[field] === 'string') result[field] = redact(input[field]);
  for (const field of ['status', 'durationMs'])
    if (typeof input[field] === 'number') result[field] = input[field];
  if (input.error && typeof input.error === 'object') {
    const error = input.error as Record<string, unknown>;
    for (const field of ['code', 'message'])
      if (typeof error[field] === 'string')
        result[field] = redact(error[field]);
  }
  return result;
}

// Only diagnostic fields are exposed; raw headers, credentials, URLs and image data stay private.
const detailFields = new Set([
  'timestamp',
  'event',
  'requestId',
  'method',
  'path',
  'actorEmail',
  'provider',
  'model',
  'imageModel',
  'transport',
  'runId',
  'stepId',
  'jobId',
  'status',
  'statusCode',
  'upstreamStatus',
  'durationMs',
  'cancelled',
  'code',
  'message',
  'reason',
  'suggestion',
  'diagnostic',
  'validation',
  'error',
  'parts',
  'image',
  'index',
  'type',
  'text',
  'sha256',
  'characters',
  'redacted',
  'mimeType',
  'bytes',
  'base64Length',
  'archiveUnavailable',
  'responseId',
  'modelVersion',
  'promptFeedback',
  'blockReason',
  'blockReasonMessage',
  'candidates',
  'finishReason',
  'finishMessage',
  'safetyRatings',
  'category',
  'probability',
  'probabilityScore',
  'severity',
  'severityScore',
  'blocked',
  'omitted',
]);
export function diagnosticDetails(input: Record<string, unknown>) {
  let remaining = 64000;
  let truncated = false;
  const clean = (value: unknown, depth = 0, field = ''): unknown => {
    if (typeof value === 'string') {
      const limit = field === 'text' ? Math.min(remaining, 50000) : 1000;
      if (field === 'text') remaining -= Math.min(value.length, limit);
      if (value.length > limit) truncated = true;
      return redact(value, limit);
    }
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (depth >= 6 || !value || typeof value !== 'object') return undefined;
    if (Array.isArray(value)) {
      if (value.length > 40) truncated = true;
      return value.slice(0, 40).map((item) => clean(item, depth + 1));
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => detailFields.has(key))
        .map(([key, item]) => [key, clean(item, depth + 1, key)])
        .filter(([, item]) => item !== undefined),
    );
  };
  const result = clean(input) as Record<string, unknown>;
  return { ...result, ...(truncated ? { truncated: true } : {}) };
}
export async function readAdminDiagnostics(
  directory: string,
  query: DiagnosticQuery,
  requestId?: string,
) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(query.day) ||
    !Number.isFinite(Date.parse(query.day)) ||
    new Date(query.day).toISOString().slice(0, 10) !== query.day
  )
    throw new ApiError(400, 'ADMIN_LOG_DATE_INVALID', 'Ngày log không hợp lệ.');
  const empty = {
    items: [] as Record<string, unknown>[],
    nextCursor: null as number | null,
    scanned: 0,
    malformed: 0,
  };
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    const root = await fs.realpath(directory);
    const day = path.join(root, query.day);
    const file = path.join(day, 'events.jsonl');
    if ((await fs.realpath(day)) !== day) throw new Error('Symlink directory');
    if ((await fs.realpath(file)) !== file) throw new Error('Symlink file');
    handle = await fs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return empty;
    throw new ApiError(
      503,
      'ADMIN_LOG_UNAVAILABLE',
      'Không đọc được nhật ký chẩn đoán.',
    );
  }
  let lines: ReturnType<typeof createInterface> | undefined;
  let stream: ReturnType<typeof handle.createReadStream> | undefined;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Invalid log file');
    stream = handle.createReadStream({ autoClose: false });
    lines = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    let lineNumber = 0;
    let responseBytes = 0;
    const search = query.search.toLowerCase();
    for await (const line of lines) {
      lineNumber++;
      if (lineNumber <= query.cursor) continue;
      empty.scanned++;
      let raw: Record<string, unknown> | undefined;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        empty.malformed++;
      }
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const summary = diagnosticSummary(raw);
        const isError =
          Number(summary.status) >= 400 ||
          /fail|error|fallback|interrupt/i.test(String(summary.event));
        if (requestId) {
          if (raw.requestId === requestId) {
            const details = diagnosticDetails(raw);
            empty.items.push(details);
            responseBytes += Buffer.byteLength(JSON.stringify(details));
          }
        } else if (
          (!query.errorsOnly || isError) &&
          (!search || JSON.stringify(summary).toLowerCase().includes(search))
        )
          empty.items.push(summary);
      }
      if (
        empty.items.length >= query.limit ||
        empty.scanned >= 10000 ||
        responseBytes >= 2 * 1024 * 1024
      ) {
        empty.nextCursor = lineNumber;
        break;
      }
    }
    return empty;
  } catch {
    throw new ApiError(
      503,
      'ADMIN_LOG_UNAVAILABLE',
      'Không đọc được nhật ký chẩn đoán.',
    );
  } finally {
    lines?.close();
    stream?.destroy();
    await handle.close();
  }
}
