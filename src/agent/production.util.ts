import { ApiError } from '../common/api-error';
export function parseCsv(csv: string): string[][] {
  if (Buffer.byteLength(csv) > 1_000_000)
    throw new ApiError(413, 'BATCH_CSV_TOO_LARGE', 'CSV tối đa 1 MB.');
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    afterQuote = false;
  const field = () => {
    row.push(cell.trim());
    cell = '';
    afterQuote = false;
  };
  const finish = () => {
    field();
    if (row.some(Boolean)) rows.push(row);
    row = [];
    if (rows.length > 501)
      throw new ApiError(400, 'BATCH_ROW_LIMIT', 'Tối đa 500 dòng mỗi batch.');
  };
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        afterQuote = true;
      } else cell += c;
    } else if (c === ',') field();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && csv[i + 1] === '\n') i++;
      finish();
    } else if (c === '"' && !cell && !afterQuote) quoted = true;
    else if (afterQuote && c.trim())
      throw new ApiError(
        400,
        'BATCH_CSV_INVALID',
        'CSV có ký tự ngoài dấu ngoặc kép.',
      );
    else if (c === '"')
      throw new ApiError(
        400,
        'BATCH_CSV_INVALID',
        'Dấu ngoặc kép CSV không hợp lệ.',
      );
    else cell += c;
  }
  if (quoted)
    throw new ApiError(
      400,
      'BATCH_CSV_INVALID',
      'CSV thiếu dấu đóng ngoặc kép.',
    );
  if (cell || row.length) finish();
  if (!rows.length || new Set(rows[0]).size !== rows[0].length)
    throw new ApiError(
      400,
      'BATCH_CSV_INVALID',
      'CSV cần tiêu đề cột không trùng nhau.',
    );
  rows[0][0] = rows[0][0].replace(/^\uFEFF/, '');
  if (rows.some((r) => r.length !== rows[0].length))
    throw new ApiError(400, 'BATCH_CSV_INVALID', 'Số cột không đồng nhất.');
  return rows;
}
export const skuValid = (sku: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(sku);
export type ExportPreset = {
  name: string;
  width: number;
  height: number;
  dpi: number;
  transparent: boolean;
  safeMargin: number;
  approvedOnly: boolean;
};
