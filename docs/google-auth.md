# Đăng nhập Google cho LCG Agent

Trong Google Cloud Console, tạo OAuth client loại **Web application**. Thêm Authorized JavaScript origins:

- `https://tools.lcgmedia.uk`
- Khi phát triển local: `http://localhost`, `http://localhost:5173` (hoặc port app thực tế).

Cấu hình branding/consent screen và quyền truy cập của tổ chức theo tài khoản Google Cloud. Dùng popup của Google Identity Services với JavaScript callback; không cần redirect URI hoặc Client Secret cho luồng này.

Trong `.env` của **API**:

```dotenv
GOOGLE_CLIENT_ID=your-web-client-id.apps.googleusercontent.com
```

Quản trị viên đăng nhập bằng tài khoản quản trị hiện có, mở **Quản trị công ty → Vận hành → Domain được phép đăng nhập Google**, nhập mỗi dòng một domain và lưu kèm lý do. Danh sách chỉ lấy từ MongoDB; biến môi trường domain cũ bị bỏ qua. Khi chưa cấu hình, đăng nhập Google bị tắt. Danh sách khớp chính xác, không chứa `@`, URL hoặc wildcard. `lcgmedia.uk` không cho phép `sub.lcgmedia.uk` hay `lcgmedia.uk.evil.com`. Danh sách rỗng hoặc thiếu Client ID sẽ tắt Google login. Frontend lấy cấu hình công khai từ `GET /api/agent/auth/status`; đổi domain không cần build/deploy lại. Đổi Client ID trong môi trường cần recreate/restart API.

API xác minh chữ ký, audience, issuer, hạn token, email đã xác minh và nonce dùng một lần (10 phút, lưu MongoDB, có TTL). Với email tổ chức, cả domain email và claim `hd` đã ký của Google Workspace phải khớp domain được cho phép. Tài khoản Google cá nhân đăng ký bằng địa chỉ công ty ngoài Workspace bị từ chối. `gmail.com` chỉ được phép nếu quản trị viên thêm chính domain đó vào danh sách — việc này mở quyền cho **mọi** Gmail đã xác minh.

Khi bật tự cấp tài khoản trong cấu hình công ty, tài khoản mới được tạo với quyền `designer`, không có mật khẩu mặc định. Khi tắt, chỉ tài khoản đã được admin tạo trước mới được đăng nhập. Người dùng hiện có liên kết theo email Workspace đã xác minh và giữ nguyên ID, dữ liệu, mật khẩu và quyền. Các lần sau dùng `sub` Google làm định danh ổn định. Tài khoản bị khóa không được cấp phiên. Không tự nâng quyền admin. Admin đầu tiên vẫn được tạo bằng quy trình `agent:user` hiện có.

Google login dùng phiên Bearer hiện có, cùng cơ chế hết hạn và đăng xuất; không lưu ID token Google vào trình duyệt hoặc nhật ký. Mật khẩu của tài khoản hiện có tiếp tục hoạt động, không áp dụng danh sách domain Google lên luồng mật khẩu. Thay đổi danh sách domain được kiểm tra trong lần đăng nhập Google tiếp theo; các phiên đã cấp tiếp tục có hiệu lực đến lúc hết hạn hoặc đăng xuất.

Kiểm thử tích hợp dùng MongoDB tạm và JWT được ký RSA, chỉ thay bước tải public key của Google. Kiểm thử UI dùng SDK Google giả lập, không yêu cầu tài khoản thật hoặc tạo chi phí AI. Cần thử đăng nhập Google thật sau khi cấu hình Client ID và consent screen.

Tài liệu Google: [Setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid), [Verify ID token](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
