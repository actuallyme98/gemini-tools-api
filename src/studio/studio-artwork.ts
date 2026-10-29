import sharp from 'sharp';
import type {
  CreativeBrief,
  StudioPrintSpec,
  StudioSnapshot,
} from './studio.types';
export function artworkPrompt(snapshot: StudioSnapshot, brief: CreativeBrief) {
  return [
    'Tạo duy nhất FILE THIẾT KẾ PHẲNG ĐỘC LẬP (artwork), không phải ảnh chụp sản phẩm hoặc mockup. ẢNH 1 là ý tưởng nguồn; ẢNH 2 chỉ tham khảo hình học/vùng in của sản phẩm. Các ảnh sau chỉ là ví dụ.',
    'Không tạo người mẫu, bàn tay, khung cảnh, bóng đổ vật lý, dây treo, bo viền sản phẩm hoặc phối cảnh. Bố cục chính diện, đầy đủ chữ/motif, không cắt mất thiết kế. Không thêm watermark hay chữ ký.',
    `Yêu cầu: ${snapshot.input.brief}\nSản phẩm: ${snapshot.product.instructions}`,
    `SKILL.md:\n${snapshot.skill.instructions}\n${(snapshot.skill.documents ?? []).map((d) => d.content).join('\n')}`,
    `Brief của mẫu này: ${JSON.stringify(brief)}`,
    'Trong bước artwork chỉ áp dụng quy tắc sáng tạo nội dung của bộ hướng dẫn; phần chụp sản phẩm, bối cảnh và phối cảnh của bộ hướng dẫn được thực hiện ở bước thumbnail sau. Ở đây chỉ trả về thiết kế phẳng độc lập.',
    snapshot.product.printSpec
      ? `Quy chuẩn file: ${JSON.stringify(snapshot.product.printSpec)}. Không coi metadata DPI là bằng chứng chất lượng in. Nền ${snapshot.product.printSpec.background === 'transparent' ? 'trong suốt thực sự, không vẽ bàn cờ' : 'trắng'}.`
      : 'Dùng nền trắng, không thêm bối cảnh. File cần người dùng kiểm tra quy chuẩn kích thước trước sản xuất.',
  ].join('\n\n');
}
export function thumbnailPrompt(snapshot: StudioSnapshot) {
  return [
    'ẢNH 1 là ARTWORK GỐC đã tạo. ẢNH 2 là MẪU ẢNH SẢN PHẨM ĐÍCH.',
    'Giữ nguyên hình học, nền, ánh sáng, góc chụp, chất liệu và số lượng sản phẩm trong ẢNH 2. Chỉ áp nguyên thiết kế ẢNH 1 lên đúng vùng in tương ứng, căn phối cảnh phù hợp.',
    'Không sáng tác lại artwork: giữ toàn bộ chữ, bố cục, tỉ lệ và màu thiết kế. Không đảo vai trò hai ảnh. Không thêm watermark, logo công cụ hoặc chữ ký.',
    `Quy tắc mẫu ảnh chính: ${snapshot.thumbnail.instructions}`,
  ].join('\n\n');
}
export async function prepareArtwork(buffer: Buffer, spec?: StudioPrintSpec) {
  const stats = await sharp(buffer, { limitInputPixels: 32_000_000 }).stats();
  const meta = await sharp(buffer, { limitInputPixels: 32_000_000 }).metadata();
  const transparent =
    !!meta.hasAlpha && stats.channels[stats.channels.length - 1].min < 255;
  let image = sharp(buffer, { limitInputPixels: 32_000_000 }).rotate();
  if (spec)
    image = image
      .resize(spec.width, spec.height, {
        fit: 'contain',
        background:
          spec.background === 'transparent'
            ? { r: 255, g: 255, b: 255, alpha: 0 }
            : '#fff',
      })
      .withMetadata({ density: spec.dpi });
  if (spec?.background === 'white')
    image = image.flatten({ background: '#fff' });
  const notes = [
    'File artwork phẳng; cần kiểm tra chữ, motif và watermark trước sử dụng.',
  ];
  if (!spec)
    notes.push(
      'Sản phẩm chưa có quy chuẩn pixel/DPI; chưa xác nhận sẵn sàng in.',
    );
  if (spec?.background === 'transparent' && !transparent)
    notes.push(
      'AI trả nền đặc; chưa đạt yêu cầu nền trong suốt. Cần sửa file trước khi duyệt.',
    );
  return {
    buffer: await image.png().toBuffer(),
    checks: {
      technical: !!spec && (spec.background !== 'transparent' || transparent),
      visual: 'not_checked' as const,
      notes,
    },
  };
}
