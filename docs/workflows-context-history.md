# Workflow nhân viên, context và lịch sử hội thoại

## Workflow

Nhân viên có mục **Workflows** để tạo, sửa, sắp xếp, lưu trữ/khôi phục quy trình riêng. Một workflow có 1–8 bước tuần tự: tạo thiết kế/biến thể, mockup AI, ghép template. Mỗi bước có hướng dẫn, số biến thể trên mỗi ảnh nguồn (design), nhận ảnh đầu vào ban đầu hoặc toàn bộ kết quả đã duyệt của bước trước. Ảnh tham chiếu, template, nhóm sản phẩm, provider/model chọn khi giao việc. Mỗi bước tối đa 20 kết quả.

Định nghĩa workflow thuộc người tạo, không cho đọc/sửa chéo tài khoản. Mỗi lần sửa tăng revision. Phiên chạy giữ snapshot định nghĩa, ảnh đầu vào và provider/model, nên sửa workflow không ảnh hưởng việc đang chạy. Các template cũng giữ snapshot như trước.

Chọn **Sử dụng**, điền yêu cầu và chọn đủ tệp cho toàn bộ các bước. Hệ thống lập kế hoạch bước đầu. Nhân viên sửa/duyệt final prompt rồi bắt đầu tạo ảnh. Sau khi toàn bộ kết quả được duyệt, chọn **Lập kế hoạch bước tiếp theo**. Bước kế tiếp nhận ID ảnh đã duyệt thực tế. Bước lỗi/cần thông tin có thể bổ sung và lập kế hoạch lại; retry ảnh cập nhật bản chạy hiện tại của workflow. Không tự gửi lại request tạo ảnh hoặc tự duyệt kết quả. Cuối quy trình dùng thư viện/xuất ZIP hiện có.

Đây là workflow tuần tự dùng các công cụ POD có sẵn; chưa có nhánh điều kiện, vòng lặp, lịch chạy, webhook hoặc thực thi mã tùy ý. Workflow riêng của từng nhân viên; chưa chia sẻ định nghĩa giữa nhân viên.

API: `GET|POST /api/agent/workflows`, `PATCH /workflows/:id`, `POST /workflows/:id/launch`, `POST /workflow-executions/:id/stages/:stage` (stage bắt đầu từ 0), `POST /workflow-executions/:id/replan`. Launch/replan dùng UUID do client tạo để thử lại cùng yêu cầu không tạo bản chạy mới. Tất cả yêu cầu xác thực và kiểm tra ownership.

## Context

Mỗi lần lập kế hoạch lấy dữ liệu đến đúng tin nhắn người dùng của lần chạy đó; không lấy nội dung tương lai từ một lần chạy song song. Context gồm yêu cầu hiện tại, yêu cầu ghim, bộ nhớ tóm tắt, tin nhắn gần nhất, nghiên cứu đầu vào và phân tích ảnh. Yêu cầu ghim chỉnh ở **Ngữ cảnh công việc → Bộ nhớ & yêu cầu ghim**; thay đổi chỉ áp dụng cho kế hoạch tiếp theo, không sửa prompt đã duyệt.

Khi phần lịch sử chưa compact vượt 12 tin hoặc khoảng 6000 token ước tính, giữ tối đa 6 tin gần nhất (giảm thêm nếu dài), tóm tắt phần cũ theo các lô có giới hạn. Bản tóm tắt tối đa 6000 ký tự giữ mục tiêu, yêu cầu, quyết định mới nhất, câu hỏi và ID tài nguyên. MongoDB lưu checkpoint; so sánh checkpoint khi cập nhật tránh ghi đè bộ nhớ mới hơn. Summary không phải chỉ lệnh hệ thống hay bằng chứng người dùng đã duyệt. Không xóa lịch sử gốc khi compact.

Ước tính bảo thủ dùng số byte UTF-8 chia 3, không phải tokenizer hay usage tính phí của provider. Ngân sách dữ liệu đầu vào 24000 token ước tính; vượt ngân sách trả `AGENT_CONTEXT_TOO_LARGE`, không âm thầm cắt yêu cầu/nghiên cứu. Compact lỗi trả `AGENT_CONTEXT_COMPACTION_FAILED`, giữ lịch sử/checkpoint thành công trước đó và không gửi yêu cầu tạo ảnh. Text dùng router hiện có (VyceAI, health trước khi dùng, fallback ShopAIKey); phân tích ảnh dùng vision provider cấu hình. Lượt compact có thể phát sinh phí text tùy provider.

Image model nhận prompt cuối đã duyệt và các ảnh đúng vai trò; không nhận toàn bộ hội thoại. Độ chính xác bộ nhớ tóm tắt phụ thuộc model; yêu cầu quan trọng nên ghim và kiểm tra lại final prompt.

## Lưu toàn bộ hội thoại và tải thêm

Mỗi tin là record `kind=message` riêng trong `agent_records`, có conversationId, owner, ID idempotent và vị trí thời gian/ID ổn định. Không cắt 200 tin, không nhét toàn bộ chat vào một BSON document, không đặt TTL tin nhắn. Bản tóm tắt lưu riêng ở `conversation-memory`; runs/steps/ảnh tiếp tục lưu riêng.

`GET /api/agent/conversations/:id` trả 40 tin mới nhất và `messagePage.nextCursor`; truyền `before` để lấy trang trước. UI giữ vị trí cuộn khi chèn tin cũ, gộp trùng theo ID và không bỏ tin đã tải khi polling. Cuộn lên để tự tải thêm hoặc bấm nút. Danh sách hội thoại trong sidebar dùng `GET /api/agent/history?before=...`, 30 hội thoại/trang, sắp theo ngày tạo và ID; cuộn xuống hoặc bấm tải thêm. Cursor được kiểm tra nhưng quyền truy cập luôn dựa vào phiên đăng nhập.

Khởi động API tự chuyển các tin embedded còn tồn tại sang record riêng, chỉ xóa bản embedded sau khi đã lưu đủ. Migration idempotent và không gọi AI. Khi triển khai phải dừng phiên bản API/worker cũ trước khi chạy migration để tránh bản cũ tiếp tục ghi embedded chat. Các tin đã bị cơ chế 200 tin trước đây loại bỏ không thể khôi phục nếu không có backup. Lưu full history cần giám sát dung lượng và sao lưu MongoDB; R2 lưu ảnh như trước.

Danh sách domain Google chỉ do quản trị viên cấu hình trong MongoDB tại **Quản trị công ty → Vận hành**; `.env` chỉ giữ Google Client ID. Chưa cấu hình domain thì chặn Google login.
