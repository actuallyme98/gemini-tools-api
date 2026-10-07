# Hợp đồng API và frontend

Frontend nằm tại ../gemini-tools-app; cấu hình provider tại docs/ai-providers.md. Không gửi API key từ frontend.

Các endpoint POST nhận multipart/form-data:

| Endpoint (/api) | Trường | Kết quả |
| --- | --- | --- |
| /mockups/generate-prompts | image, count (1–12) | string[] |
| /mockups/generate-mockups | image, prompts (JSON array, 1–20) | { total, results: [{index,prompt,url}] } |
| /ideas/analyze-product | image | ImageAnalysis |
| /ideas/generate-ideas | image, basePrompt, count (1–12, mặc định 3) | [{url,prompt}] |
| /ideas/generate-images-from-referal-images | productImage, referenceImages (tối đa 10), variations (1–10, mặc định 1) | string[] |

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
