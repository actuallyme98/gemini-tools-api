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
};
export function diagnosticSummary(input: Record<string, unknown>) {
  const redact = (value: string) =>
    sanitizeErrorMessage(value, 1000).replace(
      /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g,
      '[redacted]',
    );
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
export async function readAdminDiagnostics(
  directory: string,
  query: DiagnosticQuery,
) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(query.day) ||
    !Number.isFinite(Date.parse(query.day)) ||
    new Date(query.day).toISOString().slice(0, 10) !== query.day
  )
    throw new ApiError(400, 'ADMIN_LOG_DATE_INVALID', 'Ngày log không hợp lệ.');
  const day = path.resolve(directory, query.day);
  const file = path.join(day, 'events.jsonl');
  const empty = {
    items: [] as Record<string, string | number | boolean>[],
    nextCursor: null as number | null,
    scanned: 0,
    malformed: 0,
  };
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
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
        if (
          (!query.errorsOnly || isError) &&
          (!search || JSON.stringify(summary).toLowerCase().includes(search))
        )
          empty.items.push(summary);
      }
      if (empty.items.length >= query.limit || empty.scanned >= 10000) {
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
