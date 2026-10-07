# Cấu hình AI providers

Ứng dụng có một registry provider và chọn provider riêng cho từng tác vụ. Các endpoint, định dạng request/response và bước upload R2 vẫn giữ nguyên.

| Biến                 | Tác vụ                           | Mặc định              |
| -------------------- | -------------------------------- | --------------------- |
| `AI_PROVIDER`        | Provider chung                   | `gemini`              |
| `AI_TEXT_PROVIDER`   | Sinh prompt mockup, sinh ý tưởng | Giá trị `AI_PROVIDER` |
| `AI_VISION_PROVIDER` | Phân tích ảnh sản phẩm           | Giá trị `AI_PROVIDER` |
| `AI_IMAGE_PROVIDER`  | Sinh/chỉnh ảnh, ảnh từ reference | Giá trị `AI_PROVIDER` |

Provider của từng tác vụ được ưu tiên hơn provider chung. Hiện có `gemini`, `vyceai` và `shopaikey`. Không có fallback tự động: lỗi từ provider đã chọn được xử lý bởi retry hiện tại của service nghiệp vụ, không tự chuyển dữ liệu sang nhà cung cấp khác.

## Gemini + VyceAI

Copy `.env.example` thành `.env`, điền credential và chọn image model đang hoạt động. Ví dụ dùng VyceAI cho text, Gemini cho ảnh:

```dotenv
AI_PROVIDER=gemini
AI_TEXT_PROVIDER=vyceai
AI_VISION_PROVIDER=gemini
AI_IMAGE_PROVIDER=gemini

GEMINI_API_KEY=your-gemini-key
VYCEAI_API_KEY=your-vyceai-key
VYCEAI_BASE_URL=https://vyceai.com/v1
VYCEAI_MODEL_TEXT=deepseek-v4.1
VYCEAI_TIMEOUT_MS=60000
```

Model ID trên là ví dụ theo danh sách dashboard được cung cấp. Dùng đúng ID và quyền truy cập của tài khoản VyceAI; ứng dụng không xác minh model tồn tại khi khởi động. Restart server sau khi đổi cấu hình.

Gemini vẫn là mặc định khi không đặt biến chọn provider. Các biến `GEMINI_MODEL_TEXT`, `GEMINI_MODEL_MULTIMODAL`, `GEMINI_MODEL_IMAGE` vẫn được sử dụng. Giá trị mặc định image model cũ được giữ để tránh thay đổi cấu hình triển khai; hãy đặt `GEMINI_MODEL_IMAGE` thành model đang hoạt động trong tài khoản của bạn.

`GEMINI_API_KEY` / `VYCEAI_API_KEY` / `SHOPAIKEY_API_KEY` chỉ bắt buộc nếu provider đó được chọn. `OPENAI_API_KEY` không còn bắt buộc: module OpenAI cũ chưa có chức năng nghiệp vụ và không được nạp vào luồng này. Các cấu hình R2 và Redis hiện có vẫn cần thiết theo schema môi trường.

## Khả năng của VyceAI

Adapter dùng OpenAI SDK hiện có với `baseURL`, gọi `POST /chat/completions`, nhận `choices[0].message.content`. Prompt yêu cầu JSON, parser xử lý cả JSON được bọc trong markdown code fence. Không ép `response_format` vì chưa xác nhận mọi model của gateway hỗ trợ JSON mode. Service chung kiểm tra cấu trúc kết quả trước khi dùng; JSON lỗi, danh sách prompt sai số lượng hoặc ý tưởng thiếu prompt sẽ báo lỗi.

SDK đặt `maxRetries: 0` vì các service nghiệp vụ đã dùng `withRetry`. Endpoint phân tích sản phẩm vẫn giữ hành vi hiện tại: không bọc retry riêng. Timeout mỗi lần gọi mặc định 60 giây, chỉnh bằng `VYCEAI_TIMEOUT_MS` (1–300 giây).

VyceAI mặc định chỉ hỗ trợ text trong adapter. Nếu đã xác minh model và gateway nhận ảnh, bật:

```dotenv
AI_VISION_PROVIDER=vyceai
VYCEAI_VISION_ENABLED=true
VYCEAI_MODEL_VISION=claude-sonnet-4-6
```

Ảnh được gửi dưới dạng `image_url` với data URL base64. Khả năng nhận ảnh không đồng nghĩa khả năng sinh ảnh. Adapter chưa hỗ trợ sinh/chỉnh ảnh: đặt `AI_IMAGE_PROVIDER=vyceai` sẽ khiến ứng dụng báo lỗi khi khởi động. Nếu đặt `AI_PROVIDER=vyceai`, phải override image sang Gemini và bật/cấu hình vision hoặc override vision sang Gemini.

Kết quả kiểm tra gateway thực tế được ghi ở [báo cáo VyceAI](vyceai-smoke-test.md). Vision chỉ nên bật sau khi kiểm tra model đọc đúng ảnh; HTTP 200 và JSON hợp lệ chưa đủ để xác nhận chất lượng vision.

## ShopAIKey (native Google GenAI)

Adapter `shopaikey` dùng `@google/genai` hiện có, gửi `inlineData` base64 cho vision/chỉnh ảnh và nhận ảnh từ `candidates[].content.parts[].inlineData`. Hỗ trợ đủ ba tác vụ qua registry, tái sử dụng phần xử lý GenAI của Gemini.

