import crypto from "node:crypto";

import type { AppConfig } from "../config.js";
import { publicMessage, type InboundMessage } from "../messages.js";
import type { ProcessorResult } from "./types.js";

type WebhookResponse = {
  handled?: boolean;
  reply?: unknown;
};

export async function callProcessingWebhook(
  message: InboundMessage,
  config: AppConfig,
): Promise<ProcessorResult | undefined> {
  if (!config.webhook.url) return undefined;

  const body = JSON.stringify({
    event: "ilink.message.received",
    message: publicMessage(message),
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": config.ilink.botAgent,
    "X-Ilink-Event-Id": message.id,
    "X-Ilink-Timestamp": timestamp,
  };
  if (config.webhook.secret) {
    headers["X-Ilink-Signature"] = `sha256=${crypto
      .createHmac("sha256", config.webhook.secret)
      .update(`${timestamp}.${body}`)
      .digest("hex")}`;
  }

  const response = await fetch(config.webhook.url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(config.webhook.timeoutMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`业务 Webhook 返回 HTTP ${response.status}: ${detail.slice(0, 300)}`);
  }
  if (response.status === 204) return { handled: true };

  const raw = await response.text();
  if (!raw.trim()) return { handled: true };
  const result = JSON.parse(raw) as WebhookResponse;
  if (result.reply !== undefined && typeof result.reply !== "string") {
    throw new Error("业务 Webhook 的 reply 必须是字符串");
  }
  return {
    handled: result.handled ?? true,
    ...(typeof result.reply === "string" && result.reply.trim()
      ? { reply: result.reply.trim() }
      : {}),
  };
}
