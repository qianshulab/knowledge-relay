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

const TRACKING_QUERY_KEYS = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "spm", "from", "from_source",
  "ref", "referrer", "sourceid", "share_token", "share_source",
]);

/**
 * Produces a tenant-local content identity without changing the URL retained
 * for reading. Tracking parameters, fragments and parameter order must not
 * cause the same page to be enriched more than once.
 */
export function canonicalCaptureUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");

    if (url.hostname === "mp.weixin.qq.com" && /^\/s\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
      url.search = "";
    } else {
      const retained = [...url.searchParams.entries()]
        .filter(([key]) => !key.toLowerCase().startsWith("utm_") && !TRACKING_QUERY_KEYS.has(key.toLowerCase()))
        .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
          leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
      url.search = "";
      for (const [key, item] of retained) url.searchParams.append(key, item);
    }
    return url.toString();
  } catch {
    return "";
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
