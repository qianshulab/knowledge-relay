import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { AppConfig } from "./config.js";
import type { InboundAttachment } from "./messages.js";
import {
  MessageItemType,
  type CdnMedia,
  type MessageItem,
} from "./ilink/types.js";

type MediaDescription = {
  kind: InboundAttachment["kind"];
  media: CdnMedia;
  aesKey?: string;
  fileName: string;
  mimeType: string;
  transcript?: string;
};

function safeFileName(value: string): string {
  const base = path.basename(value).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_");
  return base.slice(0, 180) || "attachment.bin";
}

function describe(item: MessageItem, messageId: string): MediaDescription | undefined {
  if (item.type === MessageItemType.IMAGE && item.image_item?.media) {
    return {
      kind: "image",
      media: item.image_item.media,
      aesKey: item.image_item.aeskey
        ? Buffer.from(item.image_item.aeskey, "hex").toString("base64")
        : item.image_item.media.aes_key,
      fileName: `${messageId}.jpg`,
      mimeType: "image/jpeg",
    };
  }
  if (item.type === MessageItemType.VOICE && item.voice_item?.media) {
    return {
      kind: "voice",
      media: item.voice_item.media,
      aesKey: item.voice_item.media.aes_key,
      fileName: `${messageId}.silk`,
      mimeType: "audio/silk",
      transcript: item.voice_item.text,
    };
  }
  if (item.type === MessageItemType.FILE && item.file_item?.media) {
    const fileName = safeFileName(item.file_item.file_name || `${messageId}.bin`);
    return {
      kind: "file",
      media: item.file_item.media,
      aesKey: item.file_item.media.aes_key,
      fileName,
      mimeType: mimeFromName(fileName),
    };
  }
  if (item.type === MessageItemType.VIDEO && item.video_item?.media) {
    return {
      kind: "video",
      media: item.video_item.media,
      aesKey: item.video_item.media.aes_key,
      fileName: `${messageId}.mp4`,
      mimeType: "video/mp4",
    };
  }
  return undefined;
}

function mimeFromName(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  const known: Record<string, string> = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
  };
  return known[extension] || "application/octet-stream";
}

function parseAesKey(encoded: string): Buffer {
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 16) return decoded;
  const ascii = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) {
    return Buffer.from(ascii, "hex");
  }
  throw new Error(`媒体 AES key 长度异常：${decoded.length}`);
}

function decryptAesEcb(encrypted: Buffer, encodedKey: string): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", parseAesKey(encodedKey), null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function mediaUrl(media: CdnMedia, cdnBaseUrl: string): URL {
  if (media.full_url) return new URL(media.full_url);
  if (!media.encrypt_query_param) throw new Error("媒体缺少下载地址");
  const url = new URL("download", cdnBaseUrl.endsWith("/") ? cdnBaseUrl : `${cdnBaseUrl}/`);
  url.searchParams.set("encrypted_query_param", media.encrypt_query_param);
  return url;
}

function validateCdnUrl(url: URL, configuredBaseUrl: string): void {
  const configuredHost = new URL(configuredBaseUrl).hostname;
  const officialHost =
    url.hostname === "weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com");
  if (url.protocol !== "https:" || (!officialHost && url.hostname !== configuredHost)) {
    throw new Error(`拒绝非微信 CDN 地址：${url.hostname}`);
  }
}

async function download(
  initialUrl: URL,
  maxBytes: number,
  configuredBaseUrl: string,
): Promise<Buffer> {
  let url = initialUrl;
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    validateCdnUrl(url, configuredBaseUrl);
    response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) throw new Error("微信 CDN 跳转响应缺少 Location");
    if (redirects === 3) throw new Error("微信 CDN 跳转次数过多");
    url = new URL(location, url);
  }
  if (!response?.ok) throw new Error(`媒体下载失败：HTTP ${response?.status ?? "unknown"}`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxBytes) throw new Error(`媒体超过大小限制：${contentLength} bytes`);
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`媒体超过大小限制：>${maxBytes} bytes`);
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts, total);
}

export async function downloadAttachments(
  items: MessageItem[],
  messageId: string,
  senderId: string,
  config: AppConfig,
): Promise<InboundAttachment[]> {
  const attachments: InboundAttachment[] = [];
  const date = new Date().toISOString().slice(0, 10);
  const directory = path.join(
    config.dataDir,
    "media",
    date,
    safeFileName(senderId),
  );
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  for (const [index, item] of items.entries()) {
    const description = describe(item, `${safeFileName(messageId)}-${index + 1}`);
    if (!description) continue;
    const url = mediaUrl(description.media, config.ilink.cdnBaseUrl);
    validateCdnUrl(url, config.ilink.cdnBaseUrl);
    const encrypted = await download(
      url,
      config.ilink.maxMediaBytes,
      config.ilink.cdnBaseUrl,
    );
    const content = description.aesKey
      ? decryptAesEcb(encrypted, description.aesKey)
      : encrypted;
    if (content.length > config.ilink.maxMediaBytes) {
      throw new Error(`解密后的媒体超过大小限制：${content.length} bytes`);
    }
    const storedName =
      description.kind === "file"
        ? `${safeFileName(messageId)}-${index + 1}-${safeFileName(description.fileName)}`
        : safeFileName(description.fileName);
    const filePath = path.join(directory, storedName);
    await fs.writeFile(filePath, content, { mode: 0o600 });
    attachments.push({
      kind: description.kind,
      fileName: path.basename(filePath),
      path: filePath,
      size: content.length,
      mimeType: description.mimeType,
      ...(description.transcript ? { transcript: description.transcript } : {}),
    });
  }
  return attachments;
}
