# Kiểm tra VyceAI ngày 2026-10-07

Đã gọi trực tiếp gateway `https://vyceai.com/v1` bằng credential của tài khoản, không chuyển request sang Gemini. Dùng ảnh thử tổng hợp, không dùng ảnh khách hàng. Credential không nằm trong mã nguồn hoặc báo cáo.

| Tác vụ | Model / endpoint | Kết quả |
| --- | --- | --- |
| Văn bản JSON | `deepseek-v4.1`, `/chat/completions` | Thành công trong bước cấu hình trước đó. |
| Tạo ảnh từ văn bản | `grok-imagine-2`, `/images/generations`, `n=1` | HTTP 200, tải được ảnh thật 960 × 960, áo xanh chữ TEST đúng mô tả. |
| Phân tích sản phẩm | `claude-sonnet-4-6`, `/chat/completions`, ảnh PNG dạng data URL | Lần đầu HTTP 504. Lần sau HTTP 200 nhưng đọc áo xanh TEST thành áo trắng CLIC. |
| Vision với mẫu đối chứng | Claude, hai ảnh JPEG: vòng tròn đỏ ALPHA9 và hình vuông xanh BETA7 | Một phản hồi nói không đọc được data URI; phản hồi còn lại đọc sai hình vuông thành vòng tròn và không đọc được chữ. Chưa xác nhận vision hoạt động đúng. |
| Chỉnh ảnh bằng endpoint chuẩn | `grok-imagine-2`, `/images/edits`, JSON có ảnh nguồn và prompt | HTTP 200 nhưng Content-Type là HTML, trả trang frontend VyceAI thay vì kết quả API. |
| Ảnh tham chiếu qua generation | `/images/generations`, JSON có `image: {url, type: image_url}` | HTTP 200 nhưng không giữ ảnh nguồn: yêu cầu chỉ đổi nền của áo TEST, kết quả là thiết kế Thank you với lá cây. Không thể coi đây là chỉnh ảnh thành công. |

Tạo ảnh mới bằng Grok đã được xác minh. Chưa đủ bằng chứng để dùng VyceAI cho toàn bộ luồng app, vì các luồng mockup, ý tưởng và reference cần chỉnh ảnh nguồn. Kết quả áp dụng cho các model, định dạng request và thời điểm thử trên; không kết luận mọi endpoint hoặc model khác của gateway đều có cùng giới hạn.

Adapter VyceAI vẫn chỉ công bố text đã được xác minh. Không bật vision hay công bố khả năng chỉnh ảnh chỉ dựa vào HTTP 200. Muốn mở các tác vụ này cần gateway cung cấp endpoint/định dạng đầu vào ảnh hoạt động đúng và kiểm tra lại với mẫu đối chứng.

Chọn provider cụ thể trên client giữ toàn bộ bước AI ở provider đó. Tác vụ chưa hỗ trợ trả HTTP 400 trước khi thực hiện các bước trả phí. Lỗi upstream cũng không tự chuyển provider. Chỉ lựa chọn Mặc định hệ thống mới dùng cấu hình `AI_*_PROVIDER` riêng của server.
