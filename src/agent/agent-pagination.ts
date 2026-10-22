import { ApiError } from '../common/api-error';

export function encodeCursor(position: string) {
  return Buffer.from(position, 'utf8').toString('base64url');
}
export function decodeCursor(cursor?: string) {
  if (!cursor) return undefined;
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  if (
    cursor.length > 400 ||
    encodeCursor(value) !== cursor ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[\w:-]{1,160}$/.test(value)
  )
    throw new ApiError(
      400,
      'AGENT_CURSOR_INVALID',
      'Vị trí tải lịch sử không hợp lệ.',
    );
  return value;
}
