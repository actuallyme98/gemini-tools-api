import {
  qualityCriteria,
  qualityVerdict,
  qualitySchema,
  type QualityReport,
} from './quality';
const report = (): QualityReport => ({
  criteria: qualityCriteria.map((criterion) => ({
    criterion,
    status: 'pass',
    confidence: 0.99,
    evidence: 'Observed',
  })),
  expectedCount: 3,
  actualCount: 3,
  notes: [],
});
it('requires every criterion, high confidence and the correct product count', () => {
  expect(qualityVerdict(report())).toBe('pass');
  const uncertain = report();
  uncertain.criteria[0].confidence = 0.84;
  expect(qualityVerdict(uncertain)).toBe('review');
  expect(qualityVerdict({ ...report(), actualCount: 1 })).toBe('review');
  expect(
    qualitySchema.validate({
      ...report(),
      criteria: Array(6).fill(report().criteria[0]),
    }).error,
  ).toBeDefined();
});
