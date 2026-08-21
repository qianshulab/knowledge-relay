import type { AppConfig } from "./config.js";
import { inferCaptureType, wechatCaptureSource, type CaptureInput } from "./capture.js";
import { IngestionService } from "./ingestion-service.js";
import { IlinkApiError, IlinkClient } from "./ilink/client.js";
import { MessageItemType, MessageType, type WeixinMessage } from "./ilink/types.js";
import { errorDetails, logger } from "./logger.js";
import { downloadAttachments } from "./media.js";
import type { AppDatabase, StoredBotAccount } from "./storage/database.js";

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
  private readonly ingestionByTenant = new Map<string, IngestionService>();
  private readonly agentFailureAlerts = new Map<string, { fingerprint: string; sentAt: number }>();

  constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
  ) {}

  private tenantDatabase(tenantId: string): AppDatabase {
    return this.database.forTenant(tenantId);
  }

  private ingestionFor(tenantId: string): IngestionService {
    let ingestion = this.ingestionByTenant.get(tenantId);
    if (!ingestion) {
      ingestion = new IngestionService(this.config, this.tenantDatabase(tenantId));
      this.ingestionByTenant.set(tenantId, ingestion);
    }
    return ingestion;
  }

  async startAll(): Promise<void> {
    const accounts = this.database.getAllBotAccounts();
    await this.recoverPendingAgentMessages();
    for (const account of accounts) await this.start(account.id);
  }

  async recoverPendingAgentMessages(): Promise<number> {
    let recovered = 0;
    for (const tenantId of this.database.tenantIdsWithPendingCaptures()) {
      recovered += await this.recoverTenantPending(tenantId);
    }
    return recovered;
  }

  private async recoverTenantPending(tenantId: string): Promise<number> {
    let recovered = 0;
    let batch = 0;
    do {
      batch = await this.ingestionFor(tenantId).recoverPending(100);
      recovered += batch;
    } while (batch === 100);
    return recovered;
  }

  reprocessMessage(tenantId: string, messageId: string): { accepted: boolean } {
    const queued = this.ingestionFor(tenantId).reprocess(messageId);
    void queued.job.catch((error) => {
      logger.warn("后台重新处理失败", { messageId, ...errorDetails(error) });
    });
    return { accepted: queued.accepted };
  }

  ingestCapture(tenantId: string, capture: CaptureInput): Promise<void> {
    return this.ingestionFor(tenantId).ingest(capture).then(() => undefined);
  }

  acceptCapture(tenantId: string, capture: CaptureInput): { accepted: boolean } {
    const accepted = this.ingestionFor(tenantId).accept(capture);
    void accepted.job.catch((error) => {
      logger.warn("API 收件后台处理失败", { captureId: capture.id, ...errorDetails(error) });
    });
    return { accepted: accepted.accepted };
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

  async pauseTenant(tenantId: string): Promise<void> {
    const accountIds = this.database.getAllBotAccounts(true)
      .filter((account) => account.tenantId === tenantId)
      .map((account) => account.id);
    await Promise.all(accountIds.map((id) => this.stop(id, false)));
  }

  async resumeTenant(tenantId: string): Promise<void> {
    await this.recoverTenantPending(tenantId);
    const accounts = this.database.getAllBotAccounts()
      .filter((account) => account.tenantId === tenantId);
    for (const account of accounts) await this.start(account.id);
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
      return { fingerprint: "timeout", message: "知流提醒：本条智能整理任务处理超时，已按原始内容保存。基础模型连接可能仍然正常，请稍后重试或检查相关 Skill。" };
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
    const tenantDatabase = this.tenantDatabase(account.tenantId);
    const client = IlinkClient.forAccount(this.config, account);
    await client.notifyStart();
    tenantDatabase.updateBotStatus(account.id, { state: "running", lastError: null });
    logger.info("微信消息接收已启动", { accountId: account.botId });
    let cursor = account.cursor;
    let timeoutMs = this.config.ilink.longPollMs;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const response = await client.getUpdates(cursor, timeoutMs, signal);
        if (signal.aborted) break;
        const pollAt = new Date().toISOString();
        tenantDatabase.updateBotStatus(account.id, { state: "running", lastPollAt: pollAt, lastError: null });
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
            tenantDatabase.recordInboundFailure({
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
            if (message.context_token && message.from_user_id) {
              try {
                await client.sendText(
                  message.from_user_id,
                  message.context_token,
                  "知流提醒：这条消息中的内容或附件未能完整保存，系统已跳过它以继续接收后续消息。请稍后重新发送；若持续失败，请在管理页面检查服务状态。",
                );
              } catch (notifyError) {
                logger.warn("微信入站失败提醒发送失败", {
                  messageId: id,
                  ...errorDetails(notifyError),
                });
              }
            }
          }
        }
        if (response.get_updates_buf) {
          cursor = response.get_updates_buf;
          tenantDatabase.updateBotCursor(account.id, cursor);
        }
        failures = 0;
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof IlinkApiError && (error.ret === -14 || error.errcode === -14)) {
          tenantDatabase.clearInvalidBotToken(account.id);
          logger.error("iLink 登录凭据已失效", { accountId: account.botId });
          return;
        }
        failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        tenantDatabase.updateBotStatus(account.id, { state: "error", lastError: message });
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
    const tenantDatabase = this.tenantDatabase(account.tenantId);
    if (raw.message_type !== undefined && raw.message_type !== MessageType.USER) return;
    const senderId = raw.from_user_id || "";
    if (!senderId || !this.isAllowed(account, senderId)) {
      logger.warn("忽略未授权微信用户的消息", { accountId: account.botId, senderId: senderId || "(missing)" });
      return;
    }
    const sourceId = raw.message_id?.toString() || raw.seq?.toString();
    if (!sourceId) throw new Error("收到缺少 message_id 和 seq 的微信消息");
    const id = `${account.botId}:${sourceId}`;
    if (tenantDatabase.hasMessage(id)) return;
    const attachments = await downloadAttachments(
      raw.item_list || [],
      sourceId,
      senderId,
      this.config,
      account.tenantId,
    );
    const text = extractText(raw);
    const capture: CaptureInput = {
      id,
      source: wechatCaptureSource(sourceId, account.id, text),
      captureType: inferCaptureType(text, attachments),
      actorId: senderId,
      ...(raw.session_id ? { sessionId: raw.session_id } : {}),
      receivedAt: new Date().toISOString(),
      ...(raw.create_time_ms ? { sentAt: new Date(raw.create_time_ms).toISOString() } : {}),
      text,
      attachments,
    };
    const result = await this.ingestionFor(account.tenantId).ingest(capture);
    if (!result.accepted) return;
    let reply = result.reply;
    const contextToken = raw.context_token || "";
    if (result.agentError) {
      if (result.notifyOnFailure && contextToken) {
        const alert = this.agentFailureMessage(result.agentError);
        if (this.shouldSendAgentFailure(account.id, alert.fingerprint)) reply = alert.message;
      }
    } else {
      this.agentFailureAlerts.delete(account.id);
    }
    if (!reply && this.config.autoAck) reply = this.config.autoAckText;
    if (reply && contextToken) {
      for (const part of chunks(reply)) await client.sendText(senderId, contextToken, part);
    }
    tenantDatabase.updateBotStatus(account.id, { lastMessageAt: new Date().toISOString() });
    logger.info("微信消息处理完成", { messageId: id });
  }
}
