# Hàng đợi cho nhiều nhân viên và nhiều tab

Redis/BullMQ phân phối chung tác vụ Agent và các công cụ Mockup, Mockup Studio, Ideas, phân tích ảnh. MongoDB lưu trạng thái, đầu vào và kết quả; Redis chỉ nhận ID. Ảnh/prompt đầu vào của công cụ được mã hóa AES-256-GCM trong GridFS bằng `AGENT_ASSET_ENCRYPTION_KEY`. Giữ nguyên và sao lưu khóa này cùng MongoDB.

Mọi endpoint xử lý AI và đọc tác vụ yêu cầu phiên đăng nhập nhân viên/admin. Client gửi Bearer token, `async=true` và UUID v4 trong `Idempotency-Key`. API trả 202 sau khi lưu đầu vào, client đọc trạng thái bằng GET; không tự gửi lại POST tạo ảnh. Cùng ID và dữ liệu trả lại job đã có; đổi dữ liệu bị từ chối 409. Tác vụ và kết quả chỉ đọc được trong tài khoản sở hữu.

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `QUEUE_ENABLED` | true | Bật kết nối hàng đợi; cần MongoDB, Redis, khóa mã hóa |
| `QUEUE_WORKER_ENABLED` | true | Tiến trình này nhận việc; đặt false cho API tách worker |
| `QUEUE_PREFIX` | lcgmedia-tools | Giống nhau trên tất cả API/worker của cùng môi trường |
| `QUEUE_CONCURRENCY` | 3 | Tổng số tác vụ đang xử lý, dùng chung giữa worker |
| `QUEUE_USER_CONCURRENCY` | 2 | Tác vụ mỗi nhân viên, dùng chung giữa tab |
| `QUEUE_MAX_PENDING` | 1000 | Số yêu cầu chưa hoàn tất toàn hệ thống |
| `QUEUE_MAX_PENDING_PER_USER` | 100 | Số yêu cầu chưa hoàn tất mỗi nhân viên |

Một lượt lập kế hoạch hoặc chạy bộ ảnh Agent chiếm một suất tiếp nhận; các bước ảnh chia sẻ giới hạn thực thi. Agent còn có giới hạn MongoDB `AGENT_CONCURRENCY`. Không tăng giới hạn khi scale thêm worker: mọi replica phải dùng cùng cấu hình. Khi đầy trả 429, khi không kết nối được Redis trả 503 trước khi tiếp nhận yêu cầu mới.

Worker nhận việc bằng cập nhật MongoDB có điều kiện `queued → running`. Giao lại cùng job không gọi AI lần nữa. Lease 90 giây, gia hạn mỗi 15 giây; quá hạn được đánh dấu gián đoạn và yêu cầu kiểm tra thủ công. Không tự retry lời gọi tạo ảnh có thể đã tính phí. Nếu lưu MongoDB xong nhưng chưa đưa được lên Redis, bộ đối soát sẽ đưa lại việc đang chờ. Đây không phải cam kết exactly-once với API AI bên ngoài.

Trang Công việc hiển thị tác vụ công cụ đã gửi từ tab khác hoặc trước khi reload, mã yêu cầu, lỗi và link kết quả. Hủy được khi chưa chạy; đóng tab/dừng polling không hủy tác vụ trên server. Batch trong một request là một job; nếu worker dừng giữa batch, cần kiểm tra log trước khi tạo lại, vì kết quả từng phần chưa chắc đã được lưu vào job.

`deploy/compose.production.yml` tách API và worker, thêm Redis riêng có AOF, volume bền vững, `noeviction`, không mở cổng Redis ra ngoài. Worker dùng cùng image API, MongoDB, R2, khóa mã hóa và provider secrets; có volume log riêng. Deploy API cập nhật cả worker; rollback dừng worker mới và phục hồi phiên bản trước. `AGENT_WORKER_ENABLED` cũ không còn điều khiển việc lấy job; dùng `QUEUE_WORKER_ENABLED`.

Chạy local bằng `docker compose up --build` sau khi điền `.env` và tạo tài khoản theo tài liệu Agent. Compose local có MongoDB/Redis riêng; chạy Node trực tiếp cần tự chạy hai dịch vụ và điền URI tương ứng. Production giữ MongoDB EziHubb đã cấu hình, không tự đổi sang MongoDB local.

Sao lưu MongoDB, Redis volume và khóa; theo dõi RAM, dung lượng GridFS, volume log và quota provider. Đầu vào/kết quả MongoDB được giữ lại, chưa có tác vụ tự xóa dữ liệu. Không dùng `FLUSHDB` hoặc xóa volume khi còn việc. AOF một giây không thay thế backup; sau sự cố mất dữ liệu Redis hoàn toàn cần dừng nhận việc, phục hồi dữ liệu và khởi động lại API/worker trước khi tiếp tục. Đây là hàng đợi bền vững một Redis, chưa phải Redis HA. Trên server dùng chung nên kiểm tra RAM trước khi tăng số worker.

Kiểm thử thật: `npm run test:e2e -- --runInBand test/queue.e2e-spec.ts`. CI dùng Redis riêng; local dùng `REDIS_TEST_URL` trỏ **Redis kiểm thử**, hoặc `REDIS_TEST_BINARY`. Test dùng MongoDB tạm, provider AI và R2 giả lập, không phát sinh chi phí AI.
