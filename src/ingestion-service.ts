import type { AppConfig } from "./config.js";
import type { CaptureInput } from "./capture.js";
import { logger } from "./logger.js";
import { NanobotClient } from "./nanobot.js";
import { defaultNote } from "./notes.js";
import { extractPublicWebContent } from "./public-web-extractor.js";
import type { AgentSettings, AppDatabase } from "./storage/database.js";
import { persistExtractedBundle, persistGeneratedVisualization, type ExtractedWebContent } from "./web-content.js";

export type IngestionResult = {
  accepted: boolean;
  reply?: string;
  agentError?: unknown;
  notifyOnFailure: boolean;
};

export type CaptureAgent = Pick<NanobotClient, "process">;
export type PublicWebExtractor = (url: string) => Promise<ExtractedWebContent | undefined>;

export type AcceptedCapture = {
  accepted: boolean;
  job: Promise<IngestionResult>;
};

/**
 * Channel-neutral capture pipeline. Adapters own authentication, transport,
 * attachment acquisition and replies; this service owns durable ingestion,
 * enrichment and sync publication.
 */
export class IngestionService {
  private readonly nanobot: CaptureAgent;
  private readonly webExtractor: PublicWebExtractor;
  private readonly activeJobs = new Map<string, Promise<IngestionResult>>();
  private processingQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
    nanobot?: CaptureAgent,
    webExtractor?: PublicWebExtractor,
  ) {
    this.nanobot = nanobot || new NanobotClient(config);
    this.webExtractor = webExtractor || extractPublicWebContent;
  }

  async ingest(capture: CaptureInput): Promise<IngestionResult> {
    return this.accept(capture).job;
  }

  accept(capture: CaptureInput): AcceptedCapture {
    const fallback = defaultNote(capture);
    if (!this.database.saveCapture(capture, fallback)) {
      return {
        accepted: false,
        job: Promise.resolve({ accepted: false, notifyOnFailure: false }),
      };
    }
    // Persist the raw revision immediately for recovery and audit. Sync batches
    // expose only the later enriched/fallback revision, so clients never create
    // a note from a temporary generic title while the Agent is still working.
    this.database.publishMessage(capture.id);
    const job = this.enqueue(() => this.processAccepted(capture, fallback))
      .finally(() => {
        if (this.activeJobs.get(capture.id) === job) this.activeJobs.delete(capture.id);
      });
    this.activeJobs.set(capture.id, job);
    return { accepted: true, job };
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const job = this.processingQueue.then(task, task);
    this.processingQueue = job.then(() => undefined, () => undefined);
    return job;
  }

  private async processAccepted(capture: CaptureInput, fallback: ReturnType<typeof defaultNote>): Promise<IngestionResult> {
    const settings = this.database.getAgentSettings(this.config.nanobot);
    if (!settings.enabled) {
      this.database.updateProcessedNote(capture.id, fallback, "fallback");
      this.database.publishMessage(capture.id);
      return { accepted: true, notifyOnFailure: false };
    }
    try {
      const reply = await this.completeWithRetry(capture, settings);
      this.database.publishMessage(capture.id);
      return { accepted: true, reply, notifyOnFailure: settings.notifyOnFailure };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.database.updateProcessedNote(capture.id, fallback, "fallback", detail);
      this.database.publishMessage(capture.id);
      logger.warn("Nanobot 处理失败，已使用内置规则", { captureId: capture.id, error: detail });
      return {
        accepted: true,
        agentError: error,
        notifyOnFailure: settings.notifyOnFailure,
      };
    }
  }

  async recoverPending(limit = 100): Promise<number> {
    const pending = this.database.listPendingCaptures(limit);
    if (!pending.length) return 0;
    logger.warn("发现服务中断时未完成的 AI 任务，正在自动恢复", { count: pending.length });
    const settings = this.database.getAgentSettings(this.config.nanobot);
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const capture = pending[next++]?.capture;
        if (!capture) return;
        const fallback = defaultNote(capture);
        try {
          if (settings.enabled) {
            await this.enqueue(() => this.completeWithRetry(capture, settings));
          } else {
            this.database.updateProcessedNote(capture.id, fallback, "fallback");
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.database.updateProcessedNote(capture.id, fallback, "fallback", detail);
          logger.warn("中断的 AI 任务恢复失败，已保存原始内容", {
            captureId: capture.id,
            error: detail,
          });
        }
        this.database.publishMessage(capture.id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, pending.length) }, worker));
    logger.info("服务中断时遗留的 AI 任务已恢复", { count: pending.length });
    return pending.length;
  }

  reprocess(messageId: string): { accepted: boolean; job: Promise<IngestionResult> } {
    const existing = this.activeJobs.get(messageId);
    if (existing) return { accepted: false, job: existing };
    const stored = this.database.captureForProcessing(messageId);
    if (!stored) throw new Error("消息不存在");
    if (!this.database.queueMessageForReprocessing(messageId)) {
      throw new Error("该内容正在处理，无需重复提交");
    }
    const job = this.enqueue(() => this.processExisting(stored.capture))
      .finally(() => this.activeJobs.delete(messageId));
    this.activeJobs.set(messageId, job);
    return { accepted: true, job };
  }

  private async processExisting(capture: CaptureInput): Promise<IngestionResult> {
    const settings = this.database.getAgentSettings(this.config.nanobot);
    const fallback = defaultNote(capture);
    if (!settings.enabled) {
      this.database.updateProcessedNote(capture.id, fallback, "fallback", "智能整理尚未启用");
      this.database.publishMessage(capture.id);
      return { accepted: true, notifyOnFailure: false };
    }
    try {
      const reply = await this.completeWithRetry(capture, settings);
      this.database.publishMessage(capture.id);
      return { accepted: true, reply, notifyOnFailure: settings.notifyOnFailure };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.database.updateProcessedNote(capture.id, fallback, "fallback", detail);
      this.database.publishMessage(capture.id);
      return { accepted: true, agentError: error, notifyOnFailure: settings.notifyOnFailure };
    }
  }

  private isRetryable(error: unknown): boolean {
    const detail = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    return /timeout|abort|fetch failed|socket|ECONN|ENET|EAI_AGAIN|HTTP (408|425|429|5\d\d)|temporar|rate.?limit|网页解析|未生成 Markdown 产物|NanobotOutputError|模型返回的.+格式不完整|未返回文本结果/i.test(detail);
  }

  private async completeWithRetry(
    capture: CaptureInput,
    settings: AgentSettings,
  ): Promise<string | undefined> {
    const extractedWebContent = await this.extractWebContent(capture);
    const maximumAttempts = capture.source.url || capture.captureType === "link" ? 3 : 2;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      this.database.markAgentAttempt(capture.id);
      try {
        return await this.completeWithAgent(capture, settings, extractedWebContent);
      } catch (error) {
        lastError = error;
        if (attempt >= maximumAttempts || !this.isRetryable(error)) throw error;
        logger.warn("Nanobot 处理暂时失败，将自动重试", {
          captureId: capture.id,
          attempt,
          maximumAttempts,
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
    throw lastError;
  }

  private async extractWebContent(capture: CaptureInput): Promise<ExtractedWebContent | undefined> {
    if (capture.source.type !== "web" || !capture.source.url) return undefined;
    try {
      const extracted = await this.webExtractor(capture.source.url);
      if (extracted) {
        logger.info("网页正文已由服务端提取", {
          captureId: capture.id,
          url: capture.source.url,
          images: (extracted.markdown.match(/!\[[^\]]*\]\(/g) || []).length,
        });
      }
      return extracted;
    } catch (error) {
      logger.warn("服务端网页正文提取失败，将由 Nanobot 使用备用解析", {
        captureId: capture.id,
        url: capture.source.url,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async completeWithAgent(
    capture: CaptureInput,
    settings: AgentSettings,
    extractedWebContent?: ExtractedWebContent,
  ): Promise<string | undefined> {
    const processed = await this.nanobot.process(
      capture,
      settings,
      this.database.getEnabledSkills(),
      extractedWebContent ? [extractedWebContent] : [],
      { tenantId: this.database.currentTenantId() || "legacy" },
    );
    const derivedDocuments = extractedWebContent
      ? [extractedWebContent, ...processed.derivedDocuments.filter((document) => document.sourceType !== "web")]
      : processed.derivedDocuments;
    if (
      capture.source.url
      && ["web", "wechat_article"].includes(capture.source.type)
      && derivedDocuments.length === 0
    ) {
      throw new Error("网页解析未生成 Markdown 产物");
    }
    const derivedAttachments = [];
    const assetWarnings: string[] = [];
    for (const document of derivedDocuments) {
      if (document.sourceType === "visualization") {
        derivedAttachments.push(await persistGeneratedVisualization(
          this.config,
          capture.id,
          document,
          this.database.currentTenantId(),
        ));
        continue;
      }
      const bundle = await persistExtractedBundle(
        this.config,
        capture.id,
        document,
        this.database.currentTenantId(),
      );
      derivedAttachments.push(...bundle.attachments);
      assetWarnings.push(...bundle.warnings);
    }
    if (assetWarnings.length) {
      processed.note.warnings = [...new Set([...(processed.note.warnings || []), ...assetWarnings])].slice(0, 10);
    }
    this.database.completeProcessedMessage(capture.id, processed.note, derivedAttachments);
    return processed.reply;
  }
}
