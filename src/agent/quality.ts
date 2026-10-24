import * as Joi from 'joi';
export const qualityCriteria = [
  'source_target',
  'product_count',
  'text',
  'colors',
  'proportions',
  'new_watermark',
] as const;
export type QualityCriterion = (typeof qualityCriteria)[number];
export type QualityReport = {
  criteria: {
    criterion: QualityCriterion;
    status: 'pass' | 'review' | 'fail';
    confidence: number;
    evidence: string;
  }[];
  expectedCount: number;
  actualCount: number | null;
  notes: string[];
};
export const qualitySchema = Joi.object({
  criteria: Joi.array()
    .items(
      Joi.object({
        criterion: Joi.string()
          .valid(...qualityCriteria)
          .required(),
        status: Joi.string().valid('pass', 'review', 'fail').required(),
        confidence: Joi.number().min(0).max(1).required(),
        evidence: Joi.string().min(1).max(600).required(),
      }),
    )
    .length(6)
    .unique('criterion')
    .required(),
  expectedCount: Joi.number().integer().min(1).max(100).required(),
  actualCount: Joi.number().integer().min(0).max(100).allow(null).required(),
  notes: Joi.array().items(Joi.string().max(1000)).max(8).required(),
});
export function qualityVerdict(report: QualityReport) {
  return report.criteria.length === 6 &&
    qualityCriteria.every((key) =>
      report.criteria.some(
        (c) =>
          c.criterion === key && c.status === 'pass' && c.confidence >= 0.85,
      ),
    ) &&
    report.expectedCount === report.actualCount
    ? 'pass'
    : 'review';
}
