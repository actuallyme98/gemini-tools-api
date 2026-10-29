import JSZip from 'jszip';
import { readSkillBundle } from './skill-bundle';
import { nextStudioNight } from './studio.util';

describe('Studio skill ZIP and timezone', () => {
  it('reads a nested SKILL.md and bundled references without executing code', async () => {
    const zip = new JSZip();
    zip.file('skill/SKILL.md', '# Creative\nRead references/SPEC.md');
    zip.file('skill/references/SPEC.md', 'Flat printed product');
    const result = await readSkillBundle(
      await zip.generateAsync({ type: 'nodebuffer' }),
    );
    expect(result.instructions).toContain('# Creative');
    expect(result.documents[0].content).toBe('Flat printed product');
    expect(result.issues).toEqual([]);
    expect(result.bundleHash).toHaveLength(64);
  });
  it('rejects traversal and multiple root instructions', async () => {
    const zip = new JSZip();
    zip.file('../SKILL.md', 'bad');
    await expect(
      readSkillBundle(await zip.generateAsync({ type: 'nodebuffer' })),
    ).rejects.toThrow();
    const multiple = new JSZip();
    multiple.file('a/SKILL.md', 'a');
    multiple.file('b/SKILL.md', 'b');
    await expect(
      readSkillBundle(await multiple.generateAsync({ type: 'nodebuffer' })),
    ).rejects.toThrow();
  });
  it('flags executable dependencies so the bundle cannot be approved', async () => {
    const zip = new JSZip();
    zip.file('SKILL.md', 'run python scripts/render.py');
    zip.file('scripts/render.py', 'do not execute');
    expect(
      (await readSkillBundle(await zip.generateAsync({ type: 'nodebuffer' })))
        .issues.length,
    ).toBeGreaterThan(0);
  });
  it('stops reading a compressed oversized entry', async () => {
    const zip = new JSZip();
    zip.file('SKILL.md', Buffer.alloc(17 * 1024 * 1024, 65));
    await expect(
      readSkillBundle(
        await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
      ),
    ).rejects.toThrow();
  });
  it('selects the next 22:00 in UTC+7 including the exact cutoff and date rollover', () => {
    expect(nextStudioNight(new Date('2026-10-28T14:59:59Z'))).toBe(
      '2026-10-28T15:00:00.000Z',
    );
    expect(nextStudioNight(new Date('2026-10-28T15:00:00Z'))).toBe(
      '2026-10-29T15:00:00.000Z',
    );
    expect(nextStudioNight(new Date('2026-12-31T18:00:00Z'))).toBe(
      '2027-01-01T15:00:00.000Z',
    );
  });
  it('blocks missing local dependencies while only warning about external links', async () => {
    const zip = new JSZip();
    zip.file(
      'bundle/SKILL.md',
      'Read `references/SPEC.md` and [Guide](references/MISSING.md). [External](https://example.test/guide)',
    );
    zip.file('bundle/references/SPEC.md', 'Read [Style](STYLE.md)');
    zip.file('bundle/references/STYLE.md', 'Use flat printed style.');
    const result = await readSkillBundle(
      await zip.generateAsync({ type: 'nodebuffer' }),
    );
    expect(result.issues.join()).toContain('MISSING.md');
    expect(result.warnings.join()).toContain('example.test');
    expect(result.activeDocumentPaths).toContain('bundle/references/STYLE.md');
  });
  it('uses configurable daily times, midnight, exact cutoffs and UTC+7 date rollover', () => {
    expect(nextStudioNight(new Date('2026-10-28T13:29:59Z'), '20:30')).toBe(
      '2026-10-28T13:30:00.000Z',
    );
    expect(nextStudioNight(new Date('2026-10-28T13:30:00Z'), '20:30')).toBe(
      '2026-10-29T13:30:00.000Z',
    );
    expect(nextStudioNight(new Date('2026-12-31T17:00:00Z'), '00:00')).toBe(
      '2027-01-01T17:00:00.000Z',
    );
    for (const time of ['24:00', '22:60', '9:30', 'abc'])
      expect(() => nextStudioNight(new Date(), time)).toThrow(RangeError);
  });
  it('preserves archive references as evidence without including superseded instructions in active context', async () => {
    const zip = new JSZip();
    zip.file(
      'SKILL.md',
      'version: 2.2\nUse `references/ARCHIVE.md` only as history.',
    );
    zip.file('references/ARCHIVE.md', 'Force an old quota.');
    const result = await readSkillBundle(
      await zip.generateAsync({ type: 'nodebuffer' }),
    );
    expect(
      result.documents.some((document) => document.path.includes('ARCHIVE')),
    ).toBe(true);
    expect(result.activeDocumentPaths).not.toContain('references/ARCHIVE.md');
    expect(result.declaredVersion).toBe('2.2');
  });
});
