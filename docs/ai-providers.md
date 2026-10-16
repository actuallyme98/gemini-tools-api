# Cấu hình AI providers

Ứng dụng có một registry provider và chọn provider riêng cho từng tác vụ. Các endpoint, định dạng request/response và bước upload R2 vẫn giữ nguyên.

| Biến                 | Tác vụ                           | Mặc định              |
| -------------------- | -------------------------------- | --------------------- |
| `AI_PROVIDER`        | Provider chung                   | `gemini`              |
| `AI_TEXT_PROVIDER`   | Sinh prompt mockup, sinh ý tưởng | Giá trị `AI_PROVIDER` |
| `AI_VISION_PROVIDER` | Phân tích ảnh sản phẩm           | Giá trị `AI_PROVIDER` |
| `AI_IMAGE_PROVIDER`  | Sinh/chỉnh ảnh, ảnh từ reference | Giá trị `AI_PROVIDER` |

Provider của từng tác vụ được ưu tiên hơn provider chung. Provider ảnh/vision gồm `gemini` và `shopaikey`. Ảnh/vision không có fallback tự động: lỗi từ provider đã chọn được xử lý bởi retry hiện tại của service nghiệp vụ, không tự chuyển ảnh sang nhà cung cấp khác.

Quy tắc trên áp dụng cho ảnh/vision. Với `AI_AUTO_TEXT_ROUTING=true` (mặc định), text có định tuyến riêng: ưu tiên VyceAI, fallback ShopAIKey như mô tả dưới đây. Đặt `false` để dùng lại lựa chọn provider text thông thường.

## Text: VyceAI ưu tiên, ShopAIKey dự phòng

VyceAI là adapter nội bộ cho text, không xuất hiện trong dropdown provider ảnh và không nhận ảnh sản phẩm. `AI_AUTO_TEXT_ROUTING=true` áp dụng cho sinh prompt mockup và sinh ý tưởng, kể cả khi client chọn Gemini để xử lý ảnh.

Backend lấy model từ `VYCEAI_BASE_URL/models` bằng `VYCEAI_API_KEY`, ưu tiên ID GPT rồi Claude. Danh sách được cache 60 giây, tối đa hai model mỗi nhóm được thử để tránh kéo dài vô hạn. Không dùng DeepSeek/Grok hay model chỉ tạo ảnh trong luồng text này.

Trước mỗi prompt thật, model phải vượt qua một yêu cầu health ngắn. Kết quả health không cache giữa các yêu cầu. Probe timeout theo `VYCEAI_HEALTH_TIMEOUT_MS` (mặc định 10 giây); model không phản hồi đầy đủ sẽ bị bỏ qua. Nếu khám phá model, health hoặc lần sinh text thật thất bại, backend chuyển sang `SHOPAIKEY_MODEL_TEXT`. Health probe có thể tiêu thụ token của provider.

ShopAIKey dự phòng dùng key riêng `SHOPAIKEY_API_KEY`, không dùng key Gemini. Nếu cả hai dịch vụ không sử dụng được, API trả lỗi theo hợp đồng chung và ghi provider dự phòng gây lỗi. `GET /api/ai/providers` trả `textRouting` để client hiển thị quy tắc này; provider ảnh và model ảnh vẫn được giữ đúng lựa chọn của client.

## Chọn model ảnh trên client

`GET /api/ai/providers/shopaikey/image-models` lấy danh sách thực tế từ `https://api.shopaikey.com/v1beta/models` bằng credential backend. Trả ID/tên các model thuộc nhóm đã triển khai xử lý ảnh: Gemini native có `image` trong ID, `gemini-nano-banana-*` (bao gồm `gemini-nano-banana-2.1`), `gpt-image-*` và `grok-imagine-image*`. Không đưa model chat/vision chỉ trả text hoặc alias `nano-banana-*` không có tiền tố Gemini dùng endpoint riêng vào bộ chọn. Key không được gửi xuống client. Frontend nhóm lựa chọn theo Google / OpenAI / xAI.

Không dùng số phiên bản để suy ra khả năng tạo ảnh: [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) và [Gemini 4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon) nhận ảnh nhưng chỉ trả text. [Gemini Nano Banana 2.1](https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1) là model tạo/chỉnh ảnh và dùng native `generateContent`, khác với các alias Nano Banana của gateway.

Kết quả `{ provider, defaultModel, models: [{ id, name }] }` được cache 5 phút, chia sẻ request đang tải. `?refresh=true` lấy lại danh sách. Model mặc định lấy từ `SHOPAIKEY_MODEL_IMAGE` nếu vẫn nằm trong danh sách. Catalog lỗi không ghi đè cache thành công.

