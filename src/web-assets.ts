import crypto from "node:crypto";
import dns from "node:dns";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";

import type { AppConfig } from "./config.js";
import type { InboundAttachment } from "./messages.js";

const MAX_IMAGES = 48;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ARTICLE_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_SIDE = 16_384;
const MAX_IMAGE_PIXELS = 80_000_000;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 20_000;
const DNS_FALLBACK_TIMEOUT_MS = 8_000;
const MAX_DNS_RESPONSE_BYTES = 64 * 1024;

const DNS_OVER_HTTPS_PROVIDERS = [
  { hostname: "dns.alidns.com", address: "223.5.5.5" },
  { hostname: "cloudflare-dns.com", address: "1.1.1.1" },
] as const;

type StoredImage = {
  attachment: InboundAttachment;
  sha256: string;
};

export type LocalizedMarkdownBundle = {
  markdown: string;
  images: InboundAttachment[];
  warnings: string[];
};

const blockedAddresses = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv6");

export function isPublicImageAddress(address: string): boolean {
  const family = net.isIP(address);
  if (!family) return false;
  return !blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

function isSyntheticProxyAddress(address: string): boolean {
  return net.isIPv4(address) && address.startsWith("198.") && blockedAddresses.check(address, "ipv4");
}

export function validateRemoteImageUrl(value: string): URL {
  if (value.length > 4_000) throw new Error("图片地址过长");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("图片地址协议不受支持");
  if (url.username || url.password) throw new Error("图片地址不能包含凭据");
  if (url.port && !((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443"))) {
    throw new Error("图片地址端口不受支持");
  }
  if (!url.hostname || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw new Error("图片地址不可访问");
  }
  return url;
}

export function sniffImageType(content: Buffer): { mimeType: string; extension: string } | undefined {
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (content.length >= 6 && ["GIF87a", "GIF89a"].includes(content.subarray(0, 6).toString("ascii"))) {
    return { mimeType: "image/gif", extension: "gif" };
  }
  if (content.length >= 12 && content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  if (content.length >= 16 && content.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = content.subarray(8, 16).toString("ascii");
    if (brand.includes("avif") || brand.includes("avis")) return { mimeType: "image/avif", extension: "avif" };
  }
  return undefined;
}

function readUInt24LE(content: Buffer, offset: number): number {
  return content[offset]! | (content[offset + 1]! << 8) | (content[offset + 2]! << 16);
}

export function imageDimensions(
  content: Buffer,
  mimeType: string,
): { width: number; height: number } | undefined {
  if (mimeType === "image/png" && content.length >= 24) {
    return { width: content.readUInt32BE(16), height: content.readUInt32BE(20) };
  }
  if (mimeType === "image/gif" && content.length >= 10) {
    return { width: content.readUInt16LE(6), height: content.readUInt16LE(8) };
  }
  if (mimeType === "image/jpeg") {
    let offset = 2;
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 9 < content.length) {
      if (content[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < content.length && content[offset] === 0xff) offset += 1;
      const marker = content[offset++];
      if (marker == null || marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 2 > content.length) break;
      const length = content.readUInt16BE(offset);
      if (length < 2 || offset + length > content.length) break;
      if (startOfFrame.has(marker) && length >= 7) {
        return { width: content.readUInt16BE(offset + 5), height: content.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  if (mimeType === "image/webp" && content.length >= 30) {
    const chunk = content.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X") return { width: readUInt24LE(content, 24) + 1, height: readUInt24LE(content, 27) + 1 };
    if (chunk === "VP8 " && content.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      return { width: content.readUInt16LE(26) & 0x3fff, height: content.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L" && content.length >= 25 && content[20] === 0x2f) {
      return {
        width: 1 + (((content[22]! & 0x3f) << 8) | content[21]!),
        height: 1 + (((content[24]! & 0x0f) << 10) | (content[23]! << 2) | ((content[22]! & 0xc0) >> 6)),
      };
    }
  }
  if (mimeType === "image/avif") {
    const marker = Buffer.from("ispe");
    const offset = content.indexOf(marker);
    if (offset >= 0 && offset + 16 <= content.length) {
      return { width: content.readUInt32BE(offset + 8), height: content.readUInt32BE(offset + 12) };
    }
  }
  return undefined;
}

export function assertSafeImageDimensions(content: Buffer, mimeType: string): void {
  const dimensions = imageDimensions(content, mimeType);
  if (!dimensions || !dimensions.width || !dimensions.height) throw new Error("无法验证图片尺寸");
  if (
    dimensions.width > MAX_IMAGE_SIDE
    || dimensions.height > MAX_IMAGE_SIDE
    || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
  ) throw new Error("图片像素尺寸超过安全限制");
}

export type ResolvedAddress = { address: string; family: 4 | 6 };

export function pinnedImageLookup(addresses: ResolvedAddress[]): net.LookupFunction {
  return ((_hostname, options, callback) => {
    const ordered = addresses.map((entry) => ({ address: entry.address, family: entry.family }));
    if (typeof options === "object" && options.all) {
      (callback as unknown as (error: NodeJS.ErrnoException | null, values: ResolvedAddress[]) => void)(null, ordered);
      return;
    }
    const first = ordered[0]!;
    (callback as unknown as (
      error: NodeJS.ErrnoException | null,
      address: string,
      family: number,
    ) => void)(null, first.address, first.family);
  }) as net.LookupFunction;
}

async function requestDnsJson(provider: typeof DNS_OVER_HTTPS_PROVIDERS[number], hostname: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value || Buffer.alloc(0));
    };
    const request = https.request({
      protocol: "https:",
      hostname: provider.hostname,
      servername: provider.hostname,
      path: `/resolve?name=${encodeURIComponent(hostname)}&type=A`,
      method: "GET",
      headers: {
        Accept: "application/dns-json",
        "User-Agent": "KnowledgeRelay/1.0 image-resolver",
      },
      lookup: pinnedImageLookup([{ address: provider.address, family: 4 }]),
      timeout: DNS_FALLBACK_TIMEOUT_MS,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(new Error("安全 DNS 查询失败"));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_DNS_RESPONSE_BYTES) {
          response.destroy(new Error("安全 DNS 响应过大"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(undefined, Buffer.concat(chunks, received)));
      response.on("error", (error) => finish(error));
    });
    request.on("timeout", () => request.destroy(new Error("安全 DNS 查询超时")));
    request.on("error", (error) => finish(error));
    request.end();
  });
}

async function resolveViaDnsOverHttps(hostname: string): Promise<ResolvedAddress[]> {
  for (const provider of DNS_OVER_HTTPS_PROVIDERS) {
    try {
      const payload = JSON.parse((await requestDnsJson(provider, hostname)).toString("utf8")) as {
        Status?: number;
        Answer?: Array<{ type?: number; data?: string }>;
      };
      if (payload.Status !== 0) continue;
      const addresses = [...new Set(
        (payload.Answer || [])
          .filter((answer) => answer.type === 1 && typeof answer.data === "string")
          .map((answer) => answer.data!),
      )].map((address) => ({ address, family: 4 as const }));
      if (!addresses.length || addresses.some((entry) => !isPublicImageAddress(entry.address))) continue;
      return addresses;
    } catch {
      // Try the next pinned resolver. This path is only used when the host
      // resolver is unavailable or deliberately returns a proxy Fake-IP.
    }
  }
  throw new Error("图片域名无法完成安全解析");
}

async function resolvePublicAddresses(hostname: string): Promise<ResolvedAddress[]> {
  if (net.isIP(hostname)) {
    if (!isPublicImageAddress(hostname)) throw new Error("图片地址指向受保护网络");
    return [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }];
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true }) as ResolvedAddress[];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code || "")) throw error;
    return await resolveViaDnsOverHttps(hostname);
  }
  if (!addresses.length || addresses.every((entry) => isSyntheticProxyAddress(entry.address))) {
    return await resolveViaDnsOverHttps(hostname);
  }
  if (addresses.some((entry) => !isPublicImageAddress(entry.address))) {
    throw new Error("图片地址指向受保护网络");
  }
  // Prefer IPv4 when both families are available. Some NAS and home networks
  // advertise IPv6 DNS records without providing working IPv6 egress.
  addresses.sort((left, right) => left.family - right.family);
  return addresses;
}

function safeImageReferrer(sourceUrl: string | undefined, target: URL): string | undefined {
  if (!sourceUrl) return undefined;
  try {
    const source = new URL(sourceUrl);
    if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) return undefined;
    source.hash = "";
    // Match the browser's common strict-origin-when-cross-origin behaviour:
    // same-site image hosts receive the article URL, third-party CDNs only the
    // origin. This helps anti-hotlinking without leaking article query strings.
    return source.origin === target.origin ? source.toString().slice(0, 2_000) : `${source.origin}/`;
  } catch {
    return undefined;
  }
}

