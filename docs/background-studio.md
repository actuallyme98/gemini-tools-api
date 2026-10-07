# Background Studio

Frontend: `/#background-studio`. Một sản phẩm gốc được dùng cho tối đa 10 background tham chiếu. Người dùng chọn/bỏ chọn ảnh, chọn 1–3 kết quả mỗi background, tối đa 20 kết quả cho một lần tạo. Ghi chú ánh sáng/vị trí áp dụng cho cả bộ.

## API

`POST /api/backgrounds/replace`, `multipart/form-data`:

| Trường | Yêu cầu |
| --- | --- |
| `productImage` | Một ảnh sản phẩm gốc, bắt buộc |
| `backgroundImage` | Một ảnh tham chiếu background, bắt buộc |
| `provider` | Provider cụ thể do client chọn; bỏ qua dùng default image của API |
| `variationIndex` | Số nguyên 1–3, mặc định 1 |
| `instructions` | Tùy chọn, tối đa 2000 ký tự |

Mỗi ảnh PNG/JPEG/WebP tối đa 10MB, kiểm tra MIME và chữ ký. Một request trả HTTP 201 với `{ "url": "https://…", "mimeType": "image/png" }`; MIME thực tế có thể là PNG/JPEG/WebP. URL lưu trên R2 với đuôi tương ứng. Lỗi theo [hợp đồng lỗi chung](api-errors.md).

AI nhận đúng hai ảnh, theo thứ tự sản phẩm và background. Prompt giữ thiết kế/hình dáng/màu/logo của sản phẩm, tái tạo môi trường từ background, bỏ chủ thể có sẵn trong ảnh tham chiếu và khớp ánh sáng/bóng đổ. Đây là xử lý bằng model tạo ảnh; không phải tách lớp/copy pixel cố định, nên người dùng cần xem kết quả để kiểm tra chi tiết sản phẩm.

Gemini và ShopAIKey hỗ trợ qua phương thức `AIProvider.replaceBackground`; dùng model ảnh được cấu hình ở provider đó. Provider thiếu khả năng hoặc phương thức này trả 400 trước khi tạo ảnh, không fallback. Provider mới cần triển khai phương thức này và khai báo capability `image`.

## Hàng đợi trên client

Client gửi từng cặp tuần tự, mỗi biến thể là một request riêng. Provider được chụp tại lúc bắt đầu và giữ cho cả hàng đợi, kể cả khi dropdown đổi giữa chừng. Các file và ghi chú cũng được giữ theo bộ đã tạo. Chi phí AI tăng theo số kết quả yêu cầu.

Kết quả xuất hiện ngay khi hoàn thành. Lỗi một ảnh không xóa ảnh thành công; có thể thử lại một ảnh hoặc toàn bộ phần chưa hoàn tất. Lỗi thanh toán, xác thực, quota, cấu hình provider hoặc lưu trữ R2 dừng phần còn lại để tránh lặp yêu cầu vô ích. Retry dùng provider đang được chọn lúc retry, cho phép đổi provider để tiếp tục. Nếu R2 lỗi, cần khôi phục storage trước khi tiếp tục.

Dừng sẽ hủy request client và không gửi phần còn lại; lời gọi đã đến provider có thể vẫn chạy/tính phí. API dừng các bước chưa bắt đầu khi client ngắt kết nối. Upload R2 được retry độc lập để không gọi lại model trong cùng request khi storage lỗi.

Xem ảnh mở hộp thoại gồm sản phẩm gốc, background và kết quả. Tải riêng hoặc ZIP các ảnh thành công; tên file chứa tên sản phẩm, background, thứ tự kết quả và biến thể. ZIP báo số ảnh tải lỗi nếu có. Cần CORS GET từ origin frontend trên domain R2. Đổi tab giữ dữ liệu; tải lại trang xóa hàng đợi và kết quả trong bộ nhớ.
