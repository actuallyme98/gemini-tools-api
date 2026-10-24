# Backup và phục hồi LCG Agent

Ngày 24/10/2026 đã cài timer trên production, tạo archive mã hóa và restore thử vào database riêng. Đã xác minh 17 index, session bị loại, queue tạm dừng trong DB phục hồi và giải mã được năm ảnh. DB thử và tài khoản verifier đã được gỡ sau kiểm tra. Không ghi đè DB production.

## Nội dung bảo vệ

`scripts/agent-backup.cjs` sao lưu MongoDB (gồm GridFS, users, chat, công việc, sổ chi phí, dự án và kiến thức) và **chỉ các object R2 của Agent trong namespace riêng**. Không sao lưu toàn bộ bucket dùng chung với EziHubb. Object được lấy ở dạng mã hóa hiện có, sau đó cả archive được nén và mã hóa AES-256-GCM bằng key backup riêng. Nếu thiếu object hoặc lỗi đọc, backup thất bại; không báo thành công một bản thiếu ảnh.

Chứng chỉ, cấu hình `.env`, khóa mã hóa ảnh và khóa backup phải lưu riêng trong kho bí mật. Archive không thể đọc ảnh nếu mất `AGENT_ASSET_ENCRYPTION_KEY`. Không để các khóa trong cùng nơi lưu archive. Logs chẩn đoán trên ổ đĩa và Redis không nằm trong archive này; audit công ty lưu trong MongoDB có trong archive.

## Cài backup tự động

1. Tạo `AGENT_BACKUP_KEY` ngẫu nhiên 32 byte (64 ký tự hex), khác key ảnh, trong `.env` server; không gửi qua log. Lưu key này và key ảnh ở nơi riêng ngoài server.
2. Chép script, compose override và hai file systemd đi kèm vào server. Tạo thư mục `/home/ubuntu/gemini-tools/backups/agent`, quyền 700, owner UID 1000 (ubuntu/node). Không public thư mục này qua Nginx.
3. Cài service/timer vào `/etc/systemd/system`, chạy `systemctl daemon-reload` rồi `systemctl enable --now lcg-agent-backup.timer`.
4. Chạy service một lần để kiểm tra. Service khóa chung với deploy, dừng API/worker, sao lưu, xác thực toàn bộ archive rồi bật lại ứng dụng, kể cả khi backup lỗi. Có khoảng bảo trì; frontend có thể tạm mất kết nối API. Không đổi lịch để chạy vào giờ cao điểm.
5. Theo dõi `systemctl status lcg-agent-backup.service` và dung lượng thư mục backup. Bản local quá 14 ngày chỉ được xóa khi có marker checksum xác nhận sao chép ngoài server; bản chưa replicate luôn được giữ. Không tự xóa object R2/S3.

Lịch mặc định 03:00 UTC+7 hàng ngày, trễ ngẫu nhiên tối đa 5 phút. Timer không tự được bật chỉ vì build/push image. Thư mục backup bị loại khỏi Git và Docker build context.

## Sao chép R2/S3 và bản local ngoài server

Theo yêu cầu dùng chung bucket, replica dùng credential R2 hiện có nhưng namespace riêng `gemini-tools/backups/`. Không thay đổi hoặc xóa ảnh ở các namespace khác. Archive được mã hóa trước upload; khóa backup và khóa ảnh không nằm trong object hoặc metadata. Cấu hình bằng `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, tùy chọn `BACKUP_S3_REGION`/`BACKUP_S3_PREFIX`.

Sau khi API/worker khởi động lại thành công, CLI upload rồi tải lại toàn bộ object và so sánh SHA-256 trước khi ghi marker `.replicated`. Lỗi upload/checksum giữ nguyên bản server và làm service báo lỗi. Thiếu một phần cấu hình bị từ chối trước bảo trì; bỏ trống cả bốn biến thì giữ chế độ backup tại server. Giới hạn mỗi archive 5 GB; vượt mức phải bổ sung multipart. Chưa tự cấu hình lifecycle bucket, tránh ảnh hưởng dữ liệu EziHubb.

`bash scripts/agent-backup-copy.sh /duong/dan/private lcg-YYYYMMDDTHHMMSSZ.enc` tải thêm bản mã hóa về máy quản trị và kiểm tra checksum. Không đặt khóa giải mã cùng thư mục archive. Bản kiểm tra đầu tiên nằm ở `D:/LCGMedia-Backups/agent/`; khóa phục hồi nằm ngoài Git trong thư mục credentials của Codex, đã hạn chế quyền đọc file. Bản sao máy local không thay thế replica R2 theo lịch.

## Kiểm tra phục hồi

CLI chỉ cho phép tên DB mới dạng `lcg_restore_<mã>` và DB phải hoàn toàn trống. Xác thực toàn bộ AES-GCM **trước khi ghi bất kỳ document nào**. Cần MongoDB credential có quyền ghi vào DB thử riêng; không nâng quyền tài khoản app chỉ để chạy kiểm thử.

```text
node scripts/agent-backup.cjs verify ten-ban-backup.enc
node scripts/agent-backup.cjs restore-test ten-ban-backup.enc lcg_restore_20261024
```

Các biến `MONGODB_URI`, `AGENT_BACKUP_DIR`, `AGENT_BACKUP_KEY` lấy qua môi trường riêng; không đặt URI/password trong command line hoặc file Git. Không chạy app/worker trỏ vào DB thử cùng Redis production. Restore tạm dừng hàng đợi trong cấu hình công ty và chuyển cả tác vụ công cụ cũ đang chuẩn bị/chờ/chạy sang gián đoạn. Chỉ mở lại hàng đợi sau khi kiểm tra, bằng thao tác admin rõ ràng.

Restore khôi phục index, chuyển ảnh R2 trong archive sang GridFS riêng của DB thử, bỏ session/Google nonce, tăng authVersion và đặt các bước đang chờ/chạy thành `interrupted`. Run đang hoạt động được đặt `failed` để người vận hành kiểm tra và đối soát. **Không tự phát lại request có thể đã bị tính phí**. Run/kết quả đã xong được giữ nguyên.

Sau restore: kiểm đếm bản ghi, đăng nhập bằng phiên mới trong môi trường thử riêng, mở một số ảnh và hội thoại, kiểm tra sổ chi phí, dự án/kiến thức, index và request bị dừng. Chỉ quyết định chuyển DB sau khi kiểm tra này đạt; CLI không ghi đè DB production.

Test tự động `test/backup.e2e-spec.ts` thực sự tạo archive rồi restore vào MongoDB tạm, kiểm tra index, session, trạng thái, file bị sửa và từ chối DB không trống. Đồng thời kiểm tra upload/tải lại replica và từ chối checksum sai. `test/backup-maintenance.test.cjs` kiểm tra startup lại sau lỗi, preflight và retention trên Linux. Bằng chứng restore production ngày 24/10 được ghi ở đầu tài liệu; mỗi lần đổi định dạng/key vẫn cần kiểm tra phục hồi lại.
