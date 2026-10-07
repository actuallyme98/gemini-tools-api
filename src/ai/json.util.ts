export function parseAIJSON(text: string | null | undefined): unknown {
  const cleaned = (text ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  if (!cleaned) {
    throw new Error('AI provider returned an empty JSON response');
  }

  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    // Do not include the response payload; it can contain customer data.
    throw new Error('AI provider returned invalid JSON');
  }
}
