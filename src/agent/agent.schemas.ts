import * as Joi from 'joi';
import { ApiError } from '../common/api-error';
export const idSchema = Joi.string().guid({ version: 'uuidv4' });
const ids = Joi.array().items(idSchema).max(20).unique().default([]);
export const loginSchema = Joi.object({
  email: Joi.string().email().max(254).required(),
  password: Joi.string().min(12).max(128).required(),
});
export const userSchema = loginSchema.keys({
  role: Joi.string().valid('admin', 'designer').default('designer'),
});
export const messageSchema = Joi.object({
  approvalMode: Joi.string().valid('manual', 'auto').default('manual'),
  id: idSchema.required(),
  text: Joi.string().trim().min(3).max(12000).required(),
  operation: Joi.string()
    .valid('auto', 'mockup_ai', 'mockup_template', 'design')
    .required(),
  sourceIds: ids,
  targetIds: ids,
  templateIds: ids,
  count: Joi.number().integer().min(1).max(20).default(3),
  provider: Joi.string().valid('shopaikey', 'gemini').default('shopaikey'),
  imageModel: Joi.string().trim().max(180),
  productType: Joi.string().trim().max(100).default('Sản phẩm POD'),
  research: Joi.string().max(20000).allow('').default(''),
  researchSources: Joi.array()
    .items(
      Joi.object({
        title: Joi.string().max(200).required(),
        url: Joi.string()
          .uri({ scheme: ['https', 'http'] })
          .max(2048)
          .required(),
        retrievedAt: Joi.string().isoDate().required(),
      }),
    )
    .max(20)
    .default([]),
  validateVisually: Joi.boolean().default(true),
});
export const questionsSchema = Joi.array()
  .items(
    Joi.alternatives().try(
      Joi.string().trim().min(1).max(1000),
      Joi.object({
        question: Joi.string().trim().min(3).max(1000).required(),
        options: Joi.array()
          .items(
            Joi.object({
              label: Joi.string().trim().min(1).max(160).required(),
              description: Joi.string().max(400).allow(''),
            }),
          )
          .min(2)
          .max(4)
          .required(),
      }),
    ),
  )
  .max(5)
  .required();
export const planResponseSchema = Joi.object({
  summary: Joi.string().max(6000).required(),
  questions: questionsSchema,
  items: Joi.array()
    .items(
      Joi.object({
        title: Joi.string().max(200).required(),
        prompt: Joi.string().min(3).max(20000).required(),
      }),
    )
    .max(20)
    .required(),
});
export const editPlanSchema = Joi.object({
  updatedAt: Joi.string().isoDate().required(),
  items: Joi.array()
    .items(
      Joi.object({
        title: Joi.string().max(200).required(),
        prompt: Joi.string().trim().min(3).max(22000).required(),
      }),
    )
    .min(1)
    .max(20)
    .required(),
});
export const inputSelectionSchema = Joi.object({
  sourceIds: Joi.array().items(idSchema).max(20).unique().required(),
  targetIds: Joi.array().items(idSchema).max(20).unique().required(),
  templateIds: Joi.array().items(idSchema).max(20).unique().required(),
});
export const changeInputsSchema = inputSelectionSchema.keys({
  updatedAt: Joi.string().isoDate().required(),
});
export const startSchema = Joi.object({
  updatedAt: Joi.string().isoDate().required(),
  inputs: inputSelectionSchema,
});
export const templateSchema = Joi.object({
  name: Joi.string().trim().max(120).required(),
  category: Joi.string().trim().max(100).required(),
  assetId: idSchema.required(),
  corners: Joi.array()
    .items(
      Joi.object({
        x: Joi.number().min(0).max(1).required(),
        y: Joi.number().min(0).max(1).required(),
      }),
    )
    .length(4)
    .required(),
  opacity: Joi.number().min(0.05).max(1).default(1),
  blend: Joi.string().valid('over', 'multiply').default('over'),
  maskAssetId: idSchema,
  overlayAssetId: idSchema,
});
export function parse<T>(schema: Joi.Schema, input: unknown): T {
  const result = schema.validate(input, {
    abortEarly: true,
    convert: false,
    allowUnknown: false,
  });
  if (result.error)
    throw new ApiError(
      400,
      'AGENT_INPUT_INVALID',
      result.error.details[0].message,
    );
  return result.value as T;
}
