import { HttpException } from '@nestjs/common';
import { ApiError } from './api-error';
import { sanitizeErrorMessage } from './error-sanitizer';

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** Google SDK embeds JSON in Error.message; OpenAI/AWS use other error shapes. */
function describe(error: unknown) {
  const root = record(error);
  let nested = record(root.error);
  let structuredMessage = false;
  if (!Object.keys(nested).length && typeof root.message === 'string') {
    try {
      const parsed = record(JSON.parse(root.message));
      structuredMessage = true;
      nested = record(parsed.error ?? parsed);
    } catch {
      // Plain text errors are normal for network failures and AWS.
    }
  }
  const response = record(root.response);
  const data = record(response.data);
  const detail = Object.keys(nested).length
    ? nested
    : record(data.error ?? data);
  const candidates = [
    root.status,
    root.statusCode,
    record(root.$metadata).httpStatusCode,
    response.status,
    detail.code,
  ];
  const status = candidates
    .map(Number)
    .find((value) => Number.isInteger(value) && value >= 400 && value <= 599);
  const message =
    typeof detail.message === 'string'
      ? detail.message
      : !structuredMessage && typeof root.message === 'string'
        ? root.message
        : '';
  const name = [root.name, root.code, detail.status, detail.code]
    .filter((v) => typeof v === 'string')
    .join(' ');
  return { status, message, name };
}

