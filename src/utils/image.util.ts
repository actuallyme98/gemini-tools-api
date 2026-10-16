/** Identify formats supported by our storage and browser image workflows. */
export function imageMimeType(buffer: Buffer): string | undefined {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  )
    return 'image/png';
  if (
    buffer.length >= 3 &&
    buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
  )
    return 'image/jpeg';
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  return undefined;
}
