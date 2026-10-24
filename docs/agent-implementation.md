# Triển khai P0–P2

Người dùng đã yêu cầu triển khai sau khi hoàn thành tài liệu ngày 24/10/2026.
Tài liệu bàn giao và báo giá 30 triệu của hệ thống hiện tại nằm tại thư mục cha MLHM/Tai_lieu_LCG_Agent_2026-10-24; báo giá không tự mở rộng thành báo giá cho các module mới.

## Tiêu chí nghiệm thu

- [x] P0 — phần mềm: tra cứu bảng giá theo nhóm, kiểm tra cấu hình, giữ nguyên lỗi ngân sách, đối soát có nhật ký; không tự chuyển credit thành USD. Quy tắc token cần đủ giá input/output; bảng giá cũ thiếu một vế sẽ giữ chỗ chờ đối soát.
- [ ] P0 — kiểm thử provider thực tế: đã xác minh nhóm ShopAIKey cheap/gemini/claude_code, đơn vị credit và áp dụng 19 quy tắc giá với hạn mức 50 credit/tài khoản/tuần. VyceAI chưa có giá xác minh được bỏ qua trước health probe, dùng fallback ShopAIKey. Còn kiểm thử request thật và đối chiếu usage trong đợt release.
- [x] P1: QA sáu tiêu chí, bằng chứng và độ tin cậy; thiếu mục/không chắc/lệch số sản phẩm đều chuyển duyệt. AI không tự khẳng định độ chính xác pixel/OCR.
- [x] P1: màn hình ghép vùng in bốn góc, mask, overlay và hòa trộn dùng renderer hiện có; không gọi AI vẽ lại.
- [x] P1: danh sách công việc theo từng run, phân trang, bộ lọc, tiến độ, ảnh nguồn/đích/kết quả, prompt, lỗi, nhận xét và chi phí từ sổ. Chi phí cũ không có sổ không được coi là miễn phí.
- [x] P1: dự án, bốn quyền thành viên, phân công người phụ trách/người duyệt, nhận xét và duyệt ảnh được kiểm tra ở API. Hội thoại đầy đủ vẫn riêng tư.
- [x] P1: lưu ca chuẩn, bộ ảnh, yêu cầu/số sản phẩm, điểm có ghi chú; so sánh model/mã prompt/chi phí/tổng thời gian các bước. Không có vòng chạy AI trả phí tự động.
- [x] P2: tìm kiếm keyword và đọc tối đa năm nguồn HTTPS, ngày truy cập, phân biệt đã đọc/trích đoạn; đưa dữ liệu có nguồn vào chat. Không giả lập lượng tìm kiếm/doanh số.
- [x] P2: kiến thức riêng tư/dự án/công ty; tìm toàn văn theo quyền, lấy đoạn liên quan trong giới hạn và lưu snapshot nguồn/phiên bản đã dùng vào run.
- [x] P2: preset pixel/DPI, kiểm tra alpha, vùng đệm an toàn, SKU/thư mục/tên ảnh và manifest ZIP; mặc định chỉ xuất ảnh đã duyệt.
- [x] P2: CSV UTF-8 tối đa 500 dòng/1 MB, ánh xạ cột, preview cặp, chia lô tối đa 20 ảnh và giữ nguyên run ID; tiếp tục không gửi lại lô đã có. Trả lời câu hỏi bổ sung giữ nguyên cặp và prompt theo SKU.
- [x] P2: thông báo theo trạng thái cho chủ công việc/người phụ trách/người duyệt có quyền; cảnh báo queue/provider/budget/dung lượng; CLI backup mã hóa có kiểm tra restore thực sự trong test.
- [ ] Vận hành production: cài key backup riêng, thư mục lưu, timer, sao chép ngoài server, retention và chạy thử restore từ archive production. Xem [agent-backup.md](agent-backup.md). Chưa bật timer trên server.

## Nguyên tắc

Release theo yêu cầu deploy ngày 24/10/2026. Giữ nguyên dữ liệu production. Không mở lại các tab Workflow, Template và Công cụ. Fulfillment ngoài phạm vi. Dùng MongoDB/Redis/BullMQ và renderer đang có; không tạo hệ thống xếp hàng thứ hai.

## Nhật ký

- Hoàn thành báo cáo và báo giá: DOCX + PDF trong MLHM.
- Đang thực hiện P0: endpoint bảng giá công khai chỉ để đối chiếu; chưa tự áp dụng giá do chưa xác minh nhóm và đơn vị tính của tài khoản.

## Cách dùng phần mới

