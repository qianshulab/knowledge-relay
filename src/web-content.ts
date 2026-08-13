import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

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

export async function persistExtractedMarkdown(
  config: AppConfig,
  messageId: string,
  content: ExtractedWebContent,
): Promise<InboundAttachment> {
  const digest = crypto.createHash("sha256").update(`${messageId}\n${content.url}`).digest("hex").slice(0, 20);
  const folder = path.join(config.dataDir, "derived", new Date().toISOString().slice(0, 10));
  await fs.mkdir(folder, { recursive: true });
  const safeTitle = content.title.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "网页解析";
  const fileName = `${safeTitle}-${digest.slice(0, 8)}.md`;
  const filePath = path.join(folder, `${digest}.md`);
  await fs.writeFile(filePath, content.markdown, { encoding: "utf8", mode: 0o600 });
  return { kind: "derived", fileName, path: filePath, size: Buffer.byteLength(content.markdown), mimeType: "text/markdown" };
}
