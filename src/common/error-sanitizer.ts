/** Redact credentials from dependency messages and logs before truncating them. */
export function sanitizeErrorMessage(value: string, maxLength = 800): string {
  let text = value;
  for (const [name, secret] of Object.entries(process.env)) {
    if (
      /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) &&
      secret &&
      secret.length >= 8
    )
      text = text.split(secret).join('[redacted]');
  }
  return text
    .replace(/\b(?:sk-[\w-]{8,}|AIza[\w-]{8,}|AQ\.[\w-]{8,})/g, '[redacted]')
    .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(
      /((?:api[_-]?key|token|secret|password|signature|credential)["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi,
      '$1[redacted]',
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/data:[\w/+.-]+;base64,[\w+/=]+/gi, '[image redacted]')
    .replace(/\p{Cc}/gu, (character) =>
      '\t\n\r'.includes(character) ? character : '',
    )
    .slice(0, maxLength);
}
