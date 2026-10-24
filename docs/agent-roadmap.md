# Kế hoạch dự kiến hoàn thiện LCG Agent

Cập nhật: 24/10/2026.

Trạng thái: người dùng đã yêu cầu triển khai P0–P2 sau khi hoàn thành báo cáo và báo giá. Tiến độ, phạm vi đã thực hiện và các điều kiện còn chờ được ghi trong [agent-implementation.md](agent-implementation.md). Tài liệu này giữ các đề xuất gốc để đối chiếu; không có nghĩa mọi hạng mục đã được đưa lên production.

## Phạm vi

- Mockup sản phẩm POD.
- Tạo ý tưởng và hỗ trợ Design.
- Chưa triển khai Fulfillment, đồng bộ đơn hàng, Etsy, Printify hoặc Merchize.
- Giữ việc ẩn các tab Workflow, Template và Công cụ theo yêu cầu hiện tại. Đề xuất trong tài liệu này không tự động bật lại các mục đó.

## Nền tảng đã có

- Đăng nhập bằng tài khoản/Google, quyền admin và designer, quản lý tài khoản và domain đăng nhập.
- Chat, lưu đầy đủ hội thoại, tải thêm lịch sử, compact context và ghim yêu cầu.
- Phân tích ảnh, chọn thao tác, lập kế hoạch, câu hỏi bổ sung và duyệt thủ công/tự động.
- Mockup bằng AI, ghép theo template và tạo thiết kế/biến thể.
- Redis/BullMQ, worker riêng, giới hạn đồng thời và bảo vệ gửi trùng.
- Lưu ảnh, phiên bản cơ bản, duyệt kết quả và xuất ZIP kèm manifest.
- Quản trị, audit/request logs và hạn mức AI mặc định 50 USD/tài khoản/tuần.
- Workflow/template có phần triển khai; các tab và chức năng tạo mới đang được ẩn.

## Các module dự kiến

| Mức | Module | Hiện trạng / phần cần bổ sung | Kết quả mong muốn |
| --- | --- | --- | --- |
| P0 | Giá và đối soát chi phí | Kiểm tra production ngày 24/10/2026: chưa có quy tắc giá; request AI mới bị chặn. Cần cấu hình giá thực tế, mức giữ chỗ và quy trình đối soát. | Model được phép sử dụng có căn cứ giá rõ ràng; không coi thiếu usage là miễn phí hoặc tự gửi lại request chưa rõ chi phí. |
| P1 | Kiểm soát chất lượng ảnh | Đã có kiểm tra AI, nhưng chưa có bộ tiêu chí định lượng và quy tắc xử lý đầy đủ. | Kiểm tra đúng nguồn/đích, đủ sản phẩm, chữ/màu/tỉ lệ và watermark mới; chuyển duyệt khi nghi ngờ. |
| P1 | Giữ nguyên thiết kế khi ghép | Nhánh AI có thể vẽ lại sản phẩm; đã có renderer template làm nền tảng. | Chọn vùng, mask và ghép bằng phép biến đổi ảnh khi cần giữ thiết kế chính xác. Không cam kết AI tạo sinh giữ nguyên từng pixel. |
| P1 | Công việc độc lập với hội thoại | Tab Công việc hiện nhóm theo hội thoại. | Mỗi công việc có mã, đầu vào, kết quả, tiến độ, chi phí và trạng thái riêng; một hội thoại chứa nhiều công việc. |
| P1 | Duyệt và cộng tác công ty | Dữ liệu chủ yếu theo tài khoản; mới có hai vai trò admin/designer. | Dự án/nhóm, giao việc, người phụ trách/người duyệt, nhận xét, yêu cầu sửa và quyền theo hành động. |
| P1 | Kiểm thử chất lượng Agent | Có test kỹ thuật, chưa có bộ đánh giá chất lượng ảnh/prompt chuẩn. | Lưu các ca từng lỗi và bộ ảnh mẫu; đo độ đúng, chi phí, thời gian trước khi đổi model hoặc prompt. |
| P2 | Nghiên cứu keyword có nguồn | Hiện nhận nội dung/link nghiên cứu từ người dùng; chưa có luồng tự tìm và đọc nguồn. | Tìm kiếm, tổng hợp, lưu nguồn/ngày truy cập; phân biệt số liệu thực với đề xuất của model. |
| P2 | Kho kiến thức công ty | Có bộ nhớ hội thoại, chưa có kho kiến thức dùng chung. | Lưu brand guideline, quy chuẩn POD, kích thước in, sản phẩm mẫu và thiết kế đã duyệt; truy xuất đúng phần liên quan theo quyền. |
| P2 | Chuẩn hóa file đầu ra | Có đặt tên, phân loại và ZIP cơ bản. | Preset kích thước pixel, nền trong suốt, vùng an toàn, quy tắc tên/SKU/thư mục và kiểm tra file theo sản phẩm. |
| P2 | Batch phục vụ sản xuất | Có xử lý song song; Agent giới hạn 20 kết quả/run. | Nhập CSV nguồn–tham chiếu, xem trước cặp ghép, chia lô và tiếp tục phần chưa chạy; không tạo lại ảnh thành công. |
| P2 | Thông báo và giám sát | Có logs/health check; chưa thấy hệ thống cảnh báo tập trung trong repo. | Thông báo xong/lỗi/chờ duyệt; cảnh báo queue kẹt, provider lỗi, ngân sách thấp và dung lượng lưu trữ. |

