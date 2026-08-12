import crypto from "node:crypto";

import type { BotManager } from "../bot-manager.js";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../storage/database.js";
import { IlinkClient } from "./client.js";
import type { QrStatus } from "./types.js";

type LoginSession = {
  id: string;
  qrcode: string;
  qrContent: string;
  createdAt: number;
  apiBaseUrl: string;
  status: QrStatus;
  polling?: Promise<LoginPollResult>;
};

export type LoginPollResult = {
  status: QrStatus | "error" | "already_connected";
  message: string;
  connected: boolean;
};

const SESSION_TTL_MS = 10 * 60_000;

function validateIlinkUrl(raw: string): string {
  const url = new URL(raw);
  const official = url.hostname === "weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com");
  if (url.protocol !== "https:" || !official) throw new Error(`iLink 返回了不受信任的服务地址：${url.hostname}`);
  return url.toString();
}

export class AccountLoginManager {
  private readonly sessions = new Map<string, LoginSession>();

  constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
    private readonly bots: BotManager,
  ) {}

  async start(): Promise<{ sessionId: string }> {
    this.purge();
    const client = new IlinkClient({
      apiBaseUrl: this.config.ilink.apiBaseUrl,
      appId: this.config.ilink.appId,
      botAgent: this.config.ilink.botAgent,
    });
    const tokens = this.database.getBotAccounts().map((account) => account.botToken);
    const response = await client.fetchQrCode(tokens);
    if (!response.qrcode || !response.qrcode_img_content) throw new Error("iLink 未返回有效二维码");
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, {
      id: sessionId,
      qrcode: response.qrcode,
      qrContent: response.qrcode_img_content,
      createdAt: Date.now(),
      apiBaseUrl: this.config.ilink.apiBaseUrl,
      status: "wait",
    });
    return { sessionId };
  }

  getQrContent(sessionId: string): string | undefined {
    const session = this.getFresh(sessionId);
    return session?.qrContent;
  }

  async poll(sessionId: string, verifyCode?: string): Promise<LoginPollResult> {
    const session = this.getFresh(sessionId);
    if (!session) {
      return { status: "expired", message: "登录二维码已过期，请重新开始。", connected: false };
    }
    if (session.polling) return session.polling;
    session.polling = this.pollOnce(session, verifyCode).finally(() => {
      session.polling = undefined;
    });
    return session.polling;
  }

  private async pollOnce(session: LoginSession, verifyCode?: string): Promise<LoginPollResult> {
    const client = new IlinkClient({
      apiBaseUrl: session.apiBaseUrl,
      appId: this.config.ilink.appId,
      botAgent: this.config.ilink.botAgent,
    });
    const response = await client.getQrStatus(session.qrcode, verifyCode);
    session.status = response.status;
    if (response.status === "scaned_but_redirect") {
      if (!response.redirect_host) return { status: "error", message: "iLink 跳转地址缺失。", connected: false };
      session.apiBaseUrl = validateIlinkUrl(`https://${response.redirect_host}`);
      return { status: response.status, message: "已扫码，正在切换服务节点……", connected: false };
    }
    if (response.status === "confirmed") {
      if (!response.bot_token || !response.ilink_bot_id) {
        this.sessions.delete(session.id);
        return { status: "error", message: "授权成功，但 iLink 没有返回完整凭据。", connected: false };
      }
      const account = this.database.addBotAccount({
        botToken: response.bot_token,
        botId: response.ilink_bot_id,
        baseUrl: validateIlinkUrl(response.baseurl || session.apiBaseUrl),
        ...(response.ilink_user_id ? { ownerUserId: response.ilink_user_id } : {}),
        connectedAt: new Date().toISOString(),
      });
      await this.bots.replaceAccount(account);
      this.sessions.delete(session.id);
      return { status: "confirmed", message: "微信已连接，消息接收已启动。", connected: true };
    }
    if (response.status === "binded_redirect") {
      this.sessions.delete(session.id);
      return { status: "already_connected", message: "此机器人已被其他服务实例绑定。", connected: false };
    }
    const messages: Record<QrStatus, string> = {
      wait: "等待扫码……",
      scaned: "已扫码，请在微信中确认。",
      confirmed: "微信已连接。",
      expired: "二维码已过期，请重新开始。",
      scaned_but_redirect: "已扫码，正在切换服务节点……",
      need_verifycode: "请填写微信中显示的配对码。",
      verify_code_blocked: "配对码错误次数过多，请重新开始。",
      binded_redirect: "机器人已绑定。",
    };
    if (["expired", "verify_code_blocked"].includes(response.status)) this.sessions.delete(session.id);
    return { status: response.status, message: messages[response.status], connected: false };
  }

  private getFresh(sessionId: string): LoginSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  private purge(): void {
    for (const [id, session] of this.sessions) {
      if (Date.now() - session.createdAt > SESSION_TTL_MS) this.sessions.delete(id);
    }
  }
}