async function requestImage(url: URL, sourceUrl?: string, redirects = 0): Promise<Buffer> {
  const resolved = await resolvePublicAddresses(url.hostname);
  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value || Buffer.alloc(0));
    };
    const transport = url.protocol === "https:" ? https : http;
    const referer = safeImageReferrer(sourceUrl, url);
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
        "Accept-Encoding": "identity",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        ...(referer ? { Referer: referer } : {}),
      },
      lookup: pinnedImageLookup(resolved),
      servername: url.protocol === "https:" ? url.hostname : undefined,
      timeout: REQUEST_TIMEOUT_MS,
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        if (!response.headers.location || redirects >= MAX_REDIRECTS) {
          finish(new Error("图片重定向无效"));
          return;
        }
        let redirect: URL;
        try {
          redirect = validateRemoteImageUrl(new URL(response.headers.location, url).toString());
        } catch (error) {
          finish(error instanceof Error ? error : new Error("图片重定向无效"));
          return;
        }
        void requestImage(redirect, sourceUrl, redirects + 1).then((value) => finish(undefined, value), (error) => finish(error));
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        finish(new Error(`图片下载失败（HTTP ${status}）`));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] || 0);
      if (declaredLength > MAX_IMAGE_BYTES) {
        response.destroy();
        finish(new Error("图片超过 8 MB 限制"));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_IMAGE_BYTES) {
          response.destroy(new Error("图片超过 8 MB 限制"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(undefined, Buffer.concat(chunks, received)));
      response.on("error", (error) => finish(error));
    });
    request.on("timeout", () => request.destroy(new Error("图片下载超时")));
    request.on("error", (error) => finish(error));
    request.end();
  });
}

