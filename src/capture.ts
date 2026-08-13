import crypto from "node:crypto";

import type { InboundAttachment } from "./messages.js";

export type CaptureChannelType = "wechat" | "api" | "rss" | "email" | "manual";
export type CaptureSourceType =
  | "wechat"
  | "wechat_article"
  | "web"
  | "rss"
  | "api"
  | "email"
  | "manual"
  | "cti"
  | "paper"
  | "other";
export type CaptureType = "text" | "link" | "image" | "file" | "mixed";

export type CaptureSource = {
  channel: CaptureChannelType;
  type: CaptureSourceType;
  externalId: string;
  connectionId?: string;
  name: string;
  url?: string;
};

export type CaptureInput = {
  id: string;
  source: CaptureSource;
  captureType: CaptureType;
  actorId: string;
  sessionId?: string;
  receivedAt: string;
  sentAt?: string;
  text: string;
  attachments: InboundAttachment[];
};

export function firstHttpUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s<>()\[\]{}"']+/i)?.[0];
  if (!match) return undefined;
  try {
    return new URL(match).toString();
  } catch {
    return undefined;
  }
}

export function inferCaptureType(text: string, attachments: InboundAttachment[]): CaptureType {
  const hasText = Boolean(text.trim());
  const hasUrl = Boolean(firstHttpUrl(text));
  if (!attachments.length) return hasUrl ? "link" : "text";
  const onlyImages = attachments.every((attachment) => attachment.kind === "image");
  if (!hasText && onlyImages) return "image";
  if (!hasText && attachments.length === 1) return "file";
  return "mixed";
}

export function wechatCaptureSource(
  externalId: string,
  connectionId: string,
  text: string,
): CaptureSource {
  const url = firstHttpUrl(text);
  const isArticle = Boolean(url && new URL(url).hostname.toLowerCase() === "mp.weixin.qq.com");
  return {
    channel: "wechat",
    type: isArticle ? "wechat_article" : url ? "web" : "wechat",
    externalId,
    connectionId,
    name: isArticle ? "微信公众号" : url ? new URL(url).hostname : "微信 iLink",
    ...(url ? { url } : {}),
  };
}

export function stableCaptureId(source: CaptureSource): string {
  const identity = [source.channel, source.connectionId || "owner", source.externalId].join("\n");
  return `${source.channel}:${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}
