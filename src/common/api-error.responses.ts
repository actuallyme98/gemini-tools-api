import type { ApiResponseOptions } from '@nestjs/swagger';

export const apiErrorResponses: ApiResponseOptions[] = [
  400, 401, 403, 404, 413, 422, 429, 500, 502, 503, 504,
].map((status) => ({
  status,
  description:
    'Lỗi có mã phân loại, thông báo cho người dùng và mã yêu cầu để tra cứu log.',
  schema: {
    type: 'object',
    required: [
      'statusCode',
      'code',
      'message',
      'retryable',
      'requestId',
      'path',
      'timestamp',
    ],
    properties: {
      statusCode: { type: 'integer', example: status },
      code: { type: 'string', example: 'AI_BILLING_BLOCKED' },
      message: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
      },
      provider: { type: 'string', example: 'gemini' },
      upstreamStatus: { type: 'integer', example: 403 },
      reason: {
        type: 'string',
        description:
          'Nguyên nhân từ dịch vụ bên ngoài, đã loại bỏ thông tin xác thực.',
      },
      suggestion: { type: 'string' },
      retryable: { type: 'boolean' },
      retryAfterSeconds: { type: 'number' },
      requestId: { type: 'string', format: 'uuid' },
      path: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' },
    },
  },
}));