P0: điều kiện vận hành trước mắt. P1: độ tin cậy và phối hợp nội bộ. P2: mở rộng năng suất sau khi luồng chính ổn định.

## Thứ tự triển khai đề xuất

1. **Mở hoạt động:** cấu hình giá; kiểm tra xuyên suốt chat → duyệt → tạo ảnh → lưu → xuất.
2. **Tăng độ tin cậy:** tiêu chí kiểm tra ảnh, công cụ ghép chính xác và bộ ảnh kiểm thử.
3. **Phục vụ đội ngũ:** công việc độc lập, dự án, giao việc và duyệt chung.
4. **Mở rộng:** nghiên cứu keyword, kiến thức công ty, batch lớn và xuất file chuẩn.

## Nguyên tắc khi tăng khả năng tự hành

Hiện model chọn giữa các thao tác đã lập trình, sau đó hệ thống chạy theo luồng cố định. Chưa có vòng lặp tổng quát chọn công cụ → quan sát kết quả → điều chỉnh kế hoạch.

Ưu tiên hoàn thiện luồng hiện có trước khi thêm cơ chế tự lập lại kế hoạch hoặc tự sửa ảnh. Nếu bổ sung vòng lặp, phải có giới hạn số bước, số lần thử, thời gian và ngân sách; hiển thị các lần gọi và yêu cầu duyệt khi cần. Không tự bật vòng retry trả phí cho request chưa rõ kết quả.

Tài liệu tham khảo: [Building effective agents — Anthropic](https://www.anthropic.com/research/building-effective-agents).

## Cần xác minh / chốt thêm

- Giá, giới hạn đầu ra và usage thực tế của từng model/provider trước khi cấu hình.
- Bộ tiêu chí đạt cho từng nhóm sản phẩm và người có quyền duyệt cuối.
- Cấu trúc dự án/nhóm và quy tắc chia sẻ dữ liệu giữa nhân viên.
- Sản lượng batch mục tiêu và chuẩn file đầu ra theo quy trình công ty.
- Backup tự động, retention và khả năng restore trên server: chưa kiểm tra đầy đủ trong lượt rà soát; không suy ra chỉ từ repository.
- Trạng thái production trong ghi chú là tại thời điểm kiểm tra, cần kiểm tra lại trước khi triển khai.

Lượt triển khai hiện tại làm local và kiểm thử riêng; chưa commit/push/deploy và chưa thay đổi dữ liệu production.
