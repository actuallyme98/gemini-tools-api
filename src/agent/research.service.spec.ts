import {
  publicAddress,
  publicUrl,
  rssSources,
  pageText,
} from './research.service';
it('rejects private, mapped and reserved network addresses', () => {
  for (const value of [
    '127.0.0.1',
    '169.254.169.254',
    '10.0.0.2',
    '172.16.0.1',
    '100.64.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '2002:7f00:1::',
  ])
    expect(publicAddress(value)).toBe(false);
  expect(publicAddress('8.8.8.8')).toBe(true);
  for (const value of [
    'http://example.com',
    'https://127.0.0.1',
    'https://user:pass@example.com',
    'https://example.com:444',
  ])
    expect(() => publicUrl(value)).toThrow();
});
it('extracts source provenance without executing embedded markup', () => {
  expect(pageText('<script>secret()</script><h1>A &amp; B</h1>')).toBe('A & B');
  expect(
    rssSources(
      '<rss><item><title>Test</title><link>https://example.com/a</link><description>Real source</description></item></rss>',
    ),
  ).toEqual([
    { title: 'Test', url: 'https://example.com/a', snippet: 'Real source' },
  ]);
});
