import path from 'node:path';

export function skillReferences(
  skillPath: string,
  documents: { path: string; content: string }[],
  files: { path: string }[],
) {
  const paths = new Set(files.map((file) => file.path));
  const root = path.posix.dirname(skillPath);
  const issues = new Set<string>();
  const warnings = new Set<string>();
  const active = new Set<string>();
  const visited = new Set<string>();
  function visit(name: string) {
    if (visited.has(name)) return;
    visited.add(name);
    const doc = documents.find((document) => document.path === name);
    if (!doc) return;
    if (/ARCHIVE|(?:^|\/)archive\//i.test(name)) {
      warnings.add(`Tài liệu lịch sử không áp dụng mặc định: ${name}`);
      return;
    }
    active.add(name);
    for (const match of doc.content.matchAll(/https?:\/\/[^\s<>"`)]+/g))
      warnings.add(`Link ngoài không tự đồng bộ: ${match[0].slice(0, 300)}`);
    const references = [
      ...[
        ...doc.content.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g),
      ].map((match) => match[1]),
      ...[
        ...doc.content.matchAll(
          /`([^`\n]+\.(?:md|txt|json|ya?ml|png|jpe?g|webp|py|sh|js))`/gi,
        ),
      ].map((match) => match[1]),
      ...[
        ...doc.content.matchAll(
          /(?:^|[\s(])((?:references|assets|cases|examples|scripts)\/[\w./-]+\.(?:md|txt|json|ya?ml|png|jpe?g|webp|py|sh|js))/g,
        ),
      ].map((match) => match[1]),
    ];
    for (let reference of references) {
      if (/^(?:https?:|mailto:|#)/i.test(reference)) continue;
      try {
        reference = decodeURIComponent(reference.split('#')[0]);
      } catch {
        issues.add(`Tham chiếu không hợp lệ: ${reference}`);
        continue;
      }
      if (!reference || /\*|\{|\}/.test(reference)) continue;
      const relative = path.posix.normalize(
        path.posix.join(path.posix.dirname(name), reference),
      );
      const fromRoot = path.posix.normalize(path.posix.join(root, reference));
      const target = paths.has(relative)
        ? relative
        : paths.has(fromRoot)
          ? fromRoot
          : undefined;
      if (!target)
        issues.add(`Thiếu file được tham chiếu từ ${name}: ${reference}`);
      else {
        if (/\.(?:json|ya?ml)$/i.test(target))
          warnings.add(
            `Cấu hình chỉ được lưu tham chiếu, không tự thực thi: ${target}`,
          );
        visit(target);
      }
    }
  }
  visit(skillPath);
  return {
    issues: [...issues],
    warnings: [...warnings],
    activeDocumentPaths: [...active],
  };
}