export type PublicHtmlResponse = {
  html: string;
  url: string;
  contentType: string;
};

/**
 * Fetch public HTML through the same DNS-pinned, private-network-blocking path
 * used by article images. Keeping page extraction server-side must not turn a
 * user supplied bookmark URL into an SSRF primitive.
 */
export async function requestPublicHtml(
  value: string,
  redirects = 0,
  contentKind: "html" | "feed" = "html",
): Promise<PublicHtmlResponse> {
  const url = validateRemoteImageUrl(value);
  const resolved = await resolvePublicAddresses(url.hostname);
  return await new Promise<PublicHtmlResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: PublicHtmlResponse) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("网页响应为空"));
    };
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        Accept: contentKind === "feed"
          ? "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,text/html;q=0.4,*/*;q=0.1"
          : "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "Accept-Encoding": "identity",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      lookup: pinnedImageLookup(resolved),
      servername: url.protocol === "https:" ? url.hostname : undefined,
      timeout: REQUEST_TIMEOUT_MS,
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        if (!response.headers.location || redirects >= MAX_REDIRECTS) {
          finish(new Error("网页重定向无效"));
          return;
        }
        let redirect: URL;
        try {
          redirect = validateRemoteImageUrl(new URL(response.headers.location, url).toString());
        } catch (error) {
          finish(error instanceof Error ? error : new Error("网页重定向无效"));
          return;
        }
        void requestPublicHtml(redirect.toString(), redirects + 1, contentKind).then(
          (result) => finish(undefined, result),
          (error) => finish(error),
        );
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        finish(new Error(`网页下载失败（HTTP ${status}）`));
        return;
      }
      const contentType = String(response.headers["content-type"] || "").toLowerCase();
      const validContent = contentKind === "feed"
        ? /text\/html|text\/xml|application\/(?:rss\+xml|atom\+xml|xml|xhtml\+xml)/.test(contentType)
        : /text\/html|application\/xhtml\+xml/.test(contentType);
      if (contentType && !validContent) {
        response.resume();
        finish(new Error(contentKind === "feed" ? "远程内容不是 RSS 或 Atom 订阅" : "远程内容不是 HTML 网页"));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] || 0);
      if (declaredLength > MAX_HTML_BYTES) {
        response.destroy();
        finish(new Error("网页超过 8 MB 限制"));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_HTML_BYTES) {
          response.destroy(new Error("网页超过 8 MB 限制"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(undefined, {
        html: Buffer.concat(chunks, received).toString("utf8"),
        url: url.toString(),
        contentType,
      }));
      response.on("error", (error) => finish(error));
    });
    request.on("timeout", () => request.destroy(new Error("网页下载超时")));
    request.on("error", (error) => finish(error));
    request.end();
  });
}

function tenantDirectory(tenantId?: string): string {
  return tenantId ? crypto.createHash("sha256").update(tenantId).digest("hex").slice(0, 16) : "legacy";
}

function safeImageLabel(value: string, index: number): string {
  const label = value.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return label || `文章图片 ${index + 1}`;
}

