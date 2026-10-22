# Log chẩn đoán API và AI

API ghi nhật ký JSONL riêng tư theo ngày UTC tại `AUDIT_LOG_DIR/YYYY-MM-DD/events.jsonl`. Mọi request qua controller (trừ health check) có `http_started`, `http_completed`, thời gian xử lý, mã HTTP và lỗi đã lọc credential; request bị ngắt được ghi trạng thái 499. Lỗi parser, guard hoặc route không tồn tại xảy ra trước interceptor vẫn có `http_completed`, không có thời gian xử lý hay event bắt đầu. Header `X-Request-Id` và lỗi JSON dùng cùng UUID do server tạo, không tin ID client gửi. Mockup Studio trả thêm `requestId` khi thành công; client hiển thị mã trên từng kết quả.

Ngay trước mỗi lần gọi Gemini native hoặc ShopAIKey Gemini/GPT Image/Grok, `ai_request` ghi provider, model đã resolve thực tế, transport, từng phần text nguyên thứ tự, SHA-256 và số ký tự. Mỗi ảnh giữ MIME, số byte, SHA-256 và đường dẫn bản sao riêng tư. Mockup Studio có thứ tự: prompt cuối, ảnh tham chiếu (đích), ảnh gốc (nguồn). Prompt không bị viết lại; các credential nhận diện được sẽ thay bằng `[redacted]`, hash vẫn tính trên prompt gốc để đối chiếu. Không ghi header Authorization, API key, cookie hoặc base64 ảnh vào JSONL. Request/model thất bại trước khi được gửi không có event `ai_request`.

Với tạo ảnh qua Gemini native, `ai_response` ghi `finishReason`, `finishMessage`, safety feedback, text trả về (giới hạn 2000 ký tự/phần, lọc credential/URL), MIME và chiều dài base64 thay vì nội dung ảnh. Bỏ qua nội dung thought; chỉ đánh dấu có phần này. Với ảnh dạng link của ShopAIKey, `ai_image_downloaded` hoặc `ai_image_download_failed` ghi hostname, kích thước, MIME hoặc lỗi tải; không ghi URL có token. Tên event `background_job_started/completed/failed` và mã `BACKGROUND_*` được giữ tương thích khi dùng chung bộ tác vụ cho cả Mockup Generator; phân biệt chức năng bằng `path`. HTTP 202 chỉ xác nhận đã nhận tác vụ, phải xem event hoàn tất hoặc trạng thái tác vụ để biết thành công hay thất bại.

Ảnh trả về từ model được lưu trước khi upload R2 (`generated_image`), sau đó ghi `storage_completed` cùng URL hoặc `storage_failed`. Vì vậy có thể xem ảnh model ngay cả khi R2 lỗi. Retry tạo thêm event thực gửi, dùng cùng request ID; log không thay đổi prompt, thứ tự ảnh hoặc cơ chế retry hiện có. Nếu ghi log lỗi, stderr báo `Audit log write failed`; không làm request AI thất bại hoặc gọi AI lại. Khi đọc một trace không đầy đủ cần kiểm tra stderr.

Ảnh lưu theo nội dung tại `YYYY-MM-DD/images/<sha256>.<png|jpg|webp>` để tránh lưu lại cùng ảnh cho mỗi biến thể/retry. JSONL và ảnh không có endpoint public. Chỉ quản trị viên có quyền vào máy chủ/volume đọc được. Dữ liệu cũ tự dọn lúc khởi động và tối đa mỗi giờ khi ghi log; mặc định giữ **7 ngày UTC** kể cả ngày hiện tại. Không có log hồi tố cho những lần chạy trước khi bật chức năng.

Biến môi trường:

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `AUDIT_LOG_DIR` | `./logs` | Đường dẫn local; Compose production cố định `/app/logs` |
| `AUDIT_LOG_RETENTION_DAYS` | `7` | Giữ 1–90 ngày UTC, gồm metadata và ảnh |
| `AUDIT_IMAGE_MAX_BYTES_PER_DAY` | `536870912` | Tối đa 512 MiB ảnh mới/ngày UTC; 0 chỉ lưu hash/metadata |

Khi đạt hạn mức ảnh, log vẫn giữ prompt và hash, ảnh không lưu được có `archiveUnavailable: true`. Đây là hạn mức ảnh, không phải tổng dung lượng JSONL; theo dõi dung lượng volume theo lưu lượng thực tế. Không xóa file ngoài các thư mục ngày do hệ thống quản lý hoặc đi theo symlink khi dọn dẹp.

Local:

```powershell
node scripts/read-audit-logs.cjs --limit 20
node scripts/read-audit-logs.cjs --request <request-uuid>
node scripts/read-audit-logs.cjs --day 2026-10-17 --limit 50
```

Production sau khi deploy:

```bash
docker exec gemini-tools-api-1 node scripts/read-audit-logs.cjs --dir /app/logs --limit 20
docker exec gemini-tools-api-1 node scripts/read-audit-logs.cjs --dir /app/logs --request <request-uuid>
# Đường dẫn ảnh lấy từ trường file trong event:
docker cp gemini-tools-api-1:/app/logs/YYYY-MM-DD/images/<sha256>.png ./diagnostic-image.png
```

Không có `--request` thì công cụ liệt kê HTTP hoàn tất và tác vụ ảnh hoàn tất/thất bại gần nhất, không dump `ai_request` hoặc `ai_response`; trường lỗi `reason` có thể chứa trích đoạn phản hồi đã lọc. Nhờ vậy lỗi tác vụ sau HTTP 202 vẫn xuất hiện trong danh sách gần đây. Có `--request` thì in toàn bộ event của UUID đó, kể cả khi request đi qua nửa đêm UTC. Compose gắn named volume `gemini-tools_api-logs` vào `/app/logs`; container chạy user `node`, thư mục mode 0700, file 0600 trên Linux. Thay image/recreate container vẫn giữ log. Không dùng `docker compose down -v` nếu muốn giữ volume. Log không thay thế kiểm định chất lượng ảnh: HTTP 201 vẫn chưa chứng minh ảnh tuân thủ prompt.
