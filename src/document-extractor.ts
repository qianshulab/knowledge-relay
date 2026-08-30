import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import AdmZip from "adm-zip";
import { load } from "cheerio";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

import type { CaptureInput } from "./capture.js";
import type { AppConfig } from "./config.js";
import type { InboundAttachment } from "./messages.js";
import { normalizeLooseCodeBlocks } from "./markdown.js";
import { assertSafeImageDimensions, sniffImageType } from "./web-assets.js";
import type { ExtractedWebContent } from "./web-content.js";

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 500;
const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 30 * 1024 * 1024;
const MAX_MARKDOWN_CHARS = 800_000;

type ParseContext = {
  config: AppConfig;
  captureId: string;
  tenantId?: string;
  sourceName: string;
};

type ParsedDocument = {
  title: string;
  markdown: string;
  assets: InboundAttachment[];
  warnings: string[];
};

export type AttachmentExtractionResult = {
  documents: ExtractedWebContent[];
  assets: InboundAttachment[];
  warnings: string[];
};

function cleanTitle(value: string): string {
  return path.posix.basename(value.replace(/\\/g, "/")).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "附件解析";
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlText(value: string): string {
  return [...value.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi)]
    .map((match) => decodeXml(match[1] || ""))
    .join("")
    .replace(/\u00a0/g, " ")
    .trim();
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim();
}

function markdownTable(rows: string[][]): string {
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (!width || !rows.length) return "";
  const normalized = rows.map((row) => Array.from({ length: width }, (_unused, index) => escapeCell(row[index] || "")));
  const header = normalized[0]!;
  const body = normalized.slice(1);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function turndownService(): TurndownService {
  const service = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    headingStyle: "atx",
  });
  service.use(gfm);
  service.remove(["script", "style", "noscript", "iframe", "object", "embed", "form", "button"]);
  return service;
}

