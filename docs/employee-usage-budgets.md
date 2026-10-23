# Hạn mức AI theo tài khoản

Đã triển khai trong API và frontend; chưa deploy. Không cần biến môi trường mới hoặc migration phá hủy dữ liệu. Áp dụng khi Agent/MongoDB đang bật.

## Quy tắc

- Tất cả tài khoản, kể cả admin, kế thừa mặc định **50 USD/tuần**. Admin có thể đổi mặc định công ty hoặc đặt hạn mức riêng cho từng người.
- Tuần bắt đầu **thứ Hai 00:00 UTC+7** (`Asia/Bangkok`); không chuyển số dư sang tuần sau. Lịch sử tuần cũ được giữ lại.
- Hạn mức riêng tiếp tục áp dụng các tuần sau cho đến khi đổi hoặc chọn dùng mặc định công ty.
- Tăng/giảm có hiệu lực cho lời gọi AI tiếp theo. Không xóa chi phí đã dùng và không hủy request đã gửi. Đặt 0 để chặn request AI mới; vẫn có thể đọc hội thoại và tải kết quả cũ.
- Khả dụng = `max(0, hạn mức − đã dùng − đang giữ chỗ)`.
- Mỗi lời gọi AI được giữ chỗ riêng ngay trước khi gửi upstream, kể cả phân tích ảnh, lập kế hoạch, compact context, health check trả phí và fallback. Số dư chung của API key không được dùng để suy ra chi phí của nhân viên.

## Cách dùng

**Quản trị công ty → Tài khoản:** xem usage và bấm điều chỉnh ngân sách của tài khoản. Chọn hạn mức riêng hoặc dùng mặc định, nhập lý do, xem trước rồi xác nhận. Hộp thoại có lịch sử theo tuần, nhật ký request phân trang 50 dòng và đối soát khoản chưa rõ chi phí.

**Quản trị công ty → Vận hành:** mục “Ngân sách & bảng giá AI” quản lý mặc định công ty và quy tắc giá của từng kết nối/model/tác vụ. Thay đổi mặc định không ghi đè hạn mức riêng. Thay đổi hạn mức, chính sách và đối soát đều có audit log; các chỉnh sửa đồng thời bị phát hiện bằng version.

**Nhân viên:** xem ngân sách tuần ở đầu workspace, gồm đã dùng, giữ chỗ, khả dụng và thời điểm cấp lại. Chỉ xem được số liệu của chính mình. Dữ liệu làm mới mỗi 30 giây, khi số công việc đang chạy thay đổi, hoặc qua nút cập nhật.

## Cấu hình giá trước khi sử dụng

**Bảng giá ban đầu rỗng. Model chưa có quy tắc sẽ bị chặn trước khi gửi AI**, với `BUDGET_PRICING_UNAVAILABLE`. Phải cấu hình giá đã kiểm tra trong tài khoản provider trước khi đưa tính năng này lên môi trường đang dùng.

Mỗi quy tắc cần đúng `provider + model + operation`:

- Provider: `shopaikey`, `gemini` hoặc `vyceai`.
- Operation: `text`, `vision`, `image` hoặc `health`. Text và health là hai quy tắc riêng, kể cả cùng model.
- `reserveUsd`: mức giữ chỗ dương, do admin đặt đủ bảo thủ cho kích thước/đầu ra thực tế của request.
- `requestUsd`: phí cố định mỗi request, nếu có.
- `inputUsdPerMillion`, `outputUsdPerMillion`: USD/triệu token, nếu tính theo token. Điền đầy đủ các thành phần bị tính phí.
- `imageUsd`: phí mỗi ảnh đầu ra, chỉ áp dụng cho operation image.
- `source`: căn cứ/phiên bản giá đã xác minh. Không nhập API key hoặc bí mật vào trường này.

Các thành phần giá được cộng lại. Không điền giá suy đoán hoặc coi ô trống là miễn phí. Nếu provider có nhiều mức giá theo chất lượng/kích thước mà chưa biểu diễn chính xác được bằng quy tắc hiện tại, chỉ cấu hình giữ chỗ và đối soát thủ công; không dùng một mức giá ảnh chung như hóa đơn chính xác.

Thứ tự xác định chi phí:

1. Trường `cost_usd` rõ đơn vị trong response/usage của provider.
2. Phí cố định và usage token/ảnh nhân bảng giá đã cấu hình; hiển thị “Theo bảng giá cấu hình”. Snapshot giá được lưu ở từng request, không tính lại lịch sử khi admin đổi giá.
3. Nếu thiếu dữ liệu cần thiết hoặc không xác định được chi phí: giữ chỗ và chuyển “Chờ đối soát”. Không tự ghi chi phí 0.

