import type { AppConfig } from "./config.js";
import { IlinkApiError, IlinkClient } from "./ilink/client.js";
import { MessageItemType, MessageType, type WeixinMessage } from "./ilink/types.js";
import { errorDetails, logger } from "./logger.js";
import { downloadAttachments } from "./media.js";
import type { InboundMessage } from "./messages.js";
import { publicMessage } from "./messages.js";
import { NanobotClient } from "./nanobot.js";
import { defaultNote } from "./notes.js";
import type { AppDatabase, StoredBotAccount } from "./storage/database.js";
import { persistExtractedMarkdown } from "./web-content.js";

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function extractText(message: WeixinMessage): string {
  const fragments: string[] = [];
  for (const item of message.item_list || []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) fragments.push(item.text_item.text);
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) fragments.push(item.voice_item.text);
  }
  return fragments.join("\n").trim();
}

function chunks(text: string, maximum = 2_000): string[] {
  const characters = Array.from(text);
  const result: string[] = [];
  for (let index = 0; index < characters.length; index += maximum) {
    result.push(characters.slice(index, index + maximum).join(""));
  }
  return result;
}

export class BotManager {
  private readonly controllers = new Map<string, AbortController>();
  private readonly monitors = new Map<string, Promise<void>>();
  private readonly nanobot: NanobotClient;
  private readonly agentFailureAlerts = new Map<string, { fingerprint: string; sentAt: number }>();

  constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
  ) {
    this.nanobot = new NanobotClient(config);
  }

  async startAll(): Promise<void> {
    for (const account of this.database.getBotAccounts()) await this.start(account.id);
  }

  async start(accountId: string): Promise<void> {
    if (this.monitors.has(accountId)) return;
    const account = this.database.getBotAccount(accountId);
    if (!account) return;
    const controller = new AbortController();
    this.controllers.set(accountId, controller);
    const monitor = this.monitor(account, controller.signal).finally(() => {
      this.monitors.delete(accountId);
      this.controllers.delete(accountId);
    });
    this.monitors.set(accountId, monitor);
  }

  async replaceAccount(account: StoredBotAccount): Promise<void> {
    await this.stop(account.id, false);
    await this.start(account.id);
  }

  async stop(accountId: string, notify = true): Promise<void> {
    const account = this.database.getBotAccount(accountId);
    if (notify && account) await IlinkClient.forAccount(this.config, account).notifyStop();
    this.controllers.get(accountId)?.abort();
    await this.monitors.get(accountId);
    if (account) this.database.updateBotStatus(accountId, { state: "stopped" });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.monitors.keys()].map((id) => this.stop(id)));
  }

  isRunning(accountId: string): boolean {
    return this.monitors.has(accountId);
  }

  private agentFailureMessage(error: unknown): { fingerprint: string; message: string } {
    const detail = error instanceof Error ? error.message : String(error);
    if (/HTTP (401|403)|api.?key|unauthorized|authentication/i.test(detail)) {
      return { fingerprint: "auth", message: "知流提醒：Nanobot 的模型凭据无效或已失效，本条已按原始内容保存。请检查 Nanobot 配置。" };
    }
    if (/HTTP 429|quota|rate.?limit|余额|额度/i.test(detail)) {
      return { fingerprint: "quota", message: "知流提醒：AI 模型额度不足或调用受限，本条已按原始内容保存。" };
    }
    if (/timeout|超时|abort/i.test(detail)) {
      return { fingerprint: "timeout", message: "知流提醒：AI 模型连接超时，本条已按原始内容保存，请稍后检查服务。" };
    }
    if (/model/i.test(detail)) {
      return { fingerprint: "model", message: "知流提醒：配置的 AI 模型当前不可用，本条已按原始内容保存。" };
    }
    return { fingerprint: "service", message: "知流提醒：Nanobot 处理暂时不可用，本条已按原始内容保存，请检查 Nanobot Runtime。" };
  }

  private shouldSendAgentFailure(accountId: string, fingerprint: string): boolean {
    const previous = this.agentFailureAlerts.get(accountId);
    const current = Date.now();
    if (previous && previous.fingerprint === fingerprint && current - previous.sentAt < 6 * 60 * 60 * 1_000) return false;
    this.agentFailureAlerts.set(accountId, { fingerprint, sentAt: current });
    return true;
  }

  private async monitor(account: StoredBotAccount, signal: AbortSignal): Promise<void> {
    const client = IlinkClient.forAccount(this.config, account);
    await client.notifyStart();
    this.database.updateBotStatus(account.id, { state: "running", lastError: null });
    logger.info("微信消息接收已启动", { accountId: account.botId });
    let cursor = account.cursor;
    let timeoutMs = this.config.ilink.longPollMs;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const response = await client.getUpdates(cursor, timeoutMs, signal);
        if (signal.aborted) break;
        const pollAt = new Date().toISOString();
        this.database.updateBotStatus(account.id, { state: "running", lastPollAt: pollAt, lastError: null });
        if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
          timeoutMs = response.longpolling_timeout_ms;
        }
        for (const message of response.msgs || []) {
          try {
            await this.handleMessage(account, client, message);
          } catch (error) {
            const sourceId = message.message_id?.toString() || message.seq?.toString() || "unknown";
            const id = `${account.botId}:${sourceId}`;
            const detail = error instanceof Error ? error.message : String(error);
            this.database.recordInboundFailure({
              id,
              botAccountId: account.id,
              sourceId,
              senderId: message.from_user_id,
              error: detail,
              raw: {
                seq: message.seq,
                message_id: message.message_id,
                from_user_id: message.from_user_id,
                create_time_ms: message.create_time_ms,
                session_id: message.session_id,
                group_id: message.group_id,
                item_types: (message.item_list || []).map((item) => item.type),
              },
            });
            logger.error("单条微信消息处理失败，已进入失败记录并继续接收", {
              messageId: id,
              ...errorDetails(error),
            });
          }
        }
        if (response.get_updates_buf) {
          cursor = response.get_updates_buf;
          this.database.updateBotCursor(account.id, cursor);
        }
        failures = 0;
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof IlinkApiError && (error.ret === -14 || error.errcode === -14)) {
          this.database.clearInvalidBotToken(account.id);
          logger.error("iLink 登录凭据已失效", { accountId: account.botId });
          return;
        }
        failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.database.updateBotStatus(account.id, { state: "error", lastError: message });
        logger.error("微信消息轮询失败", { accountId: account.botId, failures, ...errorDetails(error) });
        await delay(Math.min(2_000 * 2 ** Math.min(failures - 1, 4), 30_000), signal);
      }
    }
    logger.info("微信消息接收已停止", { accountId: account.botId });
  }

  private isAllowed(account: StoredBotAccount, senderId: string): boolean {
    const configured = this.config.ilink.allowFrom;
    if (configured.includes("*")) return true;
    if (configured.length > 0) return configured.includes(senderId);
    return Boolean(account.ownerUserId && account.ownerUserId === senderId);
  }

  private async handleMessage(
    account: StoredBotAccount,
    client: IlinkClient,
    raw: WeixinMessage,
  ): Promise<void> {
    if (raw.message_type !== undefined && raw.message_type !== MessageType.USER) return;
    const senderId = raw.from_user_id || "";
    if (!senderId || !this.isAllowed(account, senderId)) {
      logger.warn("忽略未授权微信用户的消息", { accountId: account.botId, senderId: senderId || "(missing)" });
      return;
    }
    const sourceId = raw.message_id?.toString() || raw.seq?.toString();
    if (!sourceId) throw new Error("收到缺少 message_id 和 seq 的微信消息");
    const id = `${account.botId}:${sourceId}`;
    if (this.database.hasMessage(id)) return;
    const attachments = await downloadAttachments(
      raw.item_list || [],
      sourceId,
      senderId,
      this.config,
    );
    const message: InboundMessage = {
      id,
      senderId,
      botId: account.botId,
      ...(raw.session_id ? { sessionId: raw.session_id } : {}),
      receivedAt: new Date().toISOString(),
      ...(raw.create_time_ms ? { sentAt: new Date(raw.create_time_ms).toISOString() } : {}),
      text: extractText(raw),
      attachments,
      contextToken: raw.context_token || "",
    };
    const safe = publicMessage(message);
    const fallback = defaultNote(safe);
    if (!this.database.saveMessage(account.id, sourceId, safe, fallback)) return;
    // Publish the authoritative raw capture immediately. Nanobot enrichment is a
    // later revision, so a slow or unavailable Agent can never block Obsidian.
    this.database.publishMessage(id);
    let reply: string | undefined;
    const settings = this.database.getAgentSettings(this.config.nanobot);
    if (settings.enabled) {
      try {
        const skills = this.database.getEnabledSkills();
        const processed = await this.nanobot.process(
          safe,
          settings,
          skills,
        );
        const derivedAttachments = [];
        for (const document of processed.derivedDocuments) {
          derivedAttachments.push(await persistExtractedMarkdown(this.config, id, document));
        }
        this.database.completeProcessedMessage(id, processed.note, derivedAttachments);
        reply = processed.reply;
        this.agentFailureAlerts.delete(account.id);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.database.updateProcessedNote(id, fallback, "fallback", detail);
        logger.warn("Nanobot 处理失败，已使用内置规则", { messageId: id, error: detail });
        if (settings.notifyOnFailure && message.contextToken) {
          const alert = this.agentFailureMessage(error);
          if (this.shouldSendAgentFailure(account.id, alert.fingerprint)) reply = alert.message;
        }
      }
    } else {
      this.database.updateProcessedNote(id, fallback, "fallback");
    }
    this.database.publishMessage(id);
    if (!reply && this.config.autoAck) reply = this.config.autoAckText;
    if (reply && message.contextToken) {
      for (const part of chunks(reply)) await client.sendText(senderId, message.contextToken, part);
    }
    this.database.updateBotStatus(account.id, { lastMessageAt: new Date().toISOString() });
    logger.info("微信消息处理完成", { messageId: id });
  }
}
