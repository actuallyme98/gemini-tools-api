import { envValidationSchema } from './env.validation';

const infrastructure = {
  R2_ACCOUNT_ID: 'account',
  R2_BUCKET_NAME: 'bucket',
  R2_PUBLIC_URL: 'https://cdn.example',
  R2_ACCESS_KEY_ID: 'test-access-key',
  R2_SECRET_ACCESS_KEY: 'test-secret',
  REDIS_URL: 'redis://localhost:6379',
};

describe('AI environment configuration', () => {
  it('defaults to Gemini without requiring an unused OpenAI key', () => {
    const result = envValidationSchema.validate({
      ...infrastructure,
      GEMINI_API_KEY: 'test-key',
    });
    const value: unknown = result.value;
    expect(result.error).toBeUndefined();
    expect(value).toMatchObject({
      AI_PROVIDER: 'gemini',
      AI_AUTO_TEXT_ROUTING: true,
      VYCEAI_HEALTH_TIMEOUT_MS: 10000,
    });
    expect(value).not.toHaveProperty('OPENAI_API_KEY');
  });

  it.each([
    { VYCEAI_HEALTH_TIMEOUT_MS: '0' },
    { VYCEAI_HEALTH_TIMEOUT_MS: '30001' },
    { AI_AUTO_TEXT_ROUTING: 'invalid' },
    { SHOPAIKEY_BASE_URL: 'not-a-url' },
    { SHOPAIKEY_IMAGE_BASE_URL: 'not-a-url' },
    { SHOPAIKEY_TIMEOUT_MS: '0' },
    { SHOPAIKEY_IMAGE_TIMEOUT_MS: '600001' },
  ])('rejects invalid provider options %j', (options) => {
    expect(
      envValidationSchema.validate({ ...infrastructure, ...options }).error,
    ).toBeDefined();
  });

  it('sets ShopAIKey endpoint and text/vision defaults without guessing an image model', () => {
    const result = envValidationSchema.validate({ ...infrastructure });
    const value: unknown = result.value;
    expect(result.error).toBeUndefined();
    expect(value).toMatchObject({
      SHOPAIKEY_BASE_URL: 'https://api.shopaikey.com',
      SHOPAIKEY_IMAGE_BASE_URL: 'https://direct.shopaikey.com',
      SHOPAIKEY_MODEL_TEXT: 'gemini-2.5-flash',
      SHOPAIKEY_MODEL_VISION: 'gemini-2.5-flash',
      SHOPAIKEY_TIMEOUT_MS: 60000,
      SHOPAIKEY_IMAGE_TIMEOUT_MS: 180000,
    });
    expect(value).not.toHaveProperty('SHOPAIKEY_MODEL_IMAGE');
  });

  it('converts ShopAIKey timeout strings from dotenv', () => {
    const result = envValidationSchema.validate({
      ...infrastructure,
      SHOPAIKEY_TIMEOUT_MS: '30000',
      SHOPAIKEY_IMAGE_TIMEOUT_MS: '240000',
    });
    const value: unknown = result.value;
    expect(result.error).toBeUndefined();
    expect(value).toMatchObject({
      SHOPAIKEY_TIMEOUT_MS: 30000,
      SHOPAIKEY_IMAGE_TIMEOUT_MS: 240000,
    });
  });
});
