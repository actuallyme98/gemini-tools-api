import { BadRequestException } from '@nestjs/common';
import { externalServiceError } from './external-service-error';
import { ApiError } from './api-error';

const provider = { id: 'gemini', name: 'Gemini' };
describe('Dependency errors exposed to the client', () => {
  it('extracts the real Google billing denial from SDK JSON', () => {
    const error = Object.assign(
      new Error(
        JSON.stringify({
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message:
              'Lightning dunning decision is deny for project: projects/123',
          },
        }),
      ),
      { status: 403 },
    );
    const result = externalServiceError('ai', error, provider);
    expect(result.getStatus()).toBe(503);
    expect(result.getResponse()).toMatchObject({
      code: 'AI_BILLING_BLOCKED',
      provider: 'gemini',
      upstreamStatus: 403,
      reason: 'Lightning dunning decision is deny for project: projects/123',
      retryable: false,
    });
  });
  it.each([
    [401, 'Invalid API key', 'AI_AUTHENTICATION_FAILED', 502, false],
    [403, 'Permission denied', 'AI_PERMISSION_DENIED', 502, false],
    [404, 'Model not found', 'AI_MODEL_UNAVAILABLE', 502, false],
    [429, 'RESOURCE_EXHAUSTED quota exceeded', 'AI_QUOTA_EXCEEDED', 429, false],
    [429, 'Too many requests', 'AI_RATE_LIMITED', 429, true],
    [504, 'Deadline exceeded', 'AI_TIMEOUT', 504, true],
    [503, 'Service unavailable', 'AI_UNAVAILABLE', 503, true],
    [400, 'Unsupported input image', 'AI_REQUEST_REJECTED', 422, false],
    [402, 'Payment required', 'AI_BILLING_BLOCKED', 503, false],
  ])(
    'normalizes status %s / %s',
    (status, message, code, expectedStatus, retryable) => {
      const result = externalServiceError(
        'ai',
        { status, error: { message } },
        provider,
      );
      expect(result.getStatus()).toBe(expectedStatus);
      expect(result.getResponse()).toMatchObject({
        code,
        retryable,
        upstreamStatus: status,
      });
    },
  );
  it('redacts secrets and signed URLs, without exposing provider response payloads', () => {
    const key = 'arbitrary-provider-private-credential';
    process.env.TEST_PROVIDER_API_KEY = key;
    try {
      const result = externalServiceError(
        'ai',
        {
          status: 401,
          message: `Invalid key ${key}; token=super-private; https://cdn.example/img?signature=secret`,
          body: { image: 'private customer image' },
        },
        provider,
      );
      const body = JSON.stringify(result.getResponse());
      expect(body).not.toContain(key);
      expect(body).not.toContain('super-private');
      expect(body).not.toContain('signature=secret');
      expect(body).not.toContain('private customer image');
      expect(body).toContain('[redacted]');
    } finally {
      delete process.env.TEST_PROVIDER_API_KEY;
    }
  });
  it('handles AWS metadata and bucket failures as storage errors', () => {
    expect(
      externalServiceError('storage', {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      }).getResponse(),
    ).toMatchObject({
      code: 'STORAGE_ACCESS_DENIED',
      upstreamStatus: 403,
      retryable: false,
    });
    expect(
      externalServiceError('storage', {
        name: 'NoSuchBucket',
        $metadata: { httpStatusCode: 404 },
      }).getResponse(),
    ).toMatchObject({ code: 'STORAGE_BUCKET_NOT_FOUND' });
    expect(
      externalServiceError('storage', new Error('ECONNRESET')).getResponse(),
    ).toMatchObject({ code: 'STORAGE_UNAVAILABLE', retryable: true });
  });
  it('preserves application errors and distinguishes broken output from connection failures', () => {
    const error = new BadRequestException('Invalid request');
    expect(externalServiceError('ai', error, provider)).toBe(error);
    expect(
      externalServiceError(
        'ai',
        new Error('AI provider returned invalid JSON'),
        provider,
      ).getResponse(),
    ).toMatchObject({ code: 'AI_INVALID_RESPONSE', retryable: false });
    expect(
      externalServiceError(
        'ai',
        new Error('fetch failed'),
        provider,
      ).getResponse(),
    ).toMatchObject({ code: 'AI_CONNECTION_FAILED', retryable: true });
    expect(
      externalServiceError('redis', new Error('ECONNREFUSED')).getResponse(),
    ).toMatchObject({ code: 'QUOTA_SERVICE_UNAVAILABLE', retryable: true });
  });
  it('does not serialize the original cause', () => {
    const error = new ApiError(502, 'TEST', 'Error', {
      cause: new Error('private cause'),
    });
    expect(JSON.stringify(error.getResponse())).not.toContain('private cause');
    expect(error.cause).toBeInstanceOf(Error);
  });
  it('does not expose an unexpected JSON payload as the error reason', () => {
    const error = new Error(
      JSON.stringify({
        image: 'private customer image',
        prompt: 'private prompt',
      }),
    );
    const response = JSON.stringify(
      externalServiceError('ai', error, provider).getResponse(),
    );
    expect(response).not.toContain('private customer');
    expect(response).not.toContain('private prompt');
  });
});
