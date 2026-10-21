# Mockup Studio

Frontend: `/#background-studio`. Dùng một ảnh sản phẩm gốc để chỉnh sửa tối đa 10 ảnh tham chiếu theo prompt người dùng. Prompt base được điền sẵn đầy đủ trong ô Custom prompt và có thể sửa hoặc thay thế toàn bộ. Mặc định prompt chuyển hình in/họa tiết lên mọi sản phẩm tương ứng, giữ nguyên người, background, ánh sáng, bố cục, màu nền và cấu trúc sản phẩm đích; không giới hạn ở áo hoặc ảnh có người. Người dùng chọn/bỏ chọn ảnh, chọn 1–3 kết quả mỗi ảnh tham chiếu, tối đa 20 kết quả cho một lần tạo.

## API

`POST /api/backgrounds/replace`, `multipart/form-data`:

| Trường | Yêu cầu |
| --- | --- |
| `productImage` | Một ảnh sản phẩm gốc thể hiện rõ hình in/họa tiết và tỷ lệ so với sản phẩm, bắt buộc |
| `backgroundImage` | Một ảnh tham chiếu chứa sản phẩm đích cần thay hình in, bắt buộc; tên trường cũ được giữ để tương thích |
| `provider` | Provider cụ thể do client chọn; bỏ qua dùng default image của API |
| `imageModel` | Model ảnh tùy chọn, được kiểm tra theo provider đã chọn |
| `variationIndex` | Số nguyên 1–3, mặc định 1 |
| `instructions` | Prompt cuối cùng đầy đủ do người dùng sửa, bắt buộc có nội dung, tối đa 12000 ký tự |
| `async` | Client mới gửi `true` để nhận mã tác vụ ngay và đọc trạng thái bằng request ngắn |

Mỗi ảnh PNG/JPEG/WebP tối đa 10MB, kiểm tra MIME và chữ ký. Một request trả HTTP 201 với `{ "url": "https://…", "mimeType": "image/png" }`; MIME thực tế có thể là PNG/JPEG/WebP. URL lưu trên R2 với đuôi tương ứng. Lỗi theo [hợp đồng lỗi chung](api-errors.md).

AI nhận đúng hai ảnh theo thứ tự: ẢNH 1 là ảnh tham chiếu cần chỉnh sửa (đích); ẢNH 2 là sản phẩm gốc (nguồn). Thứ tự này áp dụng cho Gemini native, ShopAIKey Gemini, GPT và Grok. Prompt base nằm tại `src/constants/background-studio-prompt.ts` trong repo frontend và vẫn sửa/thay thế được toàn bộ.

Client ghép quy ước nguồn/đích và yêu cầu không thêm watermark với nội dung Custom prompt, hiển thị toàn bộ tại “Final prompt gửi tới model”, rồi chụp lại final prompt khi tạo bộ và gửi trong `instructions`. Chữ/logo thuộc thiết kế sản phẩm vẫn được giữ. API dùng nguyên final prompt, không nối quy tắc ẩn, không thêm hướng dẫn theo `variationIndex`, không qua model text viết lại. Multipart từ trình duyệt có thể chuẩn hóa xuống dòng thành CRLF. Giới hạn 12000 ký tự tính cả quy tắc chung; ô nhập chừa sẵn dung lượng cho phần này. Custom prompt thiếu hoặc chỉ có khoảng trắng bị chặn ở client. API từ chối prompt trắng hoặc dài hơn giới hạn. Nút khôi phục chỉ thay nội dung ô nhập khi người dùng bấm. Khóa ô nhập trong lúc xử lý; retry dùng final prompt đã lưu theo tác vụ.

Với `async=true`, POST trả HTTP 202 `{jobId, requestId, state:"pending"}`. Client đọc `GET /api/backgrounds/jobs/:jobId` mỗi 2 giây: `{state:"pending"}`, `{state:"done",result:{url,mimeType,requestId}}` hoặc `{state:"failed",error:{statusCode,code,message,requestId,...}}`. AI và R2 tiếp tục sau khi HTTP 202 kết thúc, giữ mã log gốc. Đọc trạng thái lỗi mạng/502/503/524 tạm thời được thử lại, không gửi POST tạo ảnh lần nữa. Client dừng chờ sau 20 phút. Endpoint trạng thái không cache. Tác vụ lưu trong một tiến trình API, tối đa 6 tác vụ đang chạy, 100 trạng thái; trạng thái hoàn tất giữ 1 giờ. Khởi động lại API làm mất trạng thái: cần queue bền vững trước khi chạy nhiều replica hoặc cần phục hồi qua restart. Client cũ không gửi `async` tiếp tục nhận 201 đồng bộ.

