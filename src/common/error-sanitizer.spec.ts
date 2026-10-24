import {
  isSecretEnvironmentVariable,
  sanitizeErrorMessage,
} from './error-sanitizer';

it('keeps ShopAIKey model names useful in diagnostics while still removing the real API credential', () => {
  const previousModel = process.env.SHOPAIKEY_MODEL_TEXT;
  const previousKey = process.env.SHOPAIKEY_API_KEY;
  try {
    process.env.SHOPAIKEY_MODEL_TEXT = 'gemini-test-model';
    process.env.SHOPAIKEY_API_KEY = 'opaque-api-credential-for-unit-test';
    expect(isSecretEnvironmentVariable('SHOPAIKEY_MODEL_TEXT')).toBe(false);
    expect(isSecretEnvironmentVariable('SHOPAIKEY_API_KEY')).toBe(true);
    expect(isSecretEnvironmentVariable('VYCEAI_API_KEY')).toBe(true);
    expect(
      sanitizeErrorMessage(
        'gemini-test-model: opaque-api-credential-for-unit-test',
      ),
    ).toBe('gemini-test-model: [redacted]');
  } finally {
    if (previousModel === undefined) delete process.env.SHOPAIKEY_MODEL_TEXT;
    else process.env.SHOPAIKEY_MODEL_TEXT = previousModel;
    if (previousKey === undefined) delete process.env.SHOPAIKEY_API_KEY;
    else process.env.SHOPAIKEY_API_KEY = previousKey;
  }
});