export function externalServiceError(
  service: 'ai' | 'storage' | 'redis',
  error: unknown,
  provider?: { id: string; name?: string },
): HttpException {
  if (error instanceof HttpException) return error;
  const { status, message, name } = describe(error);
  const source = `${name} ${message}`;
  const label =
    provider?.name ||
    provider?.id ||
    (service === 'storage' ? 'Cloudflare R2' : 'Redis');
  const options = {
    provider: provider?.id,
    upstreamStatus: status,
    reason: message ? sanitizeErrorMessage(message) : undefined,
    cause: error,
  };

  if (service === 'redis')
    return new ApiError(
      503,
      'QUOTA_SERVICE_UNAVAILABLE',
      'Không kiểm tra được giới hạn sử dụng vì dịch vụ quota đang mất kết nối.',
      {
        ...options,
        retryable: true,
        suggestion:
          'Thử lại sau ít phút. Nếu lỗi tiếp diễn, liên hệ quản trị viên.',
      },
    );

  if (service === 'storage') {
    if (
      status === 401 ||
      status === 403 ||
      /AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch/i.test(source)
    )
      return new ApiError(
        502,
        'STORAGE_ACCESS_DENIED',
        'Không lưu được ảnh lên Cloudflare R2: thông tin truy cập hoặc quyền ghi bucket không hợp lệ.',
        {
          ...options,
          suggestion: 'Quản trị viên cần kiểm tra key R2 và quyền ghi bucket.',
        },
      );
    if (status === 404 || /NoSuchBucket/i.test(source))
      return new ApiError(
        502,
        'STORAGE_BUCKET_NOT_FOUND',
        'Không lưu được ảnh: bucket Cloudflare R2 không tồn tại hoặc sai cấu hình.',
        {
          ...options,
          suggestion: 'Quản trị viên cần kiểm tra tên bucket và endpoint R2.',
        },
      );
    return new ApiError(
      503,
      'STORAGE_UNAVAILABLE',
      'Không lưu được ảnh vì Cloudflare R2 đang gặp lỗi kết nối hoặc dịch vụ.',
      { ...options, retryable: true, suggestion: 'Thử lại sau ít phút.' },
    );
  }

  if (
    /is required when using|missing.*(?:configuration|api.?key)/i.test(source)
  )
    return new ApiError(
      503,
      'AI_CONFIGURATION_ERROR',
      `${label} chưa được cấu hình đầy đủ trên máy chủ.`,
      {
        ...options,
        suggestion: 'Quản trị viên cần kiểm tra API key và cấu hình model.',
      },
    );
  if (
    /dunning|billing.*(?:disabled|denied|suspended|inactive|blocked)|payment required|insufficient_(?:quota|credits)|credit balance/i.test(
      source,
    ) ||
    status === 402
  )
    return new ApiError(
      503,
      'AI_BILLING_BLOCKED',
      `${label} từ chối yêu cầu do project hoặc tài khoản thanh toán bị chặn / chưa đủ điều kiện sử dụng.`,
      {
        ...options,
        suggestion:
          'Quản trị viên cần kiểm tra trạng thái project, Billing và cảnh báo của provider.',
      },
    );
  if (
    status === 401 ||
    /API_KEY_INVALID|invalid api.?key|api key not valid/i.test(source)
  )
    return new ApiError(
      502,
      'AI_AUTHENTICATION_FAILED',
      `${label}: API key không hợp lệ, đã hết hạn hoặc bị thu hồi.`,
      {
        ...options,
        suggestion: 'Quản trị viên cần cập nhật API key của provider.',
      },
    );
  if (status === 403)
    return new ApiError(
      502,
      'AI_PERMISSION_DENIED',
      `${label} từ chối quyền truy cập model hoặc project.`,
      {
        ...options,
        suggestion:
          'Quản trị viên cần kiểm tra quyền API key, project và các hạn chế truy cập.',
      },
    );
  if (
    status === 404 ||
    /model.*(?:not found|no longer available|not available|does not exist)/i.test(
      source,
    )
  )
    return new ApiError(
      502,
      'AI_MODEL_UNAVAILABLE',
      `${label}: model đang cấu hình không tồn tại hoặc tài khoản chưa được phép dùng.`,
      {
        ...options,
        suggestion:
          'Quản trị viên cần chọn model được provider hỗ trợ cho tài khoản này.',
      },
    );
  if (status === 429) {
    const quota = /quota|RESOURCE_EXHAUSTED|daily limit/i.test(source);
    return new ApiError(
      429,
      quota ? 'AI_QUOTA_EXCEEDED' : 'AI_RATE_LIMITED',
      `${label}: ${quota ? 'đã vượt quota sử dụng' : 'đang nhận quá nhiều yêu cầu'}.`,
      {
        ...options,
        retryable: !quota,
        suggestion: quota
          ? 'Kiểm tra quota của provider hoặc chờ quota được đặt lại.'
          : 'Chờ ít phút rồi thử lại.',
      },
    );
  }
  if (
    status === 408 ||
    status === 504 ||
    /Timeout|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(source)
  )
    return new ApiError(
      504,
      'AI_TIMEOUT',
      `${label} phản hồi quá thời gian cho phép.`,
      {
        ...options,
        retryable: true,
        suggestion: 'Thử lại với ít ảnh hơn hoặc sau ít phút.',
      },
    );
  if (
    /AI provider (?:returned|must return)|No (?:image|images|content) returned/i.test(
      source,
    )
  )
    return new ApiError(
      502,
      'AI_INVALID_RESPONSE',
      `${label} không trả về kết quả hợp lệ cho tác vụ này.`,
      {
        ...options,
        suggestion: 'Thử điều chỉnh prompt hoặc chọn provider khác.',
      },
    );
  if (/safety|blocked|prohibited|content policy/i.test(source))
    return new ApiError(
      422,
      'AI_CONTENT_BLOCKED',
      `${label} từ chối xử lý nội dung hoặc hình ảnh này.`,
      { ...options, suggestion: 'Điều chỉnh prompt hoặc chọn hình ảnh khác.' },
    );
  if (status === 400 || status === 422)
    return new ApiError(
      422,
      'AI_REQUEST_REJECTED',
      `${label} không chấp nhận dữ liệu hoặc tham số của yêu cầu.`,
      {
        ...options,
        suggestion:
          'Kiểm tra ảnh và prompt. Nếu lỗi tiếp diễn, quản trị viên cần kiểm tra cấu hình model.',
      },
    );
  if (status && status >= 500)
    return new ApiError(
      503,
      'AI_UNAVAILABLE',
      `${label} đang gặp lỗi dịch vụ.`,
      { ...options, retryable: true, suggestion: 'Thử lại sau ít phút.' },
    );
  if (
    /ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|APIConnectionError|socket/i.test(
      source,
    )
  )
    return new ApiError(
      503,
      'AI_CONNECTION_FAILED',
      `Không kết nối được ${label}.`,
      {
        ...options,
        retryable: true,
        suggestion:
          'Thử lại sau ít phút. Quản trị viên cần kiểm tra kết nối tới provider nếu lỗi tiếp diễn.',
      },
    );
  return new ApiError(
    502,
    'AI_PROVIDER_ERROR',
    `${label} xử lý tác vụ thất bại.`,
    {
      ...options,
      suggestion: 'Kiểm tra nguyên nhân từ provider hoặc chọn provider khác.',
    },
  );
}
