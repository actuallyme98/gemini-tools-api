import JSZip from 'jszip';
import type { Readable } from 'node:stream';
import { ApiError } from '../common/api-error';
import { studioHash } from './studio.util';
import { skillReferences } from './skill-references';

const invalid = (message: string) =>
  new ApiError(400, 'STUDIO_SKILL_INVALID', message);
export async function readSkillBundle(buffer: Buffer) {
  if (buffer.length > 50 * 1024 * 1024) throw invalid('ZIP tối đa 50 MB.');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw invalid('Không đọc được ZIP. Không hỗ trợ ZIP mã hóa.');
  }
  const entries = Object.values(zip.files).filter((file) => !file.dir);
  if (entries.length > 150) throw invalid('Bộ hướng dẫn tối đa 150 file.');
  const documents: { path: string; content: string }[] = [];
  const files: { path: string; sha256: string; bytes: number }[] = [];
  const images: { path: string; buffer: Buffer }[] = [];
  const issues: string[] = [];
  let total = 0;
  for (const entry of entries) {
    const name =
      (entry as JSZip.JSZipObject & { unsafeOriginalName?: string })
        .unsafeOriginalName ?? entry.name;
    if (
      name !== entry.name ||
      /(^\/|\\|:|(?:^|\/)\.\.(?:\/|$))/.test(name) ||
      [...name].some((character) => character.charCodeAt(0) < 32)
    )
      throw invalid('ZIP chứa đường dẫn không an toàn.');
    if (
      entry.unixPermissions &&
      (Number(entry.unixPermissions) & 0o170000) === 0o120000
    )
      throw invalid('Không hỗ trợ liên kết trong ZIP.');
    // Read as a bounded stream: metadata alone cannot protect against a compressed ZIP bomb.
    const data = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const stream = entry.nodeStream('nodebuffer') as Readable;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        total += chunk.length;
        if (size > 16 * 1024 * 1024 || total > 100 * 1024 * 1024) {
          stream.destroy(
            invalid('File giải nén tối đa 16 MB, cả bộ tối đa 100 MB.'),
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
    files.push({ path: name, sha256: studioHash(data), bytes: data.length });
    if (/\.(?:md|txt)$/i.test(name)) {
      if (data.length > 150000)
        throw invalid('Một tài liệu hướng dẫn tối đa 150 KB.');
      documents.push({ path: name, content: data.toString('utf8') });
    } else if (/\.(?:png|jpe?g|webp)$/i.test(name)) {
      images.push({ path: name, buffer: data });
    } else if (!/\.(?:json|ya?ml)$/i.test(name))
      issues.push(`Không hỗ trợ file ${name}.`);
  }
  const skills = documents.filter((doc) => /(?:^|\/)SKILL\.md$/.test(doc.path));
  if (skills.length !== 1) throw invalid('ZIP phải có đúng một file SKILL.md.');
  const instructions = skills[0].content;
  const compatibility = skillReferences(skills[0].path, documents, files);
  issues.push(...compatibility.issues);
  if (documents.reduce((size, doc) => size + doc.content.length, 0) > 180000)
    throw invalid('Tổng nội dung văn bản vượt giới hạn 180 KB.');
  if (
    /\b(?:run|execute)\s+(?:python|bash|powershell|node)\b|\bscripts\/[\w.-]+\.(?:py|sh|js)\b/i.test(
      documents.map((document) => document.content).join('\n'),
    )
  )
    issues.push('Skill yêu cầu chạy script; Studio không thực thi mã từ ZIP.');
  return {
    instructions,
    documents: documents.filter((doc) => doc !== skills[0]),
    files,
    images,
    issues: [...new Set(issues)],
    warnings: compatibility.warnings,
    activeDocumentPaths: compatibility.activeDocumentPaths,
    declaredVersion: /^version:\s*["']?([^\r\n"']{1,100})/m
      .exec(instructions)?.[1]
      ?.trim(),
    bundleHash: studioHash(buffer),
  };
}