Đây là chỉnh sửa bằng model tạo ảnh, không phải tách lớp/copy pixel cố định. Model xử lý theo prompt cuối cùng người dùng chọn; API chưa có mask hay kiểm định ảnh đầu ra để bảo đảm độ chính xác từng pixel hoặc kích thước pixel đầu ra. Người dùng cần đối chiếu hình in và ảnh tham chiếu trước khi tải.

Gemini và ShopAIKey hỗ trợ qua phương thức `AIProvider.replaceBackground`; dùng model ảnh được cấu hình ở provider đó. Provider thiếu khả năng hoặc phương thức này trả 400 trước khi tạo ảnh, không fallback. Provider mới cần triển khai phương thức này và khai báo capability `image`.

## Hàng đợi trên client

Client gửi từng cặp bằng nhóm xử lý tối đa 3 request song song (`MAX_CONCURRENT_BACKGROUND_REQUESTS`), mỗi kết quả là một request riêng. Khi một request xong, chỗ trống được dùng ngay cho ảnh tiếp theo, không chờ cả nhóm; kết quả cập nhật theo ID tác vụ nên không bị nhầm khi hoàn thành khác thứ tự. Provider/model được chụp tại lúc bắt đầu và giữ cho cả hàng đợi; lựa chọn provider/model và custom prompt bị khóa đến khi toàn bộ request của bộ kết thúc hoặc người dùng bấm dừng. Các file và custom prompt được giữ theo bộ đã tạo; retry giữ custom prompt cũ của tác vụ, dùng provider/model đang chọn lúc retry và áp dụng cùng giới hạn song song. Muốn áp dụng custom prompt đã sửa phải tạo bộ mới. Chi phí AI tăng theo số kết quả yêu cầu, không giảm theo thời gian chờ.

Kết quả xuất hiện ngay khi hoàn thành. Lỗi riêng một ảnh không xóa ảnh thành công và không chặn các ảnh khác; có thể thử lại một ảnh hoặc toàn bộ phần chưa hoàn tất. Lỗi thanh toán, xác thực, quota, rate limit, cấu hình provider hoặc lưu trữ R2 dừng gửi request mới, đánh dấu ảnh chưa gửi là tạm dừng. Các request đã gửi tiếp tục hoàn tất và giữ kết quả; tối đa 3 request có thể đã bắt đầu trước khi phát hiện lỗi chung. Retry dùng provider đang được chọn lúc retry, cho phép đổi provider để tiếp tục. Nếu R2 lỗi, cần khôi phục storage trước khi tiếp tục.

Dừng sẽ hủy request/việc đọc trạng thái ở client và không gửi phần còn lại; tác vụ async đã được API nhận vẫn chạy, lưu kết quả và có thể tính phí. Retry thủ công tạo tác vụ mới. Phản hồi từ bộ đã dừng không được ghi vào bộ mới hoặc mở khóa model của bộ mới. Chỉ luồng đồng bộ cũ dừng các bước chưa bắt đầu khi client ngắt kết nối. Upload R2 được retry độc lập để không gọi lại model trong cùng tác vụ khi storage lỗi.

Xem ảnh mở hộp thoại gồm sản phẩm gốc, ảnh tham chiếu và kết quả. Tải riêng hoặc ZIP các ảnh thành công; tên file chứa tên sản phẩm, ảnh tham chiếu, thứ tự kết quả và biến thể. ZIP báo số ảnh tải lỗi nếu có. Cần CORS GET từ origin frontend trên domain R2. Đổi tab giữ dữ liệu; tải lại trang xóa hàng đợi và kết quả trong bộ nhớ. Endpoint `/api/backgrounds/replace` và tên phương thức `replaceBackground` được giữ để tương thích; chức năng hiện tại là chuyển hình in, không thay background.
