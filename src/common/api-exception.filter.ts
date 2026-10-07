import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { sanitizeErrorMessage } from './error-sanitizer';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    if (response.headersSent || response.destroyed) return;
    const requestId = randomUUID();
    const parser =
      typeof exception === 'object' && exception !== null
        ? (exception as Record<string, unknown>)
        : {};
    const statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : parser.type === 'entity.parse.failed'
          ? 400
          : parser.type === 'entity.too.large'
            ? 413
            : 500;
    const raw =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const data =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)
        : {};
    const defaults: Record<number, [string, string]> = {
      400: ['INVALID_REQUEST', 'Dữ liệu gửi lên không hợp lệ.'],
      401: ['UNAUTHORIZED', 'Bạn cần xác thực để sử dụng chức năng này.'],
      403: ['FORBIDDEN', 'Bạn không có quyền thực hiện tác vụ này.'],
      404: ['NOT_FOUND', 'Không tìm thấy API hoặc tài nguyên yêu cầu.'],
      413: ['UPLOAD_TOO_LARGE', 'Mỗi ảnh tải lên phải nhỏ hơn hoặc bằng 10MB.'],
      429: ['RATE_LIMITED', 'Quá nhiều yêu cầu. Vui lòng chờ rồi thử lại.'],
      500: [
        'INTERNAL_ERROR',
        'Máy chủ gặp lỗi khi xử lý yêu cầu. Liên hệ quản trị viên kèm mã yêu cầu để kiểm tra.',
      ],
      502: ['UPSTREAM_ERROR', 'Dịch vụ bên ngoài trả về kết quả không hợp lệ.'],
      503: ['SERVICE_UNAVAILABLE', 'Dịch vụ tạm thời không khả dụng.'],
      504: ['REQUEST_TIMEOUT', 'Yêu cầu xử lý quá thời gian cho phép.'],
    };
    const [defaultCode, defaultMessage] = defaults[statusCode] || [
      'REQUEST_FAILED',
      'Không thể hoàn thành yêu cầu.',
    ];
    const message = typeof raw === 'string' ? raw : data.message;
    // Nest wraps body-parser SyntaxError as BadRequestException and drops its type.
    const invalidJson =
      parser.type === 'entity.parse.failed' ||
      (statusCode === 400 &&
        !!request.is('application/json') &&
        typeof message === 'string' &&
        /JSON|Unexpected token|Unexpected end|Expected property name/i.test(
          message,
        ));
    const fields: Record<string, unknown> = {};
    for (const key of ['provider', 'reason', 'suggestion'])
      if (typeof data[key] === 'string')
        fields[key] = sanitizeErrorMessage(data[key]);
    for (const key of ['upstreamStatus', 'retryAfterSeconds'])
      if (typeof data[key] === 'number' && Number.isFinite(data[key]))
        fields[key] = data[key];
    const body = {
      statusCode,
      code: invalidJson
        ? 'INVALID_JSON'
        : typeof data.code === 'string'
          ? data.code
          : Array.isArray(message)
            ? 'VALIDATION_ERROR'
            : defaultCode,
      message: invalidJson
        ? 'Dữ liệu JSON gửi lên không đúng định dạng.'
        : statusCode === 413
          ? defaultMessage
          : typeof message === 'string'
            ? sanitizeErrorMessage(message)
            : Array.isArray(message)
              ? message
                  .filter((v): v is string => typeof v === 'string')
                  .map((v) => sanitizeErrorMessage(v))
              : defaultMessage,
      ...fields,
      retryable:
        typeof data.retryable === 'boolean'
          ? data.retryable
          : statusCode === 429 || statusCode === 503 || statusCode === 504,
      requestId,
      path: request.path,
      timestamp: new Date().toISOString(),
    };
    if (statusCode >= 500) {
      const cause =
        exception instanceof HttpException ? exception.cause : exception;
      const diagnostic =
        cause instanceof Error ? cause.stack || cause.message : '';
      this.logger.error(
        JSON.stringify({
          ...body,
          method: request.method,
          diagnostic: sanitizeErrorMessage(diagnostic, 4000),
        }),
      );
    }
    response.setHeader('X-Request-Id', requestId);
    if (typeof fields.retryAfterSeconds === 'number')
      response.setHeader('Retry-After', fields.retryAfterSeconds);
    response.status(statusCode).json(body);
  }
}