Theo [tài liệu SDK của ShopAIKey](https://shopaikey.com/en/docs/google-genai), base URL SDK là URL gốc, không thêm `/v1` hoặc `/v1beta`: SDK tự tạo đường dẫn `/v1beta/models/{model}:generateContent`. Adapter gửi API key của ShopAIKey và header Bearer; không cần Google API key nếu tất cả tác vụ được chọn qua ShopAIKey.

Ví dụ dùng ShopAIKey cho toàn bộ AI:

```dotenv
AI_PROVIDER=shopaikey
SHOPAIKEY_API_KEY=your-shopaikey-key
SHOPAIKEY_BASE_URL=https://api.shopaikey.com
SHOPAIKEY_IMAGE_BASE_URL=https://direct.shopaikey.com
SHOPAIKEY_MODEL_TEXT=gemini-2.5-flash
SHOPAIKEY_MODEL_VISION=gemini-2.5-flash
SHOPAIKEY_MODEL_IMAGE=your-available-native-gemini-image-model
SHOPAIKEY_TIMEOUT_MS=60000
SHOPAIKEY_IMAGE_TIMEOUT_MS=180000
```

Xóa hoặc đổi các `AI_TEXT_PROVIDER`, `AI_VISION_PROVIDER`, `AI_IMAGE_PROVIDER` đã đặt trước đó nếu muốn cả ba tác vụ dùng `AI_PROVIDER=shopaikey`.

`SHOPAIKEY_MODEL_IMAGE` bắt buộc khi chọn ShopAIKey cho tác vụ image. Dùng model ID Gemini native có khả năng trả ảnh và được cấp cho tài khoản; adapter không gọi endpoint Nano Banana riêng nên không dùng các alias `nano-banana`, `nano-banana-2`, `nano-banana-pro` của endpoint đó. Model text/vision mặc định là `gemini-2.5-flash`; có thể đổi riêng.

Tác vụ ảnh dùng Direct endpoint mặc định theo khuyến nghị của nhà cung cấp cho các request dài. Timeout text/vision mặc định 60 giây (cấu hình 1–300 giây), timeout ảnh 180 giây (1–600 giây). Các lời gọi tạo/chỉnh ảnh yêu cầu `responseModalities: ['TEXT', 'IMAGE']`. Không gọi API lúc khởi động để kiểm tra model hay tài khoản; cần smoke test bằng credential thực tế. Số lượng `variations` được thực thi tại IdeaService bằng từng lần gọi image provider, tạo đúng số ảnh được yêu cầu (1–10).

Có thể kết hợp các provider:

```dotenv
AI_TEXT_PROVIDER=vyceai
AI_VISION_PROVIDER=shopaikey
AI_IMAGE_PROVIDER=shopaikey
```

## Thêm provider mới

1. Tạo Nest injectable adapter triển khai `AIProvider` trong `src/ai/ai-provider.ts`.
2. Khai báo `id` duy nhất, danh sách `capabilities` và kiểm tra credential/model trong `validateConfiguration`.
3. Triển khai `generateJSON` trả dữ liệu JSON đã parse; nếu có capability `image`, triển khai đủ `generateImage`, `editImage`, `generateImagesFromReferalImages`.
4. Đăng ký adapter trong `AIModule` và thêm instance vào factory `AI_PROVIDERS`.
5. Thêm biến môi trường của adapter vào `envValidationSchema`, rồi chọn ID qua các biến `AI_*_PROVIDER`.

Service nghiệp vụ chỉ phụ thuộc `AIService`, vì vậy việc thêm provider không cần sửa controller, mockup service hoặc idea service. Registry kiểm tra ID trùng, ID không tồn tại, capability thiếu và credential/model thiếu khi khởi động; không thực hiện request tới nhà cung cấp ở bước này.

## Kiểm tra

```bash
npm ci
npm run build
npm test -- --runInBand
```

Unit tests dùng mock provider và mock SDK, không gửi ảnh hay gọi API trả phí. E2E tests khởi tạo endpoint thật với AI/R2 giả lập, kiểm tra multipart, giới hạn đầu vào và số lượng ảnh đầu ra. Xem [hợp đồng frontend/API](frontend-api.md).

## Client provider selection

GET /api/ai/providers lists registered providers, configured capabilities, availability and effective routing for text, vision and image tasks. No credentials or configuration errors are returned.

All five multipart image endpoints accept an optional provider field (e.g. gemini, vyceai, shopaikey). Omit it to keep AI_PROVIDER and per-capability environment defaults. Selection applies only to that request and all its steps/variations; it never changes global configuration.

A selected provider handles its configured capabilities. Every AI step uses the explicitly selected provider. Unsupported or unconfigured capabilities return HTTP 400; the sidebar marks them as unavailable with null routing. No request-time fallback occurs. Multi-step and batch endpoints validate all required capabilities before any paid AI generation. Unknown IDs or providers with no configured capabilities also return HTTP 400. Startup still validates all system defaults strictly.

Availability means local configuration is complete, not a live upstream status check. Register new adapters in AI_PROVIDERS and optionally provide a name for the client label.
