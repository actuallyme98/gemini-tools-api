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

Mỗi ảnh PNG/JPEG/WebP tối đa 10MB, kiểm tra MIME và chữ ký. Một request trả HTTP 201 với `{ "url": "https://…", "mimeType": "image/png" }`; MIME thực tế có thể là PNG/JPEG/WebP. URL lưu trên R2 với đuôi tương ứng. Lỗi theo [hợp đồng lỗi chung](api-errors.md).

AI nhận đúng hai ảnh theo thứ tự: IMAGE 1 là sản phẩm gốc; IMAGE 2 là ảnh tham chiếu cần chỉnh sửa. Prompt base nằm tại `src/constants/background-studio-prompt.ts` trong repo frontend, hướng dẫn giữ nguyên hình in và tỷ lệ so với sản phẩm, chỉ chiếu theo phối cảnh, độ cong, nếp gấp và phần bị che khuất; giữ nguyên cấu trúc sản phẩm đích và toàn bộ cảnh. Đây là nội dung mặc định có thể sửa, không phải quy tắc ẩn bắt buộc của API.

Client chụp toàn bộ nội dung ô Custom prompt tại lúc tạo bộ và gửi trong `instructions`, không trim hoặc ghép thêm. API dùng nguyên prompt này trong nội dung `user`, không nối base, không thêm nhãn text hoặc câu ràng buộc sau prompt, không thêm hướng dẫn theo `variationIndex`, không qua model text viết lại. Gemini native và ShopAIKey GPT/Grok dùng cùng hợp đồng; hai ảnh giữ nguyên thứ tự. Multipart từ trình duyệt có thể chuẩn hóa xuống dòng thành CRLF. Prompt thiếu, chỉ có khoảng trắng hoặc dài hơn 12000 ký tự trả 400 trước khi gọi AI. Nút Khôi phục prompt gốc chỉ thay nội dung ô nhập khi người dùng bấm; không tự khôi phục khi xóa trắng. Khóa ô nhập và nút khôi phục trong lúc xử lý. Mỗi kết quả là một lần gọi độc lập với cùng prompt đã lưu.

Đây là chỉnh sửa bằng model tạo ảnh, không phải tách lớp/copy pixel cố định. Model xử lý theo prompt cuối cùng người dùng chọn; API chưa có mask hay kiểm định ảnh đầu ra để bảo đảm độ chính xác từng pixel hoặc kích thước pixel đầu ra. Người dùng cần đối chiếu hình in và ảnh tham chiếu trước khi tải.

Gemini và ShopAIKey hỗ trợ qua phương thức `AIProvider.replaceBackground`; dùng model ảnh được cấu hình ở provider đó. Provider thiếu khả năng hoặc phương thức này trả 400 trước khi tạo ảnh, không fallback. Provider mới cần triển khai phương thức này và khai báo capability `image`.

## Hàng đợi trên client

Client gửi từng cặp tuần tự, mỗi kết quả là một request riêng. Provider/model được chụp tại lúc bắt đầu và giữ cho cả hàng đợi; lựa chọn provider/model và custom prompt bị khóa khi đang xử lý. Các file và custom prompt được giữ theo bộ đã tạo; retry giữ custom prompt cũ của tác vụ, dùng provider/model đang chọn lúc retry. Muốn áp dụng custom prompt đã sửa phải tạo bộ mới. Chi phí AI tăng theo số kết quả yêu cầu.

Kết quả xuất hiện ngay khi hoàn thành. Lỗi một ảnh không xóa ảnh thành công; có thể thử lại một ảnh hoặc toàn bộ phần chưa hoàn tất. Lỗi thanh toán, xác thực, quota, cấu hình provider hoặc lưu trữ R2 dừng phần còn lại để tránh lặp yêu cầu vô ích. Retry dùng provider đang được chọn lúc retry, cho phép đổi provider để tiếp tục. Nếu R2 lỗi, cần khôi phục storage trước khi tiếp tục.

Dừng sẽ hủy request client và không gửi phần còn lại; lời gọi đã đến provider có thể vẫn chạy/tính phí. API dừng các bước chưa bắt đầu khi client ngắt kết nối. Upload R2 được retry độc lập để không gọi lại model trong cùng request khi storage lỗi.

Xem ảnh mở hộp thoại gồm sản phẩm gốc, ảnh tham chiếu và kết quả. Tải riêng hoặc ZIP các ảnh thành công; tên file chứa tên sản phẩm, ảnh tham chiếu, thứ tự kết quả và biến thể. ZIP báo số ảnh tải lỗi nếu có. Cần CORS GET từ origin frontend trên domain R2. Đổi tab giữ dữ liệu; tải lại trang xóa hàng đợi và kết quả trong bộ nhớ. Endpoint `/api/backgrounds/replace` và tên phương thức `replaceBackground` được giữ để tương thích; chức năng hiện tại là chuyển hình in, không thay background.
