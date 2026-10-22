# Hợp đồng API và frontend

Frontend nằm tại ../gemini-tools-app; cấu hình provider tại docs/ai-providers.md. Không gửi API key từ frontend.

Các endpoint POST nhận multipart/form-data:

| Endpoint (/api) | Trường | Kết quả |
| --- | --- | --- |
| /mockups/generate-prompts | image, count (1–12) | string[] |
| /mockups/generate-mockups | image, prompts (JSON array), async=true | Với async=true chỉ nhận 1 prompt, HTTP 202 {jobId,requestId,state}; client cũ bỏ async vẫn nhận {total,results:[{index,prompt,url}]} |
| /mockups/jobs/:jobId (GET) | UUID tác vụ | {state,result?:{url,mimeType,requestId},error?,requestId} |
| /ideas/analyze-product | image | ImageAnalysis |
| /ideas/generate-ideas | image, basePrompt, count (1–12, mặc định 3) | [{url,prompt}] |
| /ideas/generate-images-from-referal-images | productImage, referenceImages (tối đa 10), variations (1–10, mặc định 1) | string[] |
| /backgrounds/replace | productImage, backgroundImage, variationIndex (1–3), instructions (bắt buộc, ≤12000 ký tự), async=true | HTTP 202 { jobId, requestId, state }; xem hợp đồng Mockup Studio |
| /backgrounds/jobs/:jobId (GET) | UUID tác vụ | { state, result?, error?, requestId } |

[Mockup Studio](background-studio.md) áp hình in/họa tiết từ sản phẩm gốc lên sản phẩm trong ảnh tham chiếu, giữ nguyên cảnh; xử lý hàng đợi từng cặp ảnh và giữ kết quả thành công khi thử lại.

Mockup Generator gửi riêng từng prompt, tối đa 3 tác vụ đồng thời. Kết quả hiện ngay khi xong, giữ đúng số thứ tự ảnh dù hoàn tất khác thứ tự; lỗi một ảnh không xóa ảnh khác. Retry chỉ ảnh lỗi/tạm dừng, dùng prompt và file đã lưu theo bộ, cùng provider/model chọn lúc retry. Lỗi billing/quota/storage hoặc CDN chưa cho phép dừng gửi ảnh tiếp theo, giữ tác vụ đang chạy. Client dùng chung cơ chế polling mỗi 2 giây, chỉ retry GET khi mạng lỗi, không tự gửi lại POST. Dừng hủy việc chờ ở client; tác vụ API đã nhận vẫn tiếp tục và có thể tính phí. Kho tác vụ dùng chung với Mockup Studio: tối đa 6 đang chạy, trạng thái hoàn tất giữ 1 giờ trong một tiến trình; restart API mất trạng thái.

ShopAIKey Gemini có thể trả Markdown link ảnh thay vì inline base64. Adapter tải link HTTPS từ hostname nằm trong `SHOPAIKEY_IMAGE_DOWNLOAD_HOSTS` (mặc định `image.chr1.com,direct.shopaikey.com,api.shopaikey.com`), không gửi Authorization hoặc theo redirect. Giới hạn 32MB kể cả stream thiếu Content-Length, kiểm tra chữ ký PNG/JPEG/WebP. Tải lỗi tạm thời thử lại tối đa một lần, độc lập với tạo ảnh; không tự gọi model lại khi lỗi tải ảnh. Images API GPT/Grok cũng nhận được cả `b64_json` và `url`. Giữ lỗi `AI_NO_IMAGE` cho phản hồi thực sự không có ảnh; mã chặn nội dung được trả riêng.

Các endpoint tạo/chỉnh ảnh nhận thêm `imageModel` (ID tối đa 128 ký tự từ `GET /api/ai/providers/shopaikey/image-models`); bỏ qua dùng model cấu hình. Model được kiểm tra trước bước trả phí, giữ cố định cho cả batch. `GET /api/ai/providers` có `textRouting` khi bật text VyceAI ưu tiên / ShopAIKey dự phòng. Xem [cấu hình AI](ai-providers.md).

Mỗi ảnh tối đa 10MB, PNG/JPEG/WebP. API kiểm tra MIME và chữ ký file; request không hợp lệ trả 400, file quá lớn trả 413 trước khi gọi AI. Prompt thủ công tối đa 4000 ký tự/prompt; basePrompt tối đa 20000 ký tự.

variations được thực thi tại IdeaService: mỗi lượt tạo một ảnh và upload R2, tổng số URL đúng số yêu cầu. Retry theo từng lượt, không tạo lại các ảnh trước đó trong cùng request. Ý tưởng yêu cầu AI trả đúng count; response sai cấu trúc/số lượng bị từ chối. Các lời gọi có lỗi xác thực/đầu vào 4xx không retry (trừ 408/429).

Khi browser ngắt kết nối, batch dừng các bước chưa bắt đầu. Lời gọi provider đang chạy có thể vẫn hoàn thành và tính phí; hủy phía client không bảo đảm thu hồi request upstream.

R2_PRIVATE_URL tùy chọn; nếu bỏ qua, endpoint lấy từ R2_ACCOUNT_ID. R2_PUBLIC_URL phải là địa chỉ đọc được ảnh; cấu hình CORS GET cho origin frontend nếu dùng download trực tiếp từ R2.

## Kiểm tra không gọi dịch vụ ngoài

```powershell
npm.cmd run build
npm.cmd exec -- eslint "src/**/*.ts" "test/**/*.ts"
npm.cmd test -- --runInBand
npm.cmd run test:e2e -- --runInBand
```

E2E khởi tạo controller/service thật, mock AI và R2, kiểm tra multipart, giới hạn file/count, số lần tạo và upload ảnh.

## Chạy hai dự án bằng Docker

Điền .env của API, sau đó:

```powershell
docker compose up --build
```

Frontend: http://localhost:5173; API: http://localhost:5177/api; Swagger: http://localhost:5177/api/docs.
Compose không cần Redis service vì các guard Redis hiện chưa được gắn vào endpoint. Biến REDIS_URL vẫn có trong schema để tương thích cấu hình hiện tại.
