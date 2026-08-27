import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { BotManager } from "./bot-manager.js";
import { inferCaptureType, stableCaptureId, wechatCaptureSource, type CaptureInput } from "./capture.js";
import type { AppConfig } from "./config.js";
import { errorDetails, logger } from "./logger.js";
import type { InboundAttachment } from "./messages.js";
import type { AppDatabase, WechatMcpBinding, WechatMcpSourceSecret } from "./storage/database.js";
import { WechatMcpClient, type WechatMcpMessage, type WechatMcpSession } from "./wechat-mcp-client.js";

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function messageDate(value?: number | string): Date {
  if (!value) return new Date();
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }
  const numeric = Number(value);
  return new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric);
}

function safeName(value: string): string {
  return path.basename(value).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").slice(0, 160) || "attachment.bin";
}

function extension(mimeType: string): string {
  return ({
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
  } as Record<string, string>)[mimeType] || ".bin";
}

function messageText(message: WechatMcpMessage): string {
  const parts = [message.title, message.content, message.url]
    .map((item) => item?.trim())
    .filter(Boolean) as string[];
  if (!parts.length) {
    if (message.imageUrl) parts.push("[图片]");
    else if (message.videoUrl) parts.push("[视频]");
    else if (message.fileUrl) parts.push(`[文件] ${message.fileName || "微信文件"}`);
  }
  return [...new Set(parts)].join("\n").trim();
}

export class WechatMcpIntakeManager {
  private controller?: AbortController;
  private loop?: Promise<void>;
  private activeClient?: { endpoint: string; authorization: string; client: WechatMcpClient };

  constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
    private readonly bots: BotManager,
  ) {}

  async start(): Promise<void> {
    if (this.loop) return;
    const controller = new AbortController();
    this.controller = controller;
    this.loop = this.monitor(controller.signal).finally(() => {
      if (this.controller === controller) this.controller = undefined;
      this.loop = undefined;
    });
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.loop;
    this.activeClient = undefined;
  }

  async reload(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async check(source?: WechatMcpSourceSecret) {
    const configured = source || this.database.getWechatMcpSourceSecret();
    if (!configured?.endpoint || !configured.authorization) throw new Error("请先填写 MCP 地址和 Authorization");
    return new WechatMcpClient(configured.endpoint, configured.authorization).check();
  }

  private async monitor(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const source = this.database.getWechatMcpSourceSecret();
      if (!source?.enabled) {
        await wait(3_000, signal);
        continue;
      }
      try {
        await this.poll(source);
        this.database.updateWechatMcpStatus({ lastPollAt: new Date().toISOString(), lastError: null });
      } catch (error) {
        // A restarted MCP server invalidates both the HTTP connection and any
        // Streamable HTTP session. Drop the client so the next poll always
        // performs a fresh initialize/tools-list handshake.
        this.activeClient = undefined;
        const detail = error instanceof Error ? error.message : String(error);
        this.database.updateWechatMcpStatus({ lastPollAt: new Date().toISOString(), lastError: detail.slice(0, 500) });
        logger.warn("微信助手 MCP 增量接收失败", errorDetails(error));
      }
      await wait(source.pollIntervalSeconds * 1_000, signal);
    }
  }

  private async poll(source: WechatMcpSourceSecret): Promise<void> {
    if (!this.activeClient
      || this.activeClient.endpoint !== source.endpoint
      || this.activeClient.authorization !== source.authorization) {
      this.activeClient = {
        endpoint: source.endpoint,
        authorization: source.authorization,
        client: new WechatMcpClient(source.endpoint, source.authorization),
      };
    }
    const client = this.activeClient.client;
    await client.initialize();
    const accounts = await client.listAccounts();
    const account = source.account || accounts[0] || "";
    if (!account) throw new Error("MCP 当前没有可读取的微信账号");
    const sessions = await client.listSessions(account, 30);
    const cutoff = source.lastPollAt ? Date.parse(source.lastPollAt) - 60_000 : 0;
    for (const session of sessions) {
      if (session.isGroup) continue;
      const binding = this.database.getWechatMcpBinding(source.id, account, session.username);
      const sessionTime = messageDate(session.lastMessageTime).getTime();
      if (source.lastPollAt && !binding && sessionTime < cutoff) continue;
      if (binding?.lastMessageAt && sessionTime < Date.parse(binding.lastMessageAt)) continue;
      await this.processSession(client, source, account, session, binding);
    }
  }

  private async processSession(
    client: WechatMcpClient,
    source: WechatMcpSourceSecret,
    account: string,
    session: WechatMcpSession,
    initialBinding?: WechatMcpBinding,
  ): Promise<void> {
    const messages = (await client.getMessages(account, session.username, 20))
      .filter((message) => !message.isSent)
      .sort((left, right) => messageDate(left.createTime).getTime() - messageDate(right.createTime).getTime());
    let binding = initialBinding;
    for (const message of messages) {
      const sentAt = messageDate(message.createTime).toISOString();
      const content = messageText(message);
      if (!binding) {
        const code = content.match(/^ZL-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/i)?.[0];
        if (!code) continue;
        binding = this.database.consumeWechatMcpBindingCode({
          code,
          sourceId: source.id,
          account,
          wechatUsername: session.username,
          wechatDisplayName: session.name,
          avatar: session.avatar,
        });
        if (binding) {
          this.database.updateWechatMcpBindingCursor(binding.id, message.id, sentAt);
          binding = { ...binding, lastMessageId: message.id, lastMessageAt: sentAt };
          logger.info("微信助手联系人已完成用户绑定", { tenantId: binding.tenantId, sourceId: source.id });
        }
        continue;
      }
      if (Date.parse(sentAt) < Date.parse(binding.boundAt)) continue;
      if (binding.lastMessageAt && Date.parse(sentAt) < Date.parse(binding.lastMessageAt)) continue;
      if (binding.lastMessageId === message.id) continue;
      const attachments = await this.downloadAttachments(client, binding, message);
      // Include the MCP account in the stable connection identity. Message IDs
      // are not guaranteed to be globally unique across multiple WeChat data
      // accounts exposed by one MCP server.
      const sourceInfo = wechatCaptureSource(message.id, `wechat-mcp:${source.id}:${account}`, content);
      sourceInfo.name = sourceInfo.type === "wechat_article" ? "微信公众号" : source.displayName;
      const capture: CaptureInput = {
        id: stableCaptureId(sourceInfo),
        source: sourceInfo,
        captureType: inferCaptureType(content, attachments),
        actorId: session.username,
        sessionId: session.username,
        receivedAt: new Date().toISOString(),
        sentAt,
        text: content,
        attachments,
      };
      const accepted = this.bots.acceptCapture(binding.tenantId, capture);
      this.database.updateWechatMcpBindingCursor(binding.id, message.id, sentAt);
      this.database.updateWechatMcpStatus({ lastMessageAt: sentAt, lastError: null });
      binding = { ...binding, lastMessageId: message.id, lastMessageAt: sentAt };
      logger.info(accepted.accepted ? "微信助手消息已进入收件台" : "微信助手消息已存在，跳过重复收件", {
        tenantId: binding.tenantId,
        messageId: capture.id,
        sourceId: source.id,
      });
    }
  }

  private async downloadAttachments(
    client: WechatMcpClient,
    binding: WechatMcpBinding,
    message: WechatMcpMessage,
  ): Promise<InboundAttachment[]> {
    const media = [
      message.imageUrl ? { url: message.imageUrl, kind: "image" as const, name: "微信图片" } : undefined,
      message.videoUrl ? { url: message.videoUrl, kind: "video" as const, name: "微信视频" } : undefined,
      message.fileUrl ? { url: message.fileUrl, kind: "file" as const, name: message.fileName || "微信文件" } : undefined,
    ].filter(Boolean) as Array<{ url: string; kind: "image" | "video" | "file"; name: string }>;
    const result: InboundAttachment[] = [];
    for (const [index, item] of media.entries()) {
      try {
        const downloaded = await client.downloadMedia(item.url, this.config.ilink.maxMediaBytes);
        const tenantKey = crypto.createHash("sha256").update(binding.tenantId).digest("hex").slice(0, 16);
        const directory = path.join(this.config.dataDir, "media", "tenants", tenantKey, new Date().toISOString().slice(0, 10), "wechat-mcp");
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const proposed = item.kind === "file" && message.fileName
          ? message.fileName
          : `${message.id}-${index + 1}${extension(downloaded.mimeType)}`;
        const filePath = path.join(directory, safeName(proposed));
        await fs.writeFile(filePath, downloaded.content, { mode: 0o600 });
        result.push({
          kind: item.kind,
          fileName: safeName(proposed),
          path: filePath,
          size: downloaded.content.length,
          mimeType: downloaded.mimeType,
        });
      } catch (error) {
        logger.warn("微信助手 MCP 媒体保存失败，文字内容仍会继续收件", {
          messageId: message.id,
          ...errorDetails(error),
        });
      }
    }
    return result;
  }
}