function normalizeMarkdown(value: string): string {
  return normalizeLooseCodeBlocks(value)
    .replace(/^#\s*$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_MARKDOWN_CHARS);
}

function normalizeZipName(value: string): string | undefined {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return undefined;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined;
  return parts.join("/");
}

function imageMime(buffer: Buffer): string | undefined {
  const type = sniffImageType(buffer);
  return type?.mimeType;
}

async function persistAsset(context: ParseContext, fileName: string, buffer: Buffer): Promise<{ attachment: InboundAttachment; reference: string } | undefined> {
  const mimeType = imageMime(buffer);
  if (!mimeType) return undefined;
  assertSafeImageDimensions(buffer, mimeType);
  const digest = crypto.createHash("sha256").update(buffer).digest("hex");
  const tenantDirectory = context.tenantId
    ? crypto.createHash("sha256").update(context.tenantId).digest("hex").slice(0, 16)
    : "legacy";
  const folder = path.join(context.config.dataDir, "derived", "tenants", tenantDirectory, new Date().toISOString().slice(0, 10), "assets");
  await fs.mkdir(folder, { recursive: true });
  const extension = mimeType === "image/jpeg" ? ".jpg" : `.${mimeType.split("/")[1]}`;
  const storagePath = path.join(folder, `${digest}${extension}`);
  try {
    await fs.access(storagePath);
  } catch {
    await fs.writeFile(storagePath, buffer, { mode: 0o600 });
  }
  return {
    attachment: {
      kind: "derived",
      fileName: path.basename(fileName).replace(/[\u0000-\u001f]/g, " ").slice(0, 180) || `图片${extension}`,
      path: storagePath,
      size: buffer.length,
      mimeType,
    },
    reference: `attachment://${digest}`,
  };
}

function zipEntries(buffer: Buffer): { zip: AdmZip; entries: Map<string, AdmZip.IZipEntry>; warnings: string[] } {
  const zip = new AdmZip(buffer);
  const all = zip.getEntries();
  if (all.length > MAX_ZIP_ENTRIES) throw new Error(`压缩包文件数量超过 ${MAX_ZIP_ENTRIES} 个`);
  let total = 0;
  const entries = new Map<string, AdmZip.IZipEntry>();
  const warnings: string[] = [];
  for (const entry of all) {
    if (entry.isDirectory) continue;
    const name = normalizeZipName(entry.entryName);
    if (!name) throw new Error("压缩包包含不安全的文件路径");
    const size = Number(entry.header.size) || 0;
    const compressedSize = Number(entry.header.compressedSize) || 0;
    if (size > MAX_ZIP_ENTRY_BYTES) throw new Error(`压缩包内文件过大：${name}`);
    if (compressedSize > 0 && size / compressedSize > 150) throw new Error(`压缩包压缩比异常：${name}`);
    total += size;
    if (total > MAX_ZIP_UNCOMPRESSED_BYTES) throw new Error("压缩包解压后的总体积超过 100 MB");
    if (entries.has(name)) warnings.push(`压缩包存在重复路径，已使用最后一个文件：${name}`);
    entries.set(name, entry);
  }
  return { zip, entries, warnings };
}

function resolveBundleEntry(entries: Map<string, AdmZip.IZipEntry>, baseName: string, reference: string): AdmZip.IZipEntry | undefined {
  const plain = reference.trim().replace(/^<|>$/g, "").split(/[?#]/)[0] || "";
  if (!plain || /^(?:https?:|data:|blob:|attachment:|#)/i.test(plain)) return undefined;
  let decoded = plain;
  try { decoded = decodeURIComponent(plain); } catch { /* use source text */ }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(baseName), decoded.replace(/\\/g, "/")));
  const safe = normalizeZipName(joined);
  return safe ? entries.get(safe) : undefined;
}

async function rewriteMarkdownBundleImages(
  markdown: string,
  primaryName: string,
  entries: Map<string, AdmZip.IZipEntry>,
  context: ParseContext,
): Promise<{ markdown: string; assets: InboundAttachment[]; warnings: string[] }> {
  const assets: InboundAttachment[] = [];
  const warnings: string[] = [];
  const cache = new Map<string, string>();
  const pattern = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\n]+?)\s*\)/g;
  let output = "";
  let cursor = 0;
  for (const match of markdown.matchAll(pattern)) {
    const index = match.index || 0;
    output += markdown.slice(cursor, index);
    const source = (match[2] || "").replace(/\s+["'][^"']*["']\s*$/, "");
    const entry = resolveBundleEntry(entries, primaryName, source);
    if (!entry) {
      output += match[0];
    } else {
      let reference = cache.get(entry.entryName);
      if (!reference) {
        try {
          const saved = await persistAsset(context, entry.entryName, entry.getData());
          if (saved) {
            assets.push(saved.attachment);
            reference = saved.reference;
            cache.set(entry.entryName, reference);
          }
        } catch (error) {
          warnings.push(`图片 ${entry.entryName} 未能导入：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      output += reference ? `![${match[1] || "图片"}](${reference})` : match[0];
    }
    cursor = index + match[0].length;
  }
  output += markdown.slice(cursor);
  return { markdown: output, assets, warnings };
}

async function htmlToMarkdown(
  html: string,
  title: string,
  context: ParseContext,
  bundle?: { primaryName: string; entries: Map<string, AdmZip.IZipEntry> },
): Promise<ParsedDocument> {
  const $ = load(html);
  $("script,style,noscript,iframe,object,embed,form,button").remove();
  const root = $("article,[itemprop='articleBody'],main,.markdown-body,.article-content,.post-content,body")
    .toArray()
    .sort((left, right) => $(right).text().length - $(left).text().length)[0];
  const article = root ? $(root) : $("body");
  const assets: InboundAttachment[] = [];
  const warnings: string[] = [];
  if (bundle) {
    for (const image of article.find("img").toArray()) {
      const element = $(image);
      const source = element.attr("data-src") || element.attr("src") || "";
      const entry = resolveBundleEntry(bundle.entries, bundle.primaryName, source);
      if (!entry) continue;
      try {
        const saved = await persistAsset(context, entry.entryName, entry.getData());
        if (saved) {
          assets.push(saved.attachment);
          element.attr("src", saved.reference);
        }
      } catch (error) {
        warnings.push(`图片 ${entry.entryName} 未能导入：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const markdown = normalizeMarkdown(turndownService().turndown(article.html() || article.text()));
  return { title, markdown: `# ${title}\n\n${markdown}`, assets, warnings };
}

async function parseDocx(buffer: Buffer, title: string, context: ParseContext): Promise<ParsedDocument> {
  const { entries, warnings } = zipEntries(buffer);
  const document = entries.get("word/document.xml")?.getData().toString("utf8");
  if (!document) throw new Error("DOCX 缺少 word/document.xml");
  const relations = entries.get("word/_rels/document.xml.rels")?.getData().toString("utf8") || "";
  const relationTargets = new Map<string, string>();
  for (const match of relations.matchAll(/<Relationship\b[^>]*\bId=["']([^"']+)["'][^>]*\bTarget=["']([^"']+)["'][^>]*>/gi)) {
    relationTargets.set(match[1] || "", path.posix.normalize(`word/${match[2] || ""}`));
  }
  const assets: InboundAttachment[] = [];
  const assetReferences = new Map<string, string>();
  const blocks: string[] = [];
  const body = document.match(/<(?:w:)?body\b[^>]*>([\s\S]*?)<\/(?:w:)?body>/i)?.[1] || document;
  for (const match of body.matchAll(/<(?:w:)?(p|tbl)\b[^>]*>[\s\S]*?<\/(?:w:)?\1>/gi)) {
    const type = (match[1] || "").toLowerCase();
    const xml = match[0];
    if (type === "tbl") {
      const rows = [...xml.matchAll(/<(?:w:)?tr\b[^>]*>([\s\S]*?)<\/(?:w:)?tr>/gi)].map((row) =>
        [...(row[1] || "").matchAll(/<(?:w:)?tc\b[^>]*>([\s\S]*?)<\/(?:w:)?tc>/gi)].map((cell) => xmlText(cell[1] || "")),
      );
      const table = markdownTable(rows);
      if (table) blocks.push(table);
      continue;
    }
    const text = xmlText(xml);
    const imageReferences: string[] = [];
    for (const image of xml.matchAll(/<(?:a:)?blip\b[^>]*(?:r:)?embed=["']([^"']+)["']/gi)) {
      const target = relationTargets.get(image[1] || "");
      const entry = target ? entries.get(normalizeZipName(target) || "") : undefined;
      if (!entry) continue;
      let reference = assetReferences.get(entry.entryName);
      if (!reference) {
        try {
          const saved = await persistAsset(context, entry.entryName, entry.getData());
          if (saved) {
            assets.push(saved.attachment);
            reference = saved.reference;
            assetReferences.set(entry.entryName, reference);
          }
        } catch (error) {
          warnings.push(`DOCX 图片 ${entry.entryName} 未能导入：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (reference) imageReferences.push(`![文档图片](${reference})`);
    }
    if (!text && !imageReferences.length) continue;
    const style = xml.match(/<(?:w:)?pStyle\b[^>]*(?:w:)?val=["']([^"']+)["']/i)?.[1]?.toLowerCase() || "";
    const heading = style.match(/heading\s*([1-6])|标题\s*([1-6])/i);
    const level = Number(heading?.[1] || heading?.[2] || 0);
    const list = /<(?:w:)?numPr\b/i.test(xml);
    blocks.push(`${level ? `${"#".repeat(level + 1)} ` : list ? "- " : ""}${text}${imageReferences.length ? `${text ? "\n\n" : ""}${imageReferences.join("\n")}` : ""}`);
  }
  if (!blocks.length) throw new Error("DOCX 未提取到可读正文");
  return { title, markdown: normalizeMarkdown(`# ${title}\n\n${blocks.join("\n\n")}`), assets, warnings };
}

function columnIndex(reference: string): number {
  let result = 0;
  for (const character of reference.toUpperCase().replace(/[^A-Z]/g, "")) result = result * 26 + character.charCodeAt(0) - 64;
  return Math.max(0, result - 1);
}

async function parseXlsx(buffer: Buffer, title: string): Promise<ParsedDocument> {
  const { entries, warnings } = zipEntries(buffer);
  const workbook = entries.get("xl/workbook.xml")?.getData().toString("utf8");
  if (!workbook) throw new Error("XLSX 缺少 xl/workbook.xml");
  const relations = entries.get("xl/_rels/workbook.xml.rels")?.getData().toString("utf8") || "";
  const targets = new Map<string, string>();
  for (const match of relations.matchAll(/<Relationship\b[^>]*\bId=["']([^"']+)["'][^>]*\bTarget=["']([^"']+)["'][^>]*>/gi)) {
    targets.set(match[1] || "", path.posix.normalize(`xl/${match[2] || ""}`));
  }
  const sharedXml = entries.get("xl/sharedStrings.xml")?.getData().toString("utf8") || "";
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((item) => xmlText(item[1] || ""));
  const blocks: string[] = [`# ${title}`];
  for (const sheet of workbook.matchAll(/<sheet\b[^>]*\bname=["']([^"']+)["'][^>]*(?:r:)?id=["']([^"']+)["'][^>]*>/gi)) {
    const sheetName = decodeXml(sheet[1] || "工作表");
    const target = targets.get(sheet[2] || "");
    const xml = target ? entries.get(normalizeZipName(target) || "")?.getData().toString("utf8") : undefined;
    if (!xml) continue;
    const rows: string[][] = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
      if (rows.length >= 200) break;
      const row: string[] = [];
      for (const cell of (rowMatch[1] || "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
        const attributes = cell[1] || "";
        const body = cell[2] || "";
        const index = columnIndex(attributes.match(/\br=["']([^"']+)["']/i)?.[1] || String.fromCharCode(65 + row.length));
        if (index >= 40) continue;
        const kind = attributes.match(/\bt=["']([^"']+)["']/i)?.[1] || "";
        const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] || "";
        const value = kind === "s" ? shared[Number(raw)] || "" : kind === "inlineStr" ? xmlText(body) : kind === "b" ? (raw === "1" ? "是" : "否") : decodeXml(raw);
        while (row.length <= index) row.push("");
        row[index] = value;
      }
      if (row.some(Boolean)) rows.push(row);
    }
    if (!rows.length) continue;
    blocks.push(`## ${sheetName}`, markdownTable(rows));
    if ([...xml.matchAll(/<row\b/gi)].length > rows.length) warnings.push(`工作表“${sheetName}”内容较多，阅读预览保留前 200 行`);
  }
  if (blocks.length === 1) throw new Error("XLSX 未提取到可读单元格");
  return { title, markdown: normalizeMarkdown(blocks.join("\n\n")), assets: [], warnings };
}

async function parsePdf(buffer: Buffer, title: string): Promise<ParsedDocument> {
  const task = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  const pdf = await task.promise;
  const blocks: string[] = [`# ${title}`];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines: string[] = [];
    let current = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const text = item.str.trim();
      if (text) current += `${current ? " " : ""}${text}`;
      if ("hasEOL" in item && item.hasEOL && current) {
        lines.push(current);
        current = "";
      }
    }
    if (current) lines.push(current);
    if (lines.length) blocks.push(`## 第 ${pageNumber} 页`, lines.join("\n\n"));
  }
  await task.destroy();
  if (blocks.length === 1) throw new Error("PDF 没有可提取文本，可能是扫描件；将交给视觉模型识别");
  return { title, markdown: normalizeMarkdown(blocks.join("\n\n")), assets: [], warnings: [] };
}

function chooseBundlePrimary(entries: Map<string, AdmZip.IZipEntry>): string | undefined {
  const candidates = [...entries.keys()].filter((name) => /\.(?:md|markdown|html?|xhtml)$/i.test(name));
  const priority = (name: string): number => {
    const base = path.posix.basename(name).toLowerCase();
    if (/^readme\.(?:md|markdown)$/.test(base)) return 0;
    if (/^index\.(?:html?|xhtml|md|markdown)$/.test(base)) return 1;
    return 2;
  };
  return candidates.sort((left, right) => priority(left) - priority(right) || (entries.get(right)?.header.size || 0) - (entries.get(left)?.header.size || 0))[0];
}

async function parseZip(buffer: Buffer, title: string, context: ParseContext): Promise<ParsedDocument> {
  const { entries, warnings } = zipEntries(buffer);
  const primaryName = chooseBundlePrimary(entries);
  if (primaryName) {
    const primary = entries.get(primaryName)!;
    const source = primary.getData().toString("utf8");
    if (/\.html?$/i.test(primaryName) || /\.xhtml$/i.test(primaryName)) {
      const result = await htmlToMarkdown(source, cleanTitle(path.posix.basename(primaryName)), context, { primaryName, entries });
      return { ...result, warnings: [...warnings, ...result.warnings] };
    }
    const localized = await rewriteMarkdownBundleImages(source, primaryName, entries, context);
    return {
      title: cleanTitle(path.posix.basename(primaryName)),
      markdown: normalizeMarkdown(`# ${cleanTitle(path.posix.basename(primaryName))}\n\n${localized.markdown}`),
      assets: localized.assets,
      warnings: [...warnings, ...localized.warnings],
    };
  }
  const supportedDocuments = [...entries.entries()]
    .filter(([name]) => /\.(?:pdf|docx|xlsx|txt|log|json|ya?ml|csv|tsv)$/i.test(name))
    .sort(([left], [right]) => left.localeCompare(right, "zh-CN"))
    .slice(0, 8);
  const parsedDocuments: ParsedDocument[] = [];
  for (const [name, entry] of supportedDocuments) {
    try {
      const parsed = await parseBuffer(entry.getData(), name, "", { ...context, sourceName: name });
      if (parsed) parsedDocuments.push(parsed);
    } catch (error) {
      warnings.push(`压缩包内文档 ${name} 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (parsedDocuments.length) {
    if (supportedDocuments.length < [...entries.keys()].filter((name) => /\.(?:pdf|docx|xlsx|txt|log|json|ya?ml|csv|tsv)$/i.test(name)).length) {
      warnings.push("压缩包内文档较多，阅读预览保留前 8 个支持文档");
    }
    return {
      title,
      markdown: normalizeMarkdown([
        `# ${title}`,
        ...parsedDocuments.map((document) => `## ${document.title}\n\n${document.markdown.replace(/^#\s+.*(?:\r?\n)+/, "")}`),
      ].join("\n\n")),
      assets: parsedDocuments.flatMap((document) => document.assets),
      warnings: [...warnings, ...parsedDocuments.flatMap((document) => document.warnings)],
    };
  }
  const listing = [...entries.keys()].slice(0, 200);
  warnings.push("压缩包中没有找到可直接阅读的支持文档，已生成安全文件清单；原始附件仍可下载");
  return {
    title,
    markdown: normalizeMarkdown(`# ${title}\n\n## 压缩包内容\n\n${listing.map((name) => `- ${name}`).join("\n")}`),
    assets: [],
    warnings,
  };
}

async function parseBuffer(buffer: Buffer, fileName: string, mimeType: string, context: ParseContext): Promise<ParsedDocument | undefined> {
  const extension = path.extname(fileName).toLowerCase();
  const title = cleanTitle(fileName);
  if (buffer.length > MAX_DOCUMENT_BYTES && ![".zip"].includes(extension)) throw new Error("文档超过 50 MB，本地解析已跳过");
  if ([".md", ".markdown"].includes(extension) || /markdown/i.test(mimeType)) {
    return { title, markdown: normalizeMarkdown(`# ${title}\n\n${buffer.toString("utf8")}`), assets: [], warnings: [] };
  }
  if ([".txt", ".log", ".json", ".yaml", ".yml"].includes(extension) || /^text\/plain/i.test(mimeType)) {
    const language = extension.replace(/^\./, "") || "text";
    const body = buffer.toString("utf8");
    return { title, markdown: normalizeMarkdown(`# ${title}\n\n\`\`\`${language}\n${body}\n\`\`\``), assets: [], warnings: [] };
  }
  if ([".csv", ".tsv"].includes(extension) || /(?:csv|tab-separated)/i.test(mimeType)) {
    const separator = extension === ".tsv" ? "\t" : ",";
    const rows = buffer.toString("utf8").split(/\r?\n/).filter(Boolean).slice(0, 500).map((line) => line.split(separator));
    return { title, markdown: normalizeMarkdown(`# ${title}\n\n${markdownTable(rows)}`), assets: [], warnings: [] };
  }
  if ([".html", ".htm", ".xhtml"].includes(extension) || /html/i.test(mimeType)) return htmlToMarkdown(buffer.toString("utf8"), title, context);
  if (extension === ".pdf" || mimeType === "application/pdf") return parsePdf(buffer, title);
  if (extension === ".docx" || /wordprocessingml/i.test(mimeType)) return parseDocx(buffer, title, context);
  if (extension === ".xlsx" || /spreadsheetml/i.test(mimeType)) return parseXlsx(buffer, title);
  if (extension === ".zip" || /(?:application\/zip|x-zip-compressed)/i.test(mimeType)) return parseZip(buffer, title, context);
  return undefined;
}

export async function extractCaptureDocuments(
  config: AppConfig,
  capture: CaptureInput,
  tenantId?: string,
): Promise<AttachmentExtractionResult> {
  const documents: ExtractedWebContent[] = [];
  const assets: InboundAttachment[] = [];
  const warnings: string[] = [];
  for (const attachment of capture.attachments.filter((item) => item.kind !== "derived")) {
    if (attachment.mimeType.startsWith("image/")) continue;
    try {
      const buffer = await fs.readFile(attachment.path);
      const parsed = await parseBuffer(buffer, attachment.fileName, attachment.mimeType, {
        config,
        captureId: capture.id,
        tenantId,
        sourceName: attachment.fileName,
      });
      if (!parsed) {
        if (/\.(?:doc|xls)$/i.test(attachment.fileName)) warnings.push(`${attachment.fileName} 是旧版二进制格式，请转换为 DOCX 或 XLSX 后重新发送`);
        continue;
      }
      documents.push({
        url: `https://local.knowledge-relay.invalid/${encodeURIComponent(attachment.fileName)}`,
        title: parsed.title,
        markdown: parsed.markdown,
        sourceType: "document",
      });
      assets.push(...parsed.assets);
      warnings.push(...parsed.warnings);
    } catch (error) {
      warnings.push(`${attachment.fileName} 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const readableDocuments = documents.length > 1
    ? [{
        url: `https://local.knowledge-relay.invalid/${encodeURIComponent(capture.id)}`,
        title: capture.text.trim().slice(0, 100) || "上传资料整理",
        markdown: normalizeMarkdown([
          `# ${capture.text.trim().slice(0, 100) || "上传资料整理"}`,
          ...documents.map((document) => `## ${document.title}\n\n${document.markdown.replace(/^#\s+.*(?:\r?\n)+/, "")}`),
        ].join("\n\n")),
        sourceType: "document" as const,
      }]
    : documents;
  return {
    documents: readableDocuments,
    assets,
    warnings: [...new Set(warnings)].slice(0, 20),
  };
}
