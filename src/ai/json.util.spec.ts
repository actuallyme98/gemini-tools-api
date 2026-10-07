import { parseAIJSON } from './json.util';

describe('AI JSON response parsing', () => {
  it.each(['["one"]', '```json\n["one"]\n```', '```\n["one"]\n```'])(
    'accepts raw or fenced JSON',
    (text) => {
      expect(parseAIJSON(text)).toEqual(['one']);
    },
  );

  it.each([undefined, null, '', '  ', '```json\n```'])(
    'rejects empty responses',
    (text) => {
      expect(() => parseAIJSON(text)).toThrow('empty JSON');
    },
  );

  it('does not expose payload data in parse errors', () => {
    expect(() => parseAIJSON('private customer text')).toThrow('invalid JSON');
    expect(() => parseAIJSON('private customer text')).not.toThrow(
      'private customer text',
    );
  });
});
