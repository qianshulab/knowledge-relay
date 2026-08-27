import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { AppConfig } from "./config.js";
import type { InboundAttachment } from "./messages.js";
import { localizeMarkdownImages } from "./web-assets.js";

export type ExtractedWebContent = {
  url: string;
  title: string;
  author?: string;
  publishedAt?: string;
  markdown: string;
  sourceType: "wechat" | "web" | "document";
};

export type GeneratedVisualization = {
  url: string;
  title: string;
  content: string;
  fileName: string;
  mimeType: "text/markdown" | "application/json";
  sourceType: "visualization";
};

export type DerivedContent = ExtractedWebContent | GeneratedVisualization;

export async function persistExtractedMarkdown(
  config: AppConfig,
  messageId: string,
  content: ExtractedWebContent,
  tenantId?: string,
): Promise<InboundAttachment> {
  const bundle = await persistExtractedBundle(config, messageId, content, tenantId);
  return bundle.attachments[0]!;
}

export type PersistedExtractedBundle = {
  attachments: InboundAttachment[];
  warnings: string[];
};

function validateVisualizationJson(content: string, extension: ".canvas" | ".excalidraw"): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${extension} 产物不是有效 JSON`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`${extension} 产物结构无效`);
  const record = parsed as Record<string, unknown>;
  if (extension === ".canvas") {
    if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) {
      throw new Error("Canvas 产物缺少 nodes 或 edges");
    }
    if (record.nodes.length > 500 || record.edges.length > 1_000) {
      throw new Error("Canvas 产物规模超过安全限制");
    }
    const ids = new Set<string>();
    for (const node of record.nodes) {
      if (!node || typeof node !== "object") throw new Error("Canvas 节点结构无效");
      const item = node as Record<string, unknown>;
      if (typeof item.id !== "string" || !item.id || ids.has(item.id)) {
        throw new Error("Canvas 节点 ID 无效或重复");
      }
      if (!["text", "group"].includes(String(item.type))) {
        throw new Error("Canvas 仅允许文本与分组节点");
      }
      if (typeof item.text === "string" && item.text.length > 10_000) {
        throw new Error("Canvas 节点文本超过安全限制");
      }
      ids.add(item.id);
      for (const coordinate of [item.x, item.y, item.width, item.height]) {
        if (typeof coordinate !== "number" || !Number.isFinite(coordinate) || Math.abs(coordinate) > 1_000_000) {
          throw new Error("Canvas 节点坐标或尺寸无效");
        }
      }
      if (Number(item.width) <= 0 || Number(item.height) <= 0) {
        throw new Error("Canvas 节点尺寸无效");
      }
    }
    for (const edge of record.edges) {
      if (!edge || typeof edge !== "object") throw new Error("Canvas 连线结构无效");
      const item = edge as Record<string, unknown>;
      if (typeof item.id !== "string" || !ids.has(String(item.fromNode)) || !ids.has(String(item.toNode))) {
        throw new Error("Canvas 连线引用了不存在的节点");
      }
    }
    return;
  }
  if (record.type !== "excalidraw" || !Array.isArray(record.elements)) {
    throw new Error("Excalidraw 产物结构无效");
  }
  if (record.elements.length > 1_000) throw new Error("Excalidraw 产物规模超过安全限制");
  const allowedElements = new Set(["rectangle", "ellipse", "diamond", "line", "arrow", "text", "freedraw", "frame"]);
  for (const element of record.elements) {
    if (!element || typeof element !== "object") throw new Error("Excalidraw 元素结构无效");
    const item = element as Record<string, unknown>;
    if (typeof item.id !== "string" || !allowedElements.has(String(item.type))) {
      throw new Error("Excalidraw 包含不受支持的元素");
    }
    if (item.link != null) throw new Error("Excalidraw 产物不允许外部链接");
  }
  if (record.files && typeof record.files === "object" && Object.keys(record.files).length) {
    throw new Error("Excalidraw 产物不允许嵌入外部文件");
  }
}

export async function persistGeneratedVisualization(
  config: AppConfig,
  messageId: string,
  content: GeneratedVisualization,
  tenantId?: string,
): Promise<InboundAttachment> {
  const extension = path.extname(content.fileName).toLowerCase();
  if (![".md", ".canvas", ".excalidraw"].includes(extension)) {
    throw new Error("可视化产物格式不受支持");
  }
  const size = Buffer.byteLength(content.content);
  if (!size || size > 5 * 1024 * 1024) throw new Error("可视化产物为空或超过 5 MB");
  if (extension === ".canvas" || extension === ".excalidraw") {
    validateVisualizationJson(content.content, extension);
  }
  const digest = crypto
    .createHash("sha256")
    .update(`${messageId}\nvisualization\n${content.title}\n${content.fileName}\n${content.content}`)
    .digest("hex")
    .slice(0, 20);
  const tenantDirectory = tenantId
    ? crypto.createHash("sha256").update(tenantId).digest("hex").slice(0, 16)
    : "legacy";
  const folder = path.join(
    config.dataDir,
    "derived",
    "tenants",
    tenantDirectory,
    new Date().toISOString().slice(0, 10),
  );
  await fs.mkdir(folder, { recursive: true });
  const safeTitle = content.title
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "知识可视化";
  const fileName = `${safeTitle}-${digest.slice(0, 8)}${extension}`;
  const filePath = path.join(folder, `${digest}${extension}`);
  await fs.writeFile(filePath, content.content, { encoding: "utf8", mode: 0o600 });
  return {
    kind: "derived",
    fileName,
    path: filePath,
    size,
    mimeType: extension === ".md" ? "text/markdown" : "application/json",
  };
}

export async function persistExtractedBundle(
  config: AppConfig,
  messageId: string,
  content: ExtractedWebContent,
  tenantId?: string,
): Promise<PersistedExtractedBundle> {
  const localized = await localizeMarkdownImages(config, content.markdown, tenantId, undefined, content.url);
  const accessWarnings = /回复或点赞可查看完整内容|登录后(?:才)?可查看完整内容|该内容仅对登录用户可见/i.test(content.markdown)
    ? ["原站对部分正文设置了登录、回复或点赞权限；已保存当前可访问的正文与图片，受限部分需在原站授权后重新整理。"]
    : [];
  const digest = crypto
    .createHash("sha256")
    .update(`${messageId}\n${content.sourceType}\n${content.url}\n${content.title}\n${localized.markdown}`)
    .digest("hex")
    .slice(0, 20);
  const tenantDirectory = tenantId
    ? crypto.createHash("sha256").update(tenantId).digest("hex").slice(0, 16)
    : "legacy";
  const folder = path.join(
    config.dataDir,
    "derived",
    "tenants",
    tenantDirectory,
    new Date().toISOString().slice(0, 10),
  );
  await fs.mkdir(folder, { recursive: true });
  const safeTitle = content.title.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || (content.sourceType === "document" ? "文档解析" : "网页解析");
  const fileName = `${safeTitle}-${digest.slice(0, 8)}.md`;
  const filePath = path.join(folder, `${digest}.md`);
  await fs.writeFile(filePath, localized.markdown, { encoding: "utf8", mode: 0o600 });
  return {
    attachments: [
      {
        kind: "derived",
        fileName,
        path: filePath,
        size: Buffer.byteLength(localized.markdown),
        mimeType: "text/markdown",
      },
      ...localized.images,
    ],
    warnings: [...new Set([...localized.warnings, ...accessWarnings])],
  };
}