async function persistImage(
  config: AppConfig,
  tenantId: string | undefined,
  url: string,
  alt: string,
  index: number,
  download: (url: URL) => Promise<Buffer>,
): Promise<StoredImage> {
  const content = await download(validateRemoteImageUrl(url));
  const imageType = sniffImageType(content);
  if (!imageType) throw new Error("远程内容不是受支持的图片");
  assertSafeImageDimensions(content, imageType.mimeType);
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  const folder = path.join(config.dataDir, "derived", "tenants", tenantDirectory(tenantId), "assets");
  const filePath = path.join(folder, `${sha256}.${imageType.extension}`);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(filePath, content, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return {
    sha256,
    attachment: {
      kind: "derived",
      fileName: `${safeImageLabel(alt, index)}-${sha256.slice(0, 8)}.${imageType.extension}`,
      path: filePath,
      size: content.length,
      mimeType: imageType.mimeType,
    },
  };
}

type ImageReference = { full: string; alt: string; url: string };

function safeFailureReason(error: Error): string {
  const message = error.message;
  if (/ENOTFOUND|EAI_AGAIN|DNS|域名|解析/i.test(message)) return "域名解析失败";
  if (/timeout|timed out|超时/i.test(message)) return "下载超时";
  if (/HTTP \d{3}/i.test(message)) return message.match(/HTTP \d{3}/i)?.[0] || "远程服务拒绝访问";
  if (/尺寸|像素/i.test(message)) return "图片尺寸不受支持";
  if (/8 MB|64 MB|过大|总量/i.test(message)) return "图片超过大小限制";
  if (/不是受支持的图片|无法验证图片/i.test(message)) return "图片格式不受支持";
  return "网络连接失败";
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\s${escaped}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] || match?.[2] || match?.[3] || undefined;
}

function resolveImageReference(value: string, sourceUrl?: string): string | undefined {
  const decoded = value.trim().replace(/^<|>$/g, "").replace(/&amp;/gi, "&");
  if (!decoded || /^(?:data|blob|javascript):/i.test(decoded)) return undefined;
  try {
    const url = sourceUrl ? new URL(decoded, sourceUrl) : new URL(decoded);
    return validateRemoteImageUrl(url.toString()).toString();
  } catch {
    return undefined;
  }
}

/**
 * Convert the image shapes commonly returned by reader services and raw HTML
 * fallbacks into one absolute Markdown representation. Besides ordinary
 * Markdown this covers relative URLs, protocol-relative URLs and lazy-loading
 * attributes used by forums such as Kanxue.
 */
export function normalizeMarkdownImages(markdown: string, sourceUrl?: string): string {
  const markdownPattern = /!\[([^\]\r\n]{0,500})\]\(\s*(?:<([^>\r\n]{1,4000})>|([^\s)\r\n]{1,4000}))(?:\s+["'][^"'\r\n]*["'])?\s*\)/gi;
  const normalizedMarkdown = markdown.replace(markdownPattern, (full, alt: string, wrappedUrl: string, plainUrl: string) => {
    const resolved = resolveImageReference(wrappedUrl || plainUrl || "", sourceUrl);
    return resolved ? `![${alt}](${resolved})` : full;
  });
  return normalizedMarkdown.replace(/<img\b[^>]*>/gi, (tag) => {
    const lazySource = ["data-src", "data-original", "data-lazy-src", "data-url"]
      .map((name) => htmlAttribute(tag, name))
      .find(Boolean);
    const srcset = htmlAttribute(tag, "srcset")?.split(",")[0]?.trim().split(/\s+/)[0];
    const resolved = resolveImageReference(lazySource || htmlAttribute(tag, "src") || srcset || "", sourceUrl);
    if (!resolved) return tag;
    const alt = (htmlAttribute(tag, "alt") || "正文图片").replace(/[\[\]\r\n]+/g, " ").trim();
    return `![${alt}](${resolved})`;
  });
}

function imageReferences(markdown: string): ImageReference[] {
  const matches: ImageReference[] = [];
  const pattern = /!\[([^\]\r\n]{0,500})\]\(\s*(https?:\/\/[^)\s]{1,4000})(?:\s+["'][^"']*["'])?\s*\)/gi;
  for (const match of markdown.matchAll(pattern)) {
    if (match[0] && match[2]) matches.push({ full: match[0], alt: match[1] || "", url: match[2] });
  }
  return matches;
}

function isImageWrappedByMarkdownLink(markdown: string, offset: number, imageLength: number): boolean {
  if (offset <= 0 || markdown[offset - 1] !== "[") return false;
  const remainder = markdown.slice(offset + imageLength);
  return /^[^\]\r\n]{0,500}\]\(\s*(?:<[^>\r\n]{1,4000}>|[^\s)\r\n]{1,4000})(?:\s+["'][^"'\r\n]*["'])?\s*\)/.test(remainder);
}