Chi phí được lưu bằng số nguyên micro-USD, không cộng dồn bằng số thực. Nếu upstream tính cao hơn mức giữ chỗ, ghi đủ chi phí và chặn các lời gọi tiếp theo khi hết khả dụng. Đây là giới hạn tiếp nhận dựa trên mức giữ chỗ; không phải cam kết trần hóa đơn tuyệt đối của provider.

## Gián đoạn và đối soát

- Timeout, lỗi kết nối hoặc lỗi upstream chưa rõ kết quả: giữ ngân sách và trả `BUDGET_REQUEST_UNRESOLVED`, không tự retry hoặc đổi model. Không tự hoàn tiền khi chưa xác minh.
- Lỗi 4xx có phản hồi rõ từ upstream (trừ timeout 408) vẫn giữ thông báo lỗi gốc; khoản giữ chỗ cần kiểm tra/đối soát. Fallback nếu có là một lượt riêng, phải giữ chỗ tiếp.
- Khi worker chết, khoản `submitted` quá 30 phút có thể được admin đối soát. Đây không phải xác nhận request không bị tính phí; admin phải kiểm tra lịch sử provider trước.
- Admin nhập chi phí đã xác minh cùng lý do, xem trước rồi xác nhận. Chỉ nhập 0 khi đã xác nhận không tính phí. Đối soát không gửi lại AI và không trừ lần hai.
- Request kết thúc sau khi chuyển tuần vẫn chốt vào tuần đã giữ chỗ. Worker chạy lại không được gửi lại cùng lượt đã lưu, kể cả qua tuần mới.
- Lỗi ghi sổ sau khi AI đã thành công không được kích hoạt retry AI; ngân sách vẫn giữ để đối soát.

## Lưu trữ và giới hạn hiện tại

Dùng các loại entity trong `AgentStore` MongoDB hiện tại:

- `budget-policy`: chính sách công ty và bảng giá.
- `budget-account`: mỗi tài khoản một document, chứa override, revision và các kỳ tuần với tổng chi phí, giữ chỗ và nhật ký request.
- `admin-audit`: người sửa, đối tượng, lý do, trước/sau và kết quả thao tác.

Cập nhật nhật ký và counters trong **cùng document bằng compare-and-set**, hoạt động với MongoDB standalone hiện tại. Redis/BullMQ không lưu nguồn sự thật về tiền. Nhiều tab/worker không thể cùng giữ một phần ngân sách đã được giữ bởi request khác.

Nhận tối đa 5.000 lượt AI/tài khoản/tuần và chặn nhận thêm khi document đạt khoảng 8 MB; dành khoảng trống đến 15 MB để chốt các lượt đang chạy. Cần bổ sung lưu trữ lịch sử hoặc chuyển sang replica set/transactions trước khi vượt giới hạn này. Không tự xóa lịch sử để cấp lại ngân sách.

## API

| Endpoint                                                          | Quyền        | Công dụng                                              |
| ----------------------------------------------------------------- | ------------ | ------------------------------------------------------ |
| `GET /api/agent/usage`                                            | Đã đăng nhập | Summary tuần của chính mình                            |
| `GET /api/agent/admin/users/:id/usage?period=YYYY-MM-DD&cursor=0` | Admin        | Nhật ký theo tuần, phân trang 50 dòng                  |
| `PATCH /api/agent/admin/users/:id/budget`                         | Admin        | `{weeklyUsd: number hoặc null, policyVersion, reason}` |
| `GET /api/agent/admin/budget-policy`                              | Admin        | Chính sách và bảng giá                                 |
| `PATCH /api/agent/admin/budget-policy`                            | Admin        | `{defaultWeeklyUsd, prices, updatedAt, reason}`        |
| `PATCH /api/agent/admin/users/:id/usage/:period/:entry`           | Admin        | `{costUsd, reason}` đối soát                           |

`period` là ngày thứ Hai bắt đầu tuần. Hạn mức tối đa hai chữ số thập phân; đơn giá/chi phí đối soát tối đa sáu. Giới hạn đầu vào 0–1.000.000 USD. Lỗi vượt ngân sách trả `USER_BUDGET_EXCEEDED` (403), xung đột trả `BUDGET_CONFLICT` (409); không tự retry các lỗi ngân sách.

## Kiểm thử

- `test/budget.e2e-spec.ts`: MongoDB standalone thật, quyền truy cập, USD, đổi hạn mức, cạnh tranh nhiều tab, restart, thiếu giá/usage, đối soát một lần, gián đoạn và chuyển tuần.
- `src/ai/text-router.service.spec.ts`: không dùng fallback để vượt lỗi ngân sách hoặc gửi lại lượt chưa rõ chi phí.
- Frontend `tests/admin.spec.ts`: xác nhận trước khi lưu, giữ input khi conflict, bảng giá và hiển thị mobile.

Kiểm thử dùng MongoDB tạm và response giả; không gửi request AI trả phí hoặc chỉnh dữ liệu production.
