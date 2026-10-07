# API error contract

All failed requests use the same JSON shape. Successful responses are unchanged. The contract is also documented for each endpoint in `/api/docs`.

```json
{
  "statusCode": 503,
  "code": "AI_BILLING_BLOCKED",
  "message": "Gemini từ chối yêu cầu do project hoặc tài khoản thanh toán bị chặn / chưa đủ điều kiện sử dụng.",
  "provider": "gemini",
  "upstreamStatus": 403,
  "reason": "Lightning dunning decision is deny for project: projects/123",
  "suggestion": "Quản trị viên cần kiểm tra trạng thái project, Billing và cảnh báo của provider.",
  "retryable": false,
  "requestId": "00000000-0000-4000-8000-000000000000",
  "path": "/api/ideas/analyze-product",
  "timestamp": "2026-10-07T09:00:00.000Z"
}
```

`message` is a user-facing string or an array of validation messages. `provider`, `upstreamStatus`, `reason`, `suggestion`, and `retryAfterSeconds` are optional. `reason` contains the dependency's error message, with credentials, URLs, and inline images redacted. Error causes, stack traces, request bodies, and dependency response payloads are not sent to clients. Unknown application failures remain HTTP 500, with a safe message and a request ID that matches the server log and `X-Request-Id` response header.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR`, `INVALID_REQUEST`, `INVALID_JSON` | Invalid fields, file format, or JSON |
| 400 | `AI_PROVIDER_INVALID`, `AI_PROVIDER_NOT_CONFIGURED`, `AI_CAPABILITY_UNAVAILABLE` | Selected provider cannot handle the requested task |
| 413 | `UPLOAD_TOO_LARGE` | Upload exceeds the size limit |
| 422 | `AI_REQUEST_REJECTED`, `AI_CONTENT_BLOCKED` | Provider rejects the input or content |
| 429 | `AI_QUOTA_EXCEEDED`, `AI_RATE_LIMITED`, `DAILY_QUOTA_EXCEEDED`, `RATE_LIMITED` | Provider or application usage limit |
| 502 | `AI_AUTHENTICATION_FAILED`, `AI_PERMISSION_DENIED`, `AI_MODEL_UNAVAILABLE` | Provider credentials, permissions, or model configuration |
| 502 | `AI_INVALID_RESPONSE`, `AI_OUTPUT_TRUNCATED`, `AI_PROVIDER_ERROR` | Invalid, truncated, or failed provider output |
| 502 | `STORAGE_ACCESS_DENIED`, `STORAGE_BUCKET_NOT_FOUND` | R2 credentials, permissions, or bucket configuration |
| 503 | `AI_BILLING_BLOCKED`, `AI_CONFIGURATION_ERROR` | Billing/project block or missing server configuration |
| 503 | `AI_UNAVAILABLE`, `AI_CONNECTION_FAILED`, `STORAGE_UNAVAILABLE`, `QUOTA_SERVICE_UNAVAILABLE` | Dependency temporarily unavailable |
| 504 | `AI_TIMEOUT` | Provider timed out |
| 500 | `INTERNAL_ERROR` | Unexpected application failure; use request ID for diagnosis |

Batch retries respect `retryable`. Authentication, permission, billing, model, invalid output, content, and exhausted quota errors stop immediately. Temporary network, service, and rate limit failures retain the existing bounded retry policy. A selected provider is never replaced by another provider on error.

Frontend displays the message, dependency reason, suggestion, and request ID. Non-JSON gateway responses are reported as HTTP failures rather than mistaken for a disconnected network. Error notifications stay visible for 15 seconds and can be dismissed. Provider catalog errors are shown beside the selector with a retry button.
