import crypto from "node:crypto";
import { promises as dns } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";

import { Readability } from "@mozilla/readability";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import ipaddr from "ipaddr.js";
import { DOMParser } from "linkedom";
import TurndownService from "turndown";

import type { AppConfig } from "./config.js";
import type { InboundAttachment } from "./messages.js";

export type ExtractedWebContent = {
  url: string;
  title: string;
  author?: string;
  publishedAt?: string;
  markdown: string;
  sourceType: "wechat" | "web";
};

const URL_PATTERN = /https?:\/\/[^\s<>"'，。！？；：）】]+/giu;
const MAX_REDIRECTS = 3;
const ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

function cleanText(value: string | null | undefined): string {
  return (value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function safeYaml(value: string): string {
  return JSON.stringify(value.replace(/[\u0000-\u001f]/g, " "));
}

function isPublicIp(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    }
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

export async function resolvePublicUrl(value: string): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("只允许抓取 HTTP/HTTPS 网页");
  if (url.username || url.password) throw new Error("网页地址不能包含用户名或密码");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("网页地址只允许标准 HTTP/HTTPS 端口");
  if (!url.hostname || url.hostname.length > 253) throw new Error("网页域名无效");
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => !isPublicIp(item.address))) {
    throw new Error("网页地址解析到了本机、内网或保留地址，已拒绝访问");
  }
  const selected = addresses[0]!;
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

type FetchedPage = { finalUrl: URL; contentType: string; body: string };

async function requestOnce(
  resolved: Awaited<ReturnType<typeof resolvePublicUrl>>,
  timeoutMs: number,
  maximumBytes: number,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const transport = resolved.url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(
      resolved.url,
      {
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.8",
          "Accept-Encoding": "identity",
          "User-Agent": "KnowledgeRelay/1.1 (+safe-reader)",
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, resolved.address, resolved.family);
        },
        servername: resolved.url.hostname,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const declared = Number(response.headers["content-length"] || 0);
        const encoding = String(response.headers["content-encoding"] || "identity").toLowerCase();
        if (declared > maximumBytes || !["", "identity"].includes(encoding)) {
          request.destroy(new Error(declared > maximumBytes ? "网页内容超过允许大小" : "网页返回了不受支持的压缩格式"));
          return;
        }
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maximumBytes) {
            request.destroy(new Error("网页内容超过允许大小"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("网页抓取超时")));
    request.on("error", reject);
    request.end();
  });
}

export async function fetchPublicPage(
  value: string,
  options: { timeoutMs?: number; maximumBytes?: number } = {},
): Promise<FetchedPage> {
  const timeoutMs = options.timeoutMs || 15_000;
  const maximumBytes = options.maximumBytes || 5 * 1024 * 1024;
  let current = value;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const resolved = await resolvePublicUrl(current);
    const response = await requestOnce(resolved, timeoutMs, maximumBytes);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location || Array.isArray(location)) throw new Error("网页重定向地址无效");
      if (redirects === MAX_REDIRECTS) throw new Error("网页重定向次数过多");
      current = new URL(location, resolved.url).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`网页返回 HTTP ${response.status}`);
    const contentType = String(response.headers["content-type"] || "text/html").split(";")[0]!.toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) throw new Error(`不支持抓取 ${contentType || "未知类型"}`);
    return { finalUrl: resolved.url, contentType, body: response.body.toString("utf8") };
  }
  throw new Error("网页重定向次数过多");
}

function normalizeLinks(root: cheerio.Cheerio<AnyNode>, baseUrl: URL): void {
  root.find("script,style,noscript,iframe,object,embed,form,button,nav,footer").remove();
  root.find("*").each((_index, element) => {
    const node = root.find(element);
    for (const attribute of Object.keys(element.attribs || {})) {
      if (attribute.toLowerCase().startsWith("on") || ["style", "srcset"].includes(attribute.toLowerCase())) {
        node.removeAttr(attribute);
      }
    }
  });
  for (const attribute of ["href", "src"] as const) {
    root.find(`[${attribute}]`).each((_index, element) => {
      const node = root.find(element);
      const raw = node.attr(attribute)?.trim();
      if (!raw) return;
      try {
        const absolute = new URL(raw, baseUrl);
        if (!["http:", "https:"].includes(absolute.protocol)) node.removeAttr(attribute);
        else node.attr(attribute, absolute.toString());
      } catch {
        node.removeAttr(attribute);
      }
    });
  }
}

function toMarkdown(html: string): string {
  const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
  turndown.remove(["script", "style", "noscript", "iframe", "object", "form"]);
  return turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim().slice(0, 150_000);
}

