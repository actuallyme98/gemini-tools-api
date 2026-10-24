# Chia sẻ hội thoại

Chủ hội thoại mở **Chia sẻ** ở đầu trang chat. Dialog công bố rõ mọi người có link đều được đọc không cần đăng nhập, có lựa chọn kèm ảnh xem trước. Không tự chia sẻ khi mở dialog.

- Tạo link: đóng băng tin nhắn đầy đủ, kế hoạch/prompt, câu hỏi và các ảnh liên quan tại thời điểm tạo.
- Cập nhật nội dung: thay snapshot, giữ link; tin nhắn/phản hồi mới không tự xuất hiện.
- Thu hồi: chặn cả nội dung và preview ảnh ở lần truy cập tiếp theo. Tạo lại tạo chữ ký khác, link cũ không hoạt động.
- Trang `#share?token=...` nằm ngoài shell đăng nhập, chỉ đọc. Không có action AI/sửa/tiếp tục công việc.
- Không gửi email người tạo, cấu hình/model provider, context đã compact, kiến thức trích dẫn nội bộ, pinned requirements riêng, usage ledger hoặc thông tin mã hóa/lưu trữ trong response. Nội dung người dùng đã viết trực tiếp trong tin nhắn/prompt vẫn nằm trong bản chia sẻ; phải kiểm tra trước khi phát hành.
- Ảnh chỉ có WebP preview tối đa 512 px, bỏ EXIF; không cấp link R2 hoặc endpoint đọc bản gốc. Bỏ chọn kèm ảnh thì manifest/endpoint ảnh đều bị chặn.

## API

- `GET /api/agent/conversations/:id/share` → `{share: null | {token,title,sharedAt,includeImages,messageCount}}`.
- `POST .../:id/share`, body `{includeImages:boolean}` → tạo/cập nhật snapshot.
- `DELETE .../:id/share` → thu hồi, 204.

Ba API quản lý yêu cầu session và đúng chủ hội thoại, không cho admin hoặc thành viên dự án mặc nhiên chia sẻ hộ.

- `GET /api/agent/shared/:conversationId?after=0&version=...` → một trang 40 tin, run/asset metadata liên quan và cursor kế tiếp.
- `GET /api/agent/shared/:conversationId/assets/:assetId/preview` → WebP.

Hai API đọc công khai dùng header `X-Share-Token`. Chữ ký chỉ nằm trong fragment link phía trình duyệt và header API, không ở path/query request nên không lọt vào access log mặc định. HTTP response dùng no-store/noindex/no-referrer; giao diện thêm robots/referrer meta. Client công khai tách instance HTTP không có Authorization nhân viên.

Token dùng HMAC khóa mã hóa ảnh hiện có với domain riêng, ID hội thoại và nonce ngẫu nhiên. Database giữ nonce, không giữ chữ ký truy cập. Thu hồi, mất chủ/tắt tài khoản hoặc mất hội thoại đều từ chối đọc. Đây là cơ chế ai có link đều đọc được; không xác thực danh tính từng người nhận và không chống người nhận sao chép nội dung.

## Lưu trữ và giới hạn

`conversation-share` là manifest nhỏ theo ID hội thoại. `conversation-share-content` là snapshot bất biến, tách khỏi manifest để kiểm tra quyền ảnh không cần đọc lại toàn bộ chat. Publish CAS chống ghi đè từ nhiều tab; thay snapshot thành công mới xóa bản trước. Thu hồi xóa content, giữ manifest đánh dấu thu hồi để không tái dùng chữ ký.

Giới hạn: 5.000 tin nhắn, 6 MB văn bản, 250 run, 5.000 image step, 1.000 ảnh và 8 MB snapshot JSON. Vượt giới hạn trả lỗi rõ ràng, không chia sẻ âm thầm một phần lịch sử. Giới hạn tạo/cập nhật 30 lần/tài khoản/15 phút; đọc 1.200 lần/IP/15 phút (gồm preview). Phân trang gửi version snapshot để tránh ghép hai phiên bản khi chủ cập nhật lúc người nhận đang đọc.

Không gọi model, không phát sinh AI usage khi tạo hoặc xem link. Đã xem hoặc đã lưu thì không thể thu hồi bản sao của người nhận. Không có fork/tiếp tục từ chat được chia sẻ trong phiên bản này.

## Kiểm tra

Test tích hợp dùng MongoDB tạm, ảnh mã hóa thực và R2 giả lập: quyền sở hữu, chữ ký, snapshot bất biến/cập nhật, đầy đủ lịch sử, ảnh ngoài phạm vi, thu hồi/tạo lại, khóa tài khoản, metadata riêng và chữ ký không nằm trong nhật ký HTTP. Frontend kiểm tra quản lý link, vào link không đăng nhập, phân trang, XSS dạng văn bản và lỗi link bị thu hồi.

Chưa commit/push/deploy trong lượt bổ sung này.
