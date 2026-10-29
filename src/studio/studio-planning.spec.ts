import { readAnalysis, readBriefs } from './studio-planning';

describe('Creative planning contract', () => {
  const brief = (index: number) => ({
    title: `Mẫu ${index}`,
    direction: 'Khung mộc',
    composition: 'Chủ thể giữa khung',
    palette: 'Nâu kem',
    prompt: `Tạo ảnh độc lập cho mẫu ${index}, giữ hình học mẫu ảnh chính và chuyển tinh thần thiết kế từ ảnh nguồn.`,
  });
  it('requires explicit observed invariants, editable features, artifacts and risks', () => {
    expect(() => readAnalysis({ summary: 'unknown' })).toThrow();
    expect(
      readAnalysis({
        summary: 'Thú cưng',
        invariants: ['Hình thú cưng'],
        editable: [],
        sourceArtifacts: ['Dây treo'],
        risks: ['Chưa xác minh thương hiệu'],
      }).risks,
    ).toHaveLength(1);
  });
  it('rejects missing, extra and duplicate briefs before any image generation', () => {
    expect(readBriefs({ briefs: [brief(1), brief(2)] }, 2)).toHaveLength(2);
    expect(() => readBriefs({ briefs: [brief(1)] }, 2)).toThrow();
    expect(() => readBriefs({ briefs: [brief(1), brief(2)] }, 1)).toThrow();
    expect(() =>
      readBriefs(
        { briefs: [brief(1), { ...brief(2), prompt: brief(1).prompt }] },
        2,
      ),
    ).toThrow();
  });
});
