import type { CaptureInput } from "./capture.js";

export type AttachmentKind = "image" | "voice" | "file" | "video" | "derived";

export type InboundAttachment = {
  kind: AttachmentKind;
  fileName: string;
  path: string;
  size: number;
  mimeType: string;
  transcript?: string;
};

export type InboundMessage = {
  id: string;
  senderId: string;
  botId: string;
  sessionId?: string;
  receivedAt: string;
  sentAt?: string;
  text: string;
  attachments: InboundAttachment[];
  /** 仅供微信回复使用；不会写入收件箱或发送给业务 Webhook。 */
  contextToken: string;
};

export type PublicInboundMessage = Omit<InboundMessage, "contextToken">;

/** @deprecated New channel adapters should emit CaptureInput. */
export type LegacyPublicInboundMessage = PublicInboundMessage;

export function publicMessage(message: InboundMessage): PublicInboundMessage {
  const { contextToken: _contextToken, ...safe } = message;
  return safe;
}

export type ProcessableMessage = CaptureInput | PublicInboundMessage;
