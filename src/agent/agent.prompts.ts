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
