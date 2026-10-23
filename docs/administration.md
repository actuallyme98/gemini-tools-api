# Quản trị công ty LCG Agent

Đăng nhập bằng tài khoản có quyền `admin`, chọn **Quản trị công ty** trong sidebar. Giao diện ở `/#admin`; các trang con: `/#admin-users`, `/#admin-runs`, `/#admin-audit`, `/#admin-settings`. API dưới `/api/agent/admin` yêu cầu phiên Bearer còn hiệu lực và quyền admin.

## Chức năng

- **Tổng quan:** tài khoản, phiên còn hạn, trạng thái công việc, công việc tạo trong 7 ngày UTC, tài sản và ảnh dự phòng MongoDB. Số liệu tổng hợp từ MongoDB, không lấy mẫu danh sách cá nhân. Dung lượng ảnh là kích thước file logic, không phải chi phí AI hoặc hóa đơn R2.
- **Tài khoản:** tìm email, lọc quyền/trạng thái, phân trang; tạo tài khoản; đổi admin/designer; khóa/mở khóa; đặt lại mật khẩu; thu hồi tất cả phiên. Không xóa tài khoản hoặc tài sản. Không trả password hash, Google subject, token hoặc ID phiên cho client.
- **Công việc:** xem metadata toàn công ty, lọc trạng thái/ID; xem bước xử lý, thời lượng, mã lỗi và request ID; dừng các bước chưa thực hiện với lý do. Request đã gửi hoặc bước worker đã nhận có thể tiếp tục hoàn tất. Không tự động retry hoặc tạo request AI tính phí từ trang quản trị.
- **Audit logs:** lịch sử quản trị trong MongoDB và nhật ký request/AI theo ngày UTC. Chọn nguồn **API** hoặc **Worker xử lý tác vụ**, tìm lỗi/request ID, lọc lỗi/cảnh báo và xuất trang JSON. Danh sách chỉ có metadata; mở **Chi tiết** để đọc chuỗi sự kiện cùng request ID, model/transport, prompt thực tế, thứ tự ảnh/MIME/byte/hash và lỗi upstream. Không trả headers, credential, URL riêng tư, base64 hoặc đường dẫn file ảnh. Nhật ký file đọc theo thứ tự ghi, mỗi lượt tối đa 10.000 dòng mới; dùng Đọc tiếp khi cần. Khi chạy nhiều replica cần thu thập log tập trung.
- **Vận hành:** tên workspace, domain Google được phép, tự cấp Designer hoặc chỉ nhận tài khoản đã tạo, tạm dừng/tiếp tục hàng đợi. Hiển thị cấu hình worker, concurrency, thời hạn phiên, retention log và mã hóa ảnh. Kết nối AI chỉ thể hiện trạng thái cấu hình, không thực hiện health probe tính phí. Bí mật tiếp tục nằm ở cấu hình triển khai.

## Bảo vệ truy cập và dữ liệu

Tài khoản cũ mặc định hoạt động, không cần migration dữ liệu. Khi khởi tạo cấu hình công ty lần đầu, admin đang hoạt động được tạo sớm nhất được giữ làm **quản trị viên gốc**. Không cho khóa/hạ quyền tài khoản này hoặc chính admin đang thao tác, kể cả gửi request thủ công. Không có API xóa hoặc chuyển quản trị viên gốc; việc chuyển tài khoản gốc cần quy trình ngoài ứng dụng và bản sao lưu MongoDB.

Đổi quyền/trạng thái, đặt lại mật khẩu và thu hồi phiên đều tăng `authVersion`; API kiểm tra ở từng request. Phiên cũ không hoạt động sau khi mở khóa lại, kể cả khi một login cũ ghi session sau lúc thu hồi. Request đã được xác thực và đang thực hiện vẫn có thể hoàn tất. Khóa tài khoản không tự hủy công việc: admin dừng riêng ở tab Công việc.

