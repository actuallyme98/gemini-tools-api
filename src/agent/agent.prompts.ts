export const MOCKUP_RULES = `QUY TẮC BẮT BUỘC:
ẢNH 1 là ảnh tham chiếu/ảnh đích cần chỉnh sửa; ẢNH 2 là sản phẩm hoặc thiết kế nguồn.
Thực hiện đúng thao tác người dùng yêu cầu: thay toàn bộ sản phẩm hoặc chỉ chuyển hình in; không đảo vai trò hai ảnh.
Giữ bố cục, background, chủ thể, ánh sáng và các chi tiết không được yêu cầu thay đổi trong ảnh đích.
Giữ nguyên nội dung thiết kế nguồn, chữ, màu sắc và tỉ lệ; chỉ điều chỉnh vị trí, góc nhìn và kích thước cần thiết để khớp vùng đặt sản phẩm/vùng in trong ảnh đích.
Không tạo watermark, chữ ký hoặc logo mới. Giữ chữ và logo vốn thuộc thiết kế sản phẩm.
YÊU CẦU CỤ THỂ:
`;
export const DESIGN_RULES = `QUY TẮC BẮT BUỘC:
Tạo thiết kế theo yêu cầu cụ thể bên dưới. Không tạo watermark, chữ ký hoặc logo mới ngoài nội dung thiết kế được yêu cầu.
YÊU CẦU CỤ THỂ:
`;
export function finalPrompt(prompt: string, operation: string) {
  if (operation === 'mockup_template') return prompt;
  const rules = operation === 'design' ? DESIGN_RULES : MOCKUP_RULES;
  return prompt.startsWith(rules) ? prompt : `${rules}${prompt}`;
}
export const CLARIFICATION_RULES = `autoAnswers là các câu trả lời đã được chọn theo chế độ Auto approval người dùng đã bật; phải áp dụng và không hỏi lại các nội dung này. Chỉ hỏi khi thông tin còn thiếu thực sự chặn việc chọn thao tác hoặc giữ đúng thiết kế; nếu yêu cầu đã rõ thì questions=[]. Không hỏi lại điều người dùng đã trả lời trong yêu cầu, lịch sử hoặc thông tin bổ sung mới nhất. Không hỏi phần mềm Photoshop/Midjourney/Stable Diffusion: ứng dụng tự thực hiện bằng công cụ đã tích hợp. Không hỏi định dạng xuất hoặc độ phân giải nếu công cụ không hỗ trợ lựa chọn đó; dùng thiết lập hiện có. Mỗi phần tử questions phải là {question,options:[{label,description}]}, bằng tiếng Việt, 2–4 lựa chọn cụ thể khác nhau. Lựa chọn đầu tiên là phương án đề xuất phù hợp yêu cầu đã có; không tự coi đó là câu trả lời đã được duyệt. Không thêm lựa chọn "Khác" vì UI đã có ô tự nhập. Chỉ hỏi về đúng sản phẩm thực tế, không mặc định là áo hay một nhóm sản phẩm cố định.`;
