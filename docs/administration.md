# Quản trị công ty LCG Agent

Đăng nhập bằng tài khoản có quyền `admin`, chọn **Quản trị công ty** trong sidebar. Giao diện ở `/#admin`; các trang con: `/#admin-users`, `/#admin-runs`, `/#admin-audit`, `/#admin-settings`. API dưới `/api/agent/admin` yêu cầu phiên Bearer còn hiệu lực và quyền admin.

## Chức năng

- **Tổng quan:** tài khoản, phiên còn hạn, trạng thái công việc, công việc tạo trong 7 ngày UTC, tài sản và ảnh dự phòng MongoDB. Số liệu tổng hợp từ MongoDB, không lấy mẫu danh sách cá nhân. Dung lượng ảnh là kích thước file logic, không phải chi phí AI hoặc hóa đơn R2.
- **Tài khoản:** tìm email, lọc quyền/trạng thái, phân trang; tạo tài khoản; đổi admin/designer; khóa/mở khóa; đặt lại mật khẩu; thu hồi tất cả phiên. Không xóa tài khoản hoặc tài sản. Không trả password hash, Google subject, token hoặc ID phiên cho client.
- **Công việc:** xem metadata toàn công ty, lọc trạng thái/ID; xem bước xử lý, thời lượng, mã lỗi và request ID; dừng các bước chưa thực hiện với lý do. Request đã gửi hoặc bước worker đã nhận có thể tiếp tục hoàn tất. Không tự động retry hoặc tạo request AI tính phí từ trang quản trị.
- **Audit logs:** lịch sử quản trị trong MongoDB và nhật ký request/AI theo ngày UTC từ volume log hiện có. Tìm lỗi/request ID, lọc lỗi/cảnh báo, xem metadata và xuất trang JSON. Không xuất raw prompt, ảnh hoặc request body. Nhật ký file đọc theo thứ tự ghi, mỗi lượt tối đa 10.000 dòng mới; dùng Đọc tiếp khi cần. Nhật ký file chỉ phản ánh replica API đang phục vụ request; khi chạy nhiều replica nên dùng hệ thống thu thập log tập trung.
- **Vận hành:** tên workspace, domain Google được phép, tự cấp Designer hoặc chỉ nhận tài khoản đã tạo, tạm dừng/tiếp tục hàng đợi. Hiển thị cấu hình worker, concurrency, thời hạn phiên, retention log và mã hóa ảnh. Kết nối AI chỉ thể hiện trạng thái cấu hình, không thực hiện health probe tính phí. Bí mật tiếp tục nằm ở cấu hình triển khai.

## Bảo vệ truy cập và dữ liệu

Tài khoản cũ mặc định hoạt động, không cần migration dữ liệu. Khi khởi tạo cấu hình công ty lần đầu, admin đang hoạt động được tạo sớm nhất được giữ làm **quản trị viên gốc**. Không cho khóa/hạ quyền tài khoản này hoặc chính admin đang thao tác, kể cả gửi request thủ công. Không có API xóa hoặc chuyển quản trị viên gốc; việc chuyển tài khoản gốc cần quy trình ngoài ứng dụng và bản sao lưu MongoDB.

Đổi quyền/trạng thái, đặt lại mật khẩu và thu hồi phiên đều tăng `authVersion`; API kiểm tra ở từng request. Phiên cũ không hoạt động sau khi mở khóa lại, kể cả khi một login cũ ghi session sau lúc thu hồi. Request đã được xác thực và đang thực hiện vẫn có thể hoàn tất. Khóa tài khoản không tự hủy công việc: admin dừng riêng ở tab Công việc.

Thay đổi quản trị ghi **ý định trước**, rồi ghi success/failed trong collection `agent_records`, kind `admin-audit`. Password không được đưa vào metadata. Nếu process/database gián đoạn hoặc không xác định được kết quả ghi, sự kiện giữ pending/“Chưa xác định”: kiểm tra dữ liệu hiện tại trước khi làm lại. Không có API sửa/xóa sự kiện. Đây là nhật ký ứng dụng, không phải kho bất biến trước người có quyền trực tiếp MongoDB.

API quản trị trả `Cache-Control: no-store`. Cập nhật dùng `updatedAt` để chặn ghi đè dữ liệu vừa đổi. Thao tác ảnh hưởng truy cập/hàng đợi cần xác nhận và lý do. Vẫn phải sao lưu MongoDB, volume ảnh dự phòng, log và khóa mã hóa theo quy trình triển khai; dashboard không tự sao lưu hoặc cấu hình giám sát bên ngoài.

## Chính sách Google và hàng đợi

Domain Google chỉ lấy từ cấu hình công ty trong MongoDB và chỉnh trong Vận hành, không cần restart hoặc deploy lại. Khi chưa cấu hình, danh sách mặc định rỗng và Google login bị tắt; không đọc danh sách domain từ `.env`. Client ID vẫn lấy từ `GOOGLE_CLIENT_ID`. Domain công ty phải khớp claim Google Workspace đã xác minh; không kiểm tra chuỗi “có @lcg”. Thay đổi domain áp dụng ở lượt login mới; thu hồi riêng phiên đã cấp khi cần. Xem [google-auth.md](google-auth.md).

Tạm dừng hàng đợi lưu MongoDB, mọi worker kiểm tra trước khi claim bước mới. Lease recovery vẫn hoạt động khi pause. Bước đã nhận và request đang xử lý có thể hoàn tất. Nếu `QUEUE_WORKER_ENABLED=false` trên server, bỏ pause không tự bật worker: cần sửa cấu hình triển khai.

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