Gemini dùng native `generateContent`; GPT Image và Grok Imagine dùng [Images API của ShopAIKey](https://shopaikey.com/en/docs/openai-format): `/v1/images/edits` với multipart, `/v1/images/generations` cho prompt không có ảnh. Với nhiều input, `image[]` giữ thứ tự sản phẩm gốc trước, background/reference sau. Prompt và custom instructions được dùng chung với luồng Gemini. Mỗi lần gọi yêu cầu một ảnh, trả base64, kiểm tra định dạng PNG/JPEG/WebP và lưu R2 với MIME/đuôi thực tế. Không tải URL ảnh tùy ý từ phản hồi upstream.

Grok nhận tối đa 5 ảnh đầu vào (gồm sản phẩm gốc); yêu cầu nhiều hơn bị chặn trước khi gọi endpoint trả phí. Danh sách model không bảo đảm nhóm tài khoản có kênh đang phục vụ: lỗi `No available channel` trả `AI_MODEL_UNAVAILABLE`, không retry hoặc tự đổi model; frontend tạm dừng bộ background còn lại. Có thể chọn model khác hoặc yêu cầu ShopAIKey mở kênh/nhóm phù hợp.

Các endpoint tạo mockup, tạo ý tưởng, tạo ảnh reference và thay background nhận thêm trường multipart `imageModel`. API kiểm tra lựa chọn trước các bước sinh text/ảnh trả phí và chỉ chấp nhận model tương thích trong catalog của provider. Model không hợp lệ trả `AI_IMAGE_MODEL_INVALID`; provider không hỗ trợ lựa chọn model trả `AI_IMAGE_MODEL_UNSUPPORTED`. Bỏ qua trường này vẫn dùng model ảnh cấu hình ở backend.

Client lưu model ShopAIKey riêng trên trình duyệt; đổi sang Gemini không gửi model ShopAIKey. Lỗi tải catalog hoặc model đã lưu bị gỡ không tự đổi sang model khác; cần tải lại hoặc chọn model hợp lệ. Một batch giữ provider/model lúc bắt đầu; retry dùng lựa chọn hiện tại. Phân tích ảnh và text không dùng model ảnh đã chọn.

## Gemini

Gemini là provider mặc định. Cấu hình GEMINI_API_KEY và các model GEMINI_MODEL_TEXT, GEMINI_MODEL_MULTIMODAL, GEMINI_MODEL_IMAGE trong .env; dùng model được cấp cho tài khoản.

Credential chỉ bắt buộc cho provider được chọn. ShopAIKey có thể được bật cùng Gemini bằng SHOPAIKEY_API_KEY và SHOPAIKEY_MODEL_IMAGE mà không đổi AI_PROVIDER. Dropdown lấy khả năng từ API; provider chưa có key/model cần thiết vẫn báo chưa cấu hình.

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
SHOPAIKEY_MODEL_IMAGE=your-available-image-model
SHOPAIKEY_TIMEOUT_MS=60000
SHOPAIKEY_IMAGE_TIMEOUT_MS=180000
```

Xóa hoặc đổi các `AI_TEXT_PROVIDER`, `AI_VISION_PROVIDER`, `AI_IMAGE_PROVIDER` đã đặt trước đó nếu muốn cả ba tác vụ dùng `AI_PROVIDER=shopaikey`.

`SHOPAIKEY_MODEL_IMAGE` bắt buộc khi chọn ShopAIKey cho tác vụ image. Dùng model Gemini native, GPT Image hoặc Grok Imagine có trong catalog và được cấp cho tài khoản; adapter không gọi endpoint Nano Banana riêng nên không dùng các alias `nano-banana`, `nano-banana-2`, `nano-banana-pro` của endpoint đó. Model text/vision mặc định là `gemini-2.5-flash`; có thể đổi riêng.

Tác vụ ảnh dùng Direct endpoint mặc định theo khuyến nghị của nhà cung cấp cho các request dài. Timeout text/vision mặc định 60 giây (cấu hình 1–300 giây), timeout ảnh 180 giây (1–600 giây). Lời gọi Gemini ảnh yêu cầu `responseModalities: ['TEXT', 'IMAGE']`; GPT/Grok yêu cầu `response_format: 'b64_json'`. Không gọi API lúc khởi động để kiểm tra model hay tài khoản; cần smoke test bằng credential thực tế. Số lượng `variations` được thực thi tại IdeaService bằng từng lần gọi image provider, tạo đúng số ảnh được yêu cầu (1–10).

Có thể kết hợp các provider:

```dotenv
AI_TEXT_PROVIDER=gemini
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

All multipart image endpoints accept an optional provider field (e.g. gemini, shopaikey). Omit it to keep AI_PROVIDER and per-capability environment defaults. Selection applies only to that request and all its steps/variations; it never changes global configuration.

A selected provider handles its configured capabilities. Every AI step uses the explicitly selected provider. Unsupported or unconfigured capabilities return HTTP 400; the sidebar marks them as unavailable with null routing. No request-time fallback occurs. Multi-step and batch endpoints validate all required capabilities before any paid AI generation. Unknown IDs or providers with no configured capabilities also return HTTP 400. Startup still validates all system defaults strictly.

Availability means local configuration is complete, not a live upstream status check. Register new adapters in AI_PROVIDERS and optionally provide a name for the client label.