- Tab Công việc dùng `/agent/workspace/jobs`; mỗi run là một dòng, không nhóm cả hội thoại thành một công việc nữa.
- Tab Không gian nhóm tập hợp Dự án, Kiến thức, Nghiên cứu, Batch CSV, Ghép chính xác, Xuất file, Đánh giá và Thông báo; chỉ admin thấy Giám sát.
- Chat → Tùy chọn nâng cao → Dự án cho yêu cầu mới để lấy kiến thức của dự án và chia sẻ công việc mới. Công việc cũ có thể phân công từ chi tiết công việc.
- Thư viện hiển thị ID ảnh đầy đủ/copy để chuẩn bị CSV. Chi tiết công việc có mã đầy đủ để ghi ca đánh giá.
- Quản trị → Ngân sách & bảng giá → Tra cứu bảng giá công khai. Tra cứu không ghi đè chính sách; lưu quy tắc vẫn cần xác nhận, lý do và kiểm tra phiên bản.
- Hướng dẫn sử dụng đã có chương mới cho toàn bộ luồng này.

## Giới hạn đã xác định

- Quyền xem dự án không mở toàn bộ chat hay ảnh riêng khác của chủ công việc. Thành viên được giao việc có thể theo dõi/trao đổi; gửi AI và duyệt prompt vẫn qua chủ công việc, dùng ngân sách chủ công việc. Reviewer có thể duyệt/yêu cầu sửa ảnh chung. Chưa có cơ chế chuyển quyền sở hữu hoặc cho người khác tiêu ngân sách của chủ công việc.
- QA là đánh giá AI có ngưỡng 0,85 và kiểm tra đủ sáu mục/số lượng; vẫn cần người duyệt. File ghép chính xác cần thiết kế/mask tốt; không tự tách sản phẩm khỏi ảnh chụp.
- Knowledge dùng MongoDB text index, không phải tìm kiếm ngữ nghĩa bằng embeddings. Tối đa tám tài liệu ứng viên, khoảng 8.000 ký tự trích dẫn; run lưu snapshot để không đổi prompt âm thầm.
- Danh sách dự án/kiến thức hiện giới hạn 200; nghiên cứu/batch/thông báo 100 bản gần nhất; kết quả đánh giá 500. Trang công việc phân trang 30. Cần mở rộng phân trang các danh mục khi công ty vượt các mức này.
- Nguồn nghiên cứu chỉ HTTPS công khai có IPv4, tối đa 1 MB/trang, timeout và kiểm tra DNS/redirect. Trang chặn bot không được coi là đã đọc. Chưa tích hợp nhà cung cấp thống kê keyword có phí.
- Batch gửi từng lô để duyệt, không tự bỏ qua bước duyệt prompt. Lô lỗi vẫn được giữ để kiểm tra; chạy lại ảnh là hành động có phí riêng. CSV không chấp nhận ảnh thuộc tài khoản khác hoặc link tải tùy ý.
- Giám sát trong ứng dụng và timer systemd là mức vận hành một server; chưa có cảnh báo email/Slack, cluster HA hay giám sát host từ bên ngoài. Thông báo giữ 90 ngày.
- Backup có khoảng bảo trì, cần khóa backup và khóa mã hóa ảnh lưu tách biệt. Chưa tự xóa archive cũ hoặc tự phục hồi lên production; chưa sao lưu Redis, logs ổ đĩa hoặc các ảnh public của công cụ cũ ngoài namespace Agent.

## Xác minh

Build/lint và test được chạy cho cả hai repo. Kiểm thử API dùng MongoDB tạm riêng; provider/ảnh trong các test trả phí được mock. Các ca trọng tâm gồm chặn truy cập chéo tài khoản, quyền reviewer, kiến thức theo quyền, batch song song không nhân bản/cặp ghép sau câu trả lời, CSV 500 dòng trên 100 KB, kích thước/DPI/alpha và restore archive có ảnh R2. File archive bị sửa bị từ chối trước khi ghi DB; session bị hủy, hàng đợi/tác vụ đang chạy được dừng để đối soát.

Đã đạt 176 test đơn vị API, 170 test tích hợp API và 99 kịch bản frontend (bao gồm các lượt chạy lại sau sửa fixture và hồi quy). Một lượt chạy đồng thời nhiều bộ test làm hook khởi tạo MongoDB trên Windows quá 5 giây; bộ provider-routing được chạy lại riêng với timeout 30 giây và 40 ca đều đạt. Không sửa logic sản phẩm để bỏ qua lỗi test. Kiểm tra riêng thêm luồng trả lời bổ sung, giữ cặp CSV/SKU và export POD 4500×5400; file PNG có tên dài vẫn giữ đuôi `.png`.

Chưa gọi AI trả phí, chưa đối soát số tiền với provider thật, chưa khôi phục archive production và chưa deploy. Các bước còn chờ được giữ nguyên trong checklist trên.
