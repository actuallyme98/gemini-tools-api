import { parseCsv, skuValid } from './production.util';
it('parses quoted commas, escaped quotes and multiline cells', () => {
  expect(parseCsv('sku,prompt\r\na,"hello, ""world""\nnext"\r\n')).toEqual([
    ['sku', 'prompt'],
    ['a', 'hello, "world"\nnext'],
  ]);
  expect(() => parseCsv('a,b\nx,"oops')).toThrow();
  expect(() => parseCsv('a,b\nx,y,z')).toThrow();
  expect(skuValid('../../file')).toBe(false);
});