Thay đổi quản trị ghi **ý định trước**, rồi ghi success/failed trong collection `agent_records`, kind `admin-audit`. Password không được đưa vào metadata. Nếu process/database gián đoạn hoặc không xác định được kết quả ghi, sự kiện giữ pending/“Chưa xác định”: kiểm tra dữ liệu hiện tại trước khi làm lại. Không có API sửa/xóa sự kiện. Đây là nhật ký ứng dụng, không phải kho bất biến trước người có quyền trực tiếp MongoDB.

API quản trị trả `Cache-Control: no-store`. Cập nhật dùng `updatedAt` để chặn ghi đè dữ liệu vừa đổi. Thao tác ảnh hưởng truy cập/hàng đợi cần xác nhận và lý do. Vẫn phải sao lưu MongoDB, volume ảnh dự phòng, log và khóa mã hóa theo quy trình triển khai; dashboard không tự sao lưu hoặc cấu hình giám sát bên ngoài.

## Chính sách Google và hàng đợi

Domain Google chỉ lấy từ cấu hình công ty trong MongoDB và chỉnh trong Vận hành, không cần restart hoặc deploy lại. Khi chưa cấu hình, danh sách mặc định rỗng và Google login bị tắt; không đọc danh sách domain từ `.env`. Client ID vẫn lấy từ `GOOGLE_CLIENT_ID`. Domain công ty phải khớp claim Google Workspace đã xác minh; không kiểm tra chuỗi “có @lcg”. Thay đổi domain áp dụng ở lượt login mới; thu hồi riêng phiên đã cấp khi cần. Xem [google-auth.md](google-auth.md).

Tạm dừng hàng đợi lưu MongoDB, mọi worker kiểm tra trước khi claim bước mới. Lease recovery vẫn hoạt động khi pause. Bước đã nhận và request đang xử lý có thể hoàn tất. Nếu `QUEUE_WORKER_ENABLED=false` trên server, bỏ pause không tự bật worker: cần sửa cấu hình triển khai.

## Chi tiết request log

`GET /api/agent/admin/diagnostics/:requestId?day=YYYY-MM-DD&source=api|worker&cursor=0&limit=50` chỉ dành cho admin, trả `Cache-Control: no-store`. API kiểm tra UUID/ngày/nguồn và chặn symlink; chỉ cho phép các trường chẩn đoán đã định nghĩa, lọc secret cả với log cũ. `items` là sự kiện theo thứ tự ghi; `nextCursor` dùng để đọc phần kế tiếp. Mỗi trang tối đa 100 sự kiện, 10.000 dòng quét hoặc khoảng 2 MiB dữ liệu. Văn bản quá dài được giới hạn 50.000 ký tự/phần và 64.000 ký tự nội dung/sự kiện, có `truncated: true`. Metadata ảnh được giữ, không công khai bản sao ảnh.

Ngày lọc là UTC của file log, không phải ngày tạo công việc. Tác vụ qua nửa đêm cần tra ngày kế tiếp; các bước Agent có request ID riêng trong tab Công việc. Log đã hết retention trả danh sách trống; nút Đọc tiếp vẫn có thể xuất hiện nếu chưa quét hết file.

Compose gắn volume worker vào API dưới `/app/worker-logs:ro`, cấu hình `AUDIT_WORKER_LOG_DIR`. Worker vẫn chỉ ghi vào volume riêng để không tranh chấp cleanup/rotation với API. Khi chạy local cùng process, dùng nguồn API; nếu dùng worker riêng, đặt đường dẫn đọc tới journal của worker. Không cấu hình worker journal sẽ trả lỗi rõ ràng khi chọn nguồn Worker.

## Kiểm thử

```bash
# API
npm run lint:check
npm run build
npm run test:e2e -- --runInBand admin.e2e agent-google-auth agent.e2e
# Frontend
npm run lint
npm run build
npm run test:e2e -- tests/admin.spec.ts tests/agent.spec.ts
```

API dùng MongoDB tạm thật; UI dùng dữ liệu giả lập và kiểm tra desktop/mobile, phân trang, modal, phân quyền, lỗi và lưu chính sách. Không gọi production hoặc AI tính phí trong các kiểm thử.
