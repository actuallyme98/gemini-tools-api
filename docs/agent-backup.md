# Backup và phục hồi LCG Agent

Chưa cài timer hoặc thay đổi production trong lượt triển khai P0–P2. Các bước sau cần thực hiện khi deploy bản có CLI backup.

## Nội dung bảo vệ

`scripts/agent-backup.cjs` sao lưu MongoDB (gồm GridFS, users, chat, công việc, sổ chi phí, dự án và kiến thức) và **chỉ các object R2 của Agent trong namespace riêng**. Không sao lưu toàn bộ bucket dùng chung với EziHubb. Object được lấy ở dạng mã hóa hiện có, sau đó cả archive được nén và mã hóa AES-256-GCM bằng key backup riêng. Nếu thiếu object hoặc lỗi đọc, backup thất bại; không báo thành công một bản thiếu ảnh.

Chứng chỉ, cấu hình `.env`, khóa mã hóa ảnh và khóa backup phải lưu riêng trong kho bí mật. Archive không thể đọc ảnh nếu mất `AGENT_ASSET_ENCRYPTION_KEY`. Không để các khóa trong cùng nơi lưu archive. Logs chẩn đoán trên ổ đĩa và Redis không nằm trong archive này; audit công ty lưu trong MongoDB có trong archive.

## Cài backup tự động

1. Tạo `AGENT_BACKUP_KEY` ngẫu nhiên 32 byte (64 ký tự hex), khác key ảnh, trong `.env` server; không gửi qua log. Lưu key này và key ảnh ở nơi riêng ngoài server.
2. Chép script, compose override và hai file systemd đi kèm vào server. Tạo thư mục `/home/ubuntu/gemini-tools/backups`, quyền 700, owner UID 1000 (ubuntu/node). Không public thư mục này qua Nginx.
3. Cài service/timer vào `/etc/systemd/system`, chạy `systemctl daemon-reload` rồi `systemctl enable --now lcg-agent-backup.timer`.
4. Chạy service một lần để kiểm tra. Service khóa chung với deploy, dừng API/worker, sao lưu, xác thực toàn bộ archive rồi bật lại ứng dụng, kể cả khi backup lỗi. Có khoảng bảo trì; frontend có thể tạm mất kết nối API. Không đổi lịch để chạy vào giờ cao điểm.
5. Theo dõi `systemctl status lcg-agent-backup.service` và dung lượng thư mục backup. Cấu hình sao chép archive mã hóa sang nơi khác trước khi áp dụng retention; script chưa tự xóa bản cũ.

Lịch mặc định 03:00 UTC+7 hàng ngày, trễ ngẫu nhiên tối đa 5 phút. Timer không tự được bật chỉ vì build/push image. Thư mục backup bị loại khỏi Git và Docker build context.

## Kiểm tra phục hồi

CLI chỉ cho phép tên DB mới dạng `lcg_restore_<mã>` và DB phải hoàn toàn trống. Xác thực toàn bộ AES-GCM **trước khi ghi bất kỳ document nào**. Cần MongoDB credential có quyền ghi vào DB thử riêng; không nâng quyền tài khoản app chỉ để chạy kiểm thử.

```text
node scripts/agent-backup.cjs verify ten-ban-backup.enc
node scripts/agent-backup.cjs restore-test ten-ban-backup.enc lcg_restore_20261024
```

Các biến `MONGODB_URI`, `AGENT_BACKUP_DIR`, `AGENT_BACKUP_KEY` lấy qua môi trường riêng; không đặt URI/password trong command line hoặc file Git. Không chạy app/worker trỏ vào DB thử cùng Redis production. Restore tạm dừng hàng đợi trong cấu hình công ty và chuyển cả tác vụ công cụ cũ đang chuẩn bị/chờ/chạy sang gián đoạn. Chỉ mở lại hàng đợi sau khi kiểm tra, bằng thao tác admin rõ ràng.

Restore khôi phục index, chuyển ảnh R2 trong archive sang GridFS riêng của DB thử, bỏ session/Google nonce, tăng authVersion và đặt các bước đang chờ/chạy thành `interrupted`. Run đang hoạt động được đặt `failed` để người vận hành kiểm tra và đối soát. **Không tự phát lại request có thể đã bị tính phí**. Run/kết quả đã xong được giữ nguyên.

Sau restore: kiểm đếm bản ghi, đăng nhập bằng phiên mới trong môi trường thử riêng, mở một số ảnh và hội thoại, kiểm tra sổ chi phí, dự án/kiến thức, index và request bị dừng. Chỉ quyết định chuyển DB sau khi kiểm tra này đạt; CLI không ghi đè DB production.

Test tự động `test/backup.e2e-spec.ts` thực sự tạo archive rồi restore vào MongoDB tạm, kiểm tra index, session, trạng thái, file bị sửa và từ chối DB không trống. Đây là bằng chứng ở môi trường test; chưa phải xác nhận một bản backup production đã được phục hồi thành công.
