import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  GEMINI_API_KEY: Joi.string().required(),
  OPENAI_API_KEY: Joi.string().required(),

  R2_ACCOUNT_ID: Joi.string().required(),
  R2_BUCKET_NAME: Joi.string().required(),
  R2_PUBLIC_URL: Joi.string().uri().required(),
  R2_ACCESS_KEY_ID: Joi.string().required(),
  R2_SECRET_ACCESS_KEY: Joi.string().required(),

  REDIS_URL: Joi.string().uri().required(),
});
