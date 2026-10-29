import {
  backgroundSuggestionsPrompt,
  mockupPrompt,
  readBackgroundSuggestions,
} from './studio-mockup-prompt';
describe('Mockup image roles and background suggestions', () => {
  it('keeps the template target separate from prompt-only background editing', () => {
    const template = mockupPrompt(
      { name: 'Etsy scene', instructions: 'Giữ cảnh', kind: 'template' },
      '',
      'Giữ hình in',
    );
    expect(template).toContain('ẢNH 2');
    expect(template).toContain('ẢNH ĐÍCH');
    expect(template).toContain('Giữ cảnh, background');
    expect(template).toContain('Không tạo watermark');
    const background = mockupPrompt(
      { name: 'Vườn', kind: 'background', instructions: 'Nền vườn buổi sáng' },
      'đen',
      'Giữ chữ',
    );
    expect(background).toContain('Chỉ thay nền');
    expect(background).not.toContain('ẢNH 2');
    expect(background).not.toContain('Giữ cảnh, background');
    expect(background).toContain('Nền vườn buổi sáng');
    expect(background).toContain('không đổi màu chữ');
  });
  it('requires the exact count, bounded prompts and genuinely distinct suggestions', () => {
    const value = {
      suggestions: [
        { title: 'Vườn', prompt: 'Chỉ đổi nền thành khu vườn xanh.' },
      ],
    };
    expect(readBackgroundSuggestions(value, 1)).toEqual(value.suggestions);
    expect(() => readBackgroundSuggestions(value, 2)).toThrow();
    expect(() =>
      readBackgroundSuggestions(
        { suggestions: [...value.suggestions, ...value.suggestions] },
        2,
      ),
    ).toThrow();
    expect(() =>
      readBackgroundSuggestions(
        { suggestions: [{ title: 'Vườn', prompt: 'a'.repeat(4001) }] },
        1,
      ),
    ).toThrow();
    expect(
      backgroundSuggestionsPrompt({ type: 'cốc' }, 'Cốc', 'Nền sáng', 3),
    ).toContain('Nền sáng');
  });
});
