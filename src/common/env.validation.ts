import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  // Provider IDs are resolved against the registry by AIService at startup.
  AI_PROVIDER: Joi.string().default('shopaikey'),
  AI_TEXT_PROVIDER: Joi.string(),
  AI_VISION_PROVIDER: Joi.string(),
  AI_IMAGE_PROVIDER: Joi.string(),
  AI_AUTO_TEXT_ROUTING: Joi.boolean().default(true),
  VYCEAI_API_KEY: Joi.string(),
  VYCEAI_BASE_URL: Joi.string()
    .uri({ scheme: ['https', 'http'] })
    .default('https://vyceai.com/v1'),
  VYCEAI_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(300000)
    .default(60000),
  VYCEAI_HEALTH_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(30000)
    .default(10000),

  // Credentials are required only for selected providers (AIService validation).
  GEMINI_API_KEY: Joi.string(),
  GEMINI_MODEL_TEXT: Joi.string().default('gemini-2.5-flash-lite'),
  GEMINI_MODEL_MULTIMODAL: Joi.string().default('gemini-2.5-flash'),
  GEMINI_MODEL_IMAGE: Joi.string().default('gemini-2.5-flash-image'),
  OPENAI_API_KEY: Joi.string(),

  SHOPAIKEY_API_KEY: Joi.string(),
  SHOPAIKEY_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('https://api.shopaikey.com'),
  SHOPAIKEY_IMAGE_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('https://direct.shopaikey.com'),
  SHOPAIKEY_MODEL_TEXT: Joi.string().default('gemini-2.5-flash'),
  SHOPAIKEY_MODEL_VISION: Joi.string().default('gemini-2.5-flash'),
  SHOPAIKEY_MODEL_IMAGE: Joi.string(),
  SHOPAIKEY_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(300000)
    .default(60000),
  SHOPAIKEY_IMAGE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(600000)
    .default(180000),

  PORT: Joi.number().integer().min(1).max(65535).default(5177),
  AUDIT_LOG_DIR: Joi.string().default('./logs'),
  AUDIT_LOG_RETENTION_DAYS: Joi.number().integer().min(1).max(90).default(7),
  AUDIT_IMAGE_MAX_BYTES_PER_DAY: Joi.number()
    .integer()
    .min(0)
    .max(10 * 1024 * 1024 * 1024)
    .default(512 * 1024 * 1024),
  R2_PRIVATE_URL: Joi.string().uri({ scheme: ['https', 'http'] }),
  R2_ACCOUNT_ID: Joi.string().required(),
  R2_BUCKET_NAME: Joi.string().required(),
  R2_KEY_PREFIX: Joi.string()
    .trim()
    .max(128)
    .pattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*$/)
    .default('gemini-tools'),
  R2_PUBLIC_URL: Joi.string().uri().required(),
  R2_ACCESS_KEY_ID: Joi.string().required(),
  R2_SECRET_ACCESS_KEY: Joi.string().required(),

  REDIS_URL: Joi.string().uri().required(),
});
