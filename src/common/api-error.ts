import { HttpException } from '@nestjs/common';

export interface ApiErrorOptions {
  provider?: string;
  upstreamStatus?: number;
  reason?: string;
  suggestion?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  cause?: unknown;
}

/** Only these public fields are serialized; the original cause stays server-side. */
export class ApiError extends HttpException {
  readonly retryable: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: ApiErrorOptions = {},
  ) {
    const { cause, ...details } = options;
    super(
      {
        statusCode,
        code,
        message,
        ...details,
        retryable: options.retryable ?? false,
      },
      statusCode,
      { cause },
    );
    this.retryable = options.retryable ?? false;
  }
}