export async function localizeMarkdownImages(
  config: AppConfig,
  markdown: string,
  tenantId?: string,
  download?: (url: URL) => Promise<Buffer>,
  sourceUrl?: string,
): Promise<LocalizedMarkdownBundle> {
  const normalizedMarkdown = normalizeMarkdownImages(markdown, sourceUrl);
  const references = imageReferences(normalizedMarkdown);
  if (!references.length) return { markdown: normalizedMarkdown, images: [], warnings: [] };
  const imageDownloader = download || ((url: URL) => requestImage(url, sourceUrl));
  const warnings: string[] = [];
  if (references.length > MAX_IMAGES) warnings.push(`文章包含 ${references.length} 张图片，仅缓存前 ${MAX_IMAGES} 张。`);
  const selected = references.slice(0, MAX_IMAGES);
  const unique = [...new Map(selected.map((reference) => [reference.url, reference])).values()];
  const results = new Map<string, StoredImage | Error>();
  let totalBytes = 0;
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const index = next++;
      const reference = unique[index]!;
      try {
        const stored = await persistImage(config, tenantId, reference.url, reference.alt, index, imageDownloader);
        if (totalBytes + stored.attachment.size > MAX_ARTICLE_IMAGE_BYTES) {
          throw new Error("文章图片总量超过 64 MB 限制");
        }
        totalBytes += stored.attachment.size;
        results.set(reference.url, stored);
      } catch (error) {
        results.set(reference.url, error instanceof Error ? error : new Error("图片保存失败"));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, unique.length) }, worker));
  // Promise workers finish in network order, not document order. Preserve the
  // Markdown order so an explicitly prepended article cover remains the first
  // derived image even when a later body image downloads faster.
  const images = unique.flatMap((reference) => {
    const value = results.get(reference.url);
    return value && !(value instanceof Error) ? [value.attachment] : [];
  });
  const failed = [...results.values()].filter((value) => value instanceof Error).length;
  if (failed) {
    const reasons = [...new Set(
      [...results.values()]
        .filter((value): value is Error => value instanceof Error)
        .map(safeFailureReason),
    )].slice(0, 2);
    warnings.push(`${failed} 张文章图片未能缓存（${reasons.join("、")}），正文已保留并提供原始图片链接。`);
  }
  const localizedLinks = normalizedMarkdown.replace(
    /\[!\[([^\]\r\n]{0,500})\]\(\s*(https?:\/\/[^)\s]{1,4000})(?:\s+["'][^"']*["'])?\s*\)([^\]\r\n]{0,500})\]\(\s*(https?:\/\/[^)\s]{1,4000})(?:\s+["'][^"']*["'])?\s*\)/gi,
    (_full, alt: string, url: string, caption: string, destinationUrl: string) => {
      const stored = results.get(url);
      const label = caption.replace(/\s+/g, " ").trim() || alt.trim() || "相关资料";
      if (stored && !(stored instanceof Error)) {
        return `[![${alt}](attachment://${stored.sha256}) ${label}](${destinationUrl})`;
      }
      // A logo is decorative when its linked label is still available. Keep
      // the destination and label instead of showing a broken-image sentence.
      if (caption.trim() || /(?:logo|icon|图标|徽标)/i.test(alt)) return `[${label}](${destinationUrl})`;
      return `[图片未保存：${label}](${destinationUrl})`;
    },
  );
  const localized = localizedLinks.replace(
    /!\[([^\]\r\n]{0,500})\]\(\s*(https?:\/\/[^)\s]{1,4000})(?:\s+["'][^"']*["'])?\s*\)/gi,
    (full, alt: string, url: string, offset: number, source: string) => {
      const stored = results.get(url);
      if (stored && !(stored instanceof Error)) return `![${alt}](attachment://${stored.sha256})`;
      // Do not create a link inside another Markdown link. Besides being
      // invalid CommonMark, the nested shape used to leak its raw syntax into
      // the article reader. The surrounding link still preserves the useful
      // destination; decorative logos can disappear while meaningful images
      // keep a compact textual fallback.
      if (isImageWrappedByMarkdownLink(source, offset, full.length)) {
        if (/(?:logo|icon|图标|徽标)/i.test(alt)) return "";
        return `图片未保存：${alt || "查看原图"}`;
      }
      return `[图片未保存：${alt || "查看原图"}](${url})`;
    },
  );
  return { markdown: localized, images, warnings };
}