function parseWechat(html: string, sourceUrl: URL): Omit<ExtractedWebContent, "markdown"> & { contentHtml: string } {
  const $ = cheerio.load(html);
  const title = cleanText($("#activity-name").first().text()) || cleanText($("meta[property='og:title']").attr("content")) || "微信公众号文章";
  const author = cleanText($("#js_name").first().text()) || cleanText($("meta[name='author']").attr("content")) || undefined;
  const publishedAt = cleanText($("#publish_time").first().text()) || cleanText($("meta[property='article:published_time']").attr("content")) || undefined;
  const root = $("#js_content").first();
  if (!root.length) throw new Error("未找到微信公众号正文，页面可能需要验证或已经失效");
  normalizeLinks(root, sourceUrl);
  return { url: sourceUrl.toString(), title, author, publishedAt, sourceType: "wechat", contentHtml: root.html() || "" };
}

function parseGeneric(html: string, sourceUrl: URL): Omit<ExtractedWebContent, "markdown"> & { contentHtml: string } {
  const document = new DOMParser().parseFromString(html, "text/html");
  const readable = new Readability(document as unknown as Document, { charThreshold: 80 }).parse();
  const $ = cheerio.load(html);
  const title = cleanText(readable?.title) || cleanText($("meta[property='og:title']").attr("content")) || cleanText($("title").text()) || sourceUrl.hostname;
  const author = cleanText(readable?.byline) || cleanText($("meta[name='author']").attr("content")) || undefined;
  const publishedAt = cleanText($("meta[property='article:published_time']").attr("content")) || cleanText($("time").first().attr("datetime")) || undefined;
  const fallback = $("article").first().length ? $("article").first() : $("main").first().length ? $("main").first() : $("body").first();
  const contentHtml = readable?.content || fallback.html() || "";
  const contentRoot = cheerio.load(`<main>${contentHtml}</main>`)("main");
  normalizeLinks(contentRoot, sourceUrl);
  return { url: sourceUrl.toString(), title, author, publishedAt, sourceType: "web", contentHtml: contentRoot.html() || "" };
}

export async function extractWebContent(value: string): Promise<ExtractedWebContent> {
  const page = await fetchPublicPage(value);
  if (page.contentType === "text/plain") {
    return {
      url: page.finalUrl.toString(),
      title: page.finalUrl.hostname,
      sourceType: "web",
      markdown: page.body.trim().slice(0, 150_000),
    };
  }
  const parsed = page.finalUrl.hostname === "mp.weixin.qq.com"
    ? parseWechat(page.body, page.finalUrl)
    : parseGeneric(page.body, page.finalUrl);
  const body = toMarkdown(parsed.contentHtml);
  if (body.length < 20) throw new Error("网页正文为空或过短");
  const frontmatter = [
    "---",
    `title: ${safeYaml(parsed.title)}`,
    `source: ${safeYaml(parsed.url)}`,
    `source_type: ${parsed.sourceType}`,
    ...(parsed.author ? [`author: ${safeYaml(parsed.author)}`] : []),
    ...(parsed.publishedAt ? [`published_at: ${safeYaml(parsed.publishedAt)}`] : []),
    `fetched_at: ${safeYaml(new Date().toISOString())}`,
    "---",
  ];
  return { ...parsed, markdown: [...frontmatter, "", `# ${parsed.title}`, "", body, ""].join("\n") };
}

export function extractUrls(text: string): string[] {
  return [...new Set(text.match(URL_PATTERN) || [])].slice(0, 3);
}

export async function persistExtractedMarkdown(
  config: AppConfig,
  messageId: string,
  content: ExtractedWebContent,
): Promise<InboundAttachment> {
  const digest = crypto.createHash("sha256").update(`${messageId}\n${content.url}`).digest("hex").slice(0, 20);
  const folder = path.join(config.dataDir, "derived", new Date().toISOString().slice(0, 10));
  await import("node:fs/promises").then((fs) => fs.mkdir(folder, { recursive: true }));
  const safeTitle = content.title.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "网页解析";
  const fileName = `${safeTitle}-${digest.slice(0, 8)}.md`;
  const filePath = path.join(folder, `${digest}.md`);
  await import("node:fs/promises").then((fs) => fs.writeFile(filePath, content.markdown, { encoding: "utf8", mode: 0o600 }));
  return { kind: "derived", fileName, path: filePath, size: Buffer.byteLength(content.markdown), mimeType: "text/markdown" };
}
