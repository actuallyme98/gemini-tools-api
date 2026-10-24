import { Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { AgentStore } from './agent.store';
import { ApiError } from '../common/api-error';
import type { Entity } from './agent.types';

export function publicAddress(address: string) {
  if (isIP(address) === 6)
    return /^[23][a-f0-9]{3}:/i.test(address) && !/^200[12]:/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0)
  );
}
export function publicUrl(input: string) {
  const url = new URL(input);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    isIP(url.hostname) ||
    !url.hostname.includes('.')
  )
    throw new ApiError(
      400,
      'RESEARCH_URL_INVALID',
      'Chỉ hỗ trợ trang HTTPS công khai, không dùng địa chỉ nội bộ hoặc thông tin đăng nhập trong URL.',
    );
  return url;
}
export function decodeEntities(value: string) {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|#39|#\d{1,7}|#x[a-f0-9]{1,6});/gi,
    (text) => {
      const named: Record<string, string> = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
        '&#39;': "'",
      };
      if (named[text]) return named[text];
      const n = text.toLowerCase().startsWith('&#x')
        ? parseInt(text.slice(3, -1), 16)
        : Number(text.slice(2, -1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    },
  );
}
export function pageText(html: string) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
}
export function rssSources(xml: string) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .slice(0, 5)
    .flatMap((match) => {
      const read = (tag: string) =>
        decodeEntities(
          new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(match[1])?.[1] ??
            '',
        );
      const url = read('link');
      try {
        publicUrl(url);
      } catch {
        return [];
      }
      return [
        {
          title: pageText(read('title')).slice(0, 200),
          url,
          snippet: pageText(read('description')).slice(0, 1500),
        },
      ];
    });
}
export async function readPublicPage(
  input: string,
  redirects = 0,
): Promise<string> {
  const url = publicUrl(input);
  // Use public IPv4 addresses; do not allow IPv6 transition mechanisms to reach private IPv4.
  const records = await lookup(url.hostname, { all: true, family: 4 });
  if (!records.length || records.some((r) => !publicAddress(r.address)))
    throw new ApiError(
      400,
      'RESEARCH_URL_PRIVATE',
      'Nguồn trỏ tới mạng nội bộ hoặc địa chỉ bị chặn.',
    );
  // Pin the checked DNS address for this connection, including redirect targets.
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: records[0].address,
        family: records[0].family,
        servername: url.hostname,
        method: 'GET',
        path: url.pathname + url.search,
        headers: {
          Host: url.hostname,
          'User-Agent': 'LCGMediaResearch/1.0',
          Accept: 'text/html,application/rss+xml,application/xml,text/plain',
        },
        timeout: 8000,
        signal: AbortSignal.timeout(8000),
      },
      (res) => {
        if (
          [301, 302, 303, 307, 308].includes(res.statusCode ?? 0) &&
          res.headers.location &&
          redirects < 2
        ) {
          res.resume();
          void readPublicPage(
            new URL(res.headers.location, url).toString(),
            redirects + 1,
          ).then(resolve, reject);
          return;
        }
        if (
          res.statusCode !== 200 ||
          !/text\/|application\/(rss\+xml|xml)/i.test(
            res.headers['content-type'] ?? '',
          )
        ) {
          res.resume();
          reject(new Error('Source unavailable'));
          return;
        }
        const parts: Buffer[] = [];
        let bytes = 0;
        res.on('data', (part: Buffer) => {
          bytes += part.length;
          if (bytes > 1_000_000) req.destroy(new Error('Source too large'));
          else parts.push(part);
        });
        res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Source timeout')));
    req.on('error', reject);
    req.end();
  });
}
export interface Research extends Entity {
  keyword: string;
  sources: {
    title: string;
    url: string;
    snippet: string;
    content: string;
    retrievedAt: string;
    status: 'read' | 'snippet_only';
  }[];
  metricsAvailable: false;
}
@Injectable()
export class ResearchService {
  private readonly active = new Set<string>();
  constructor(private readonly store: AgentStore) {}
  async create(owner: string, keyword: string, urls: string[]) {
    if (this.active.has(owner) || this.active.size >= 3)
      throw new ApiError(
        429,
        'RESEARCH_BUSY',
        'Đang thu thập nghiên cứu. Chờ yêu cầu trước hoàn tất rồi gửi thêm.',
      );
    this.active.add(owner);
    try {
      return await this.collect(owner, keyword, urls);
    } finally {
      this.active.delete(owner);
    }
  }
  private async collect(owner: string, keyword: string, urls: string[]) {
    for (const url of urls) publicUrl(url);
    let sources: { title: string; url: string; snippet: string }[];
    if (urls.length)
      sources = urls.map((url) => ({
        title: new URL(url).hostname,
        url,
        snippet: '',
      }));
    else {
      const search = new URL('https://www.bing.com/search');
      search.searchParams.set('format', 'rss');
      search.searchParams.set('q', keyword);
      try {
        sources = rssSources(await readPublicPage(search.toString()));
      } catch {
        throw new ApiError(
          503,
          'RESEARCH_SEARCH_UNAVAILABLE',
          'Chưa lấy được kết quả tìm kiếm. Bạn có thể cung cấp tối đa 5 link HTTPS để đọc trực tiếp.',
        );
      }
    }
    if (!sources.length)
      throw new ApiError(
        422,
        'RESEARCH_NO_SOURCES',
        'Không tìm được nguồn phù hợp. Hãy nhập link nguồn cụ thể.',
      );
    const results: Research['sources'] = [];
    for (const source of sources.slice(0, 5)) {
      let content = '';
      try {
        content = pageText(await readPublicPage(source.url));
      } catch {
        /* Keep provenance, never invent unread content. */
      }
      results.push({
        ...source,
        content,
        status: content ? 'read' : 'snippet_only',
        retrievedAt: new Date().toISOString(),
      });
    }
    return this.store.insert(
      'research',
      this.store.create<Research>(owner, {
        keyword,
        sources: results,
        metricsAvailable: false,
      }),
    );
  }
}
