import type { AppConfig } from "./config.js";
import type { CaptureInput } from "./capture.js";
import { extractCaptureDocuments, type AttachmentExtractionResult } from "./document-extractor.js";
import { logger } from "./logger.js";
import { NanobotClient } from "./nanobot.js";
import { defaultNote } from "./notes.js";
import { extractPublicWebContent } from "./public-web-extractor.js";
import type { AgentSettings, AppDatabase } from "./storage/database.js";
import { persistExtractedBundle, persistGeneratedVisualization, type DerivedContent, type ExtractedWebContent } from "./web-content.js";

type PreparedContent = AttachmentExtractionResult;

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
    const backgroundJob = this.database.enqueueBackgroundJob({
      type: "ingestion",
      resourceId: capture.id,
      title: fallback.title,
      message: "内容已收到，等待解析",
      maxAttempts: capture.source.url || capture.captureType === "link" ? 3 : 2,
      metadata: { sourceType: capture.source.type, captureType: capture.captureType },
    });
    const job = this.enqueue(() => this.processAccepted(capture, fallback, backgroundJob.id))
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

  private async processAccepted(
    capture: CaptureInput,
    fallback: ReturnType<typeof defaultNote>,
    jobId: string,
  ): Promise<IngestionResult> {
    return this.processCapture(capture, fallback, jobId);
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
        const backgroundJob = this.database.activeBackgroundJob("reprocess", capture.id)
          || this.database.enqueueBackgroundJob({
            type: "ingestion",
            resourceId: capture.id,
            title: fallback.title,
            message: "正在恢复服务中断前的处理任务",
            maxAttempts: capture.source.url || capture.captureType === "link" ? 3 : 2,
          });
        try {
          await this.enqueue(() => this.processCapture(capture, fallback, backgroundJob.id, settings));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.database.updateProcessedNote(capture.id, fallback, "fallback", detail);
          this.database.failBackgroundJob(backgroundJob.id, detail, "恢复任务失败，已保留原始内容");
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
    const fallback = defaultNote(stored.capture);
    const backgroundJob = this.database.enqueueBackgroundJob({
      type: "reprocess",
      resourceId: messageId,
      title: fallback.title,
      message: "重新整理任务已进入队列",
      maxAttempts: stored.capture.source.url || stored.capture.captureType === "link" ? 3 : 2,
    });
    const job = this.enqueue(() => this.processExisting(stored.capture, backgroundJob.id))
      .finally(() => this.activeJobs.delete(messageId));
    this.activeJobs.set(messageId, job);
    return { accepted: true, job };
  }

  private async processExisting(capture: CaptureInput, jobId: string): Promise<IngestionResult> {
    return this.processCapture(capture, defaultNote(capture), jobId);
  }

  private async processCapture(
    capture: CaptureInput,
    fallback: ReturnType<typeof defaultNote>,
    jobId: string,
    configuredSettings?: AgentSettings,
  ): Promise<IngestionResult> {
    const settings = configuredSettings || this.database.getAgentSettings(this.config.nanobot);
    this.database.startBackgroundJob(jobId, "extracting", "正在提取正文、附件与图片");
    let prepared: PreparedContent;
    try {
      prepared = await this.prepareContent(capture, jobId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.database.failBackgroundJob(jobId, detail, "内容提取失败，原始收件仍已保存");
      throw error;
    }
    if (!settings.enabled) {
      this.database.updateBackgroundJob(jobId, {
        phase: "saving",
        progress: 82,
        message: "智能整理未启用，正在保存可阅读原始内容",
      });
      await this.completeWithFallback(capture, fallback, prepared, "智能整理尚未启用");
      this.database.publishMessage(capture.id);
      this.database.finishBackgroundJob(jobId, {
        message: "原始内容已完成保存",
        metadata: { outcome: "fallback", reason: "agent_disabled" },
      });
      return { accepted: true, notifyOnFailure: false };
    }
    try {
      const reply = await this.completeWithRetry(capture, settings, prepared, jobId);
      this.database.publishMessage(capture.id);
      this.database.finishBackgroundJob(jobId, {
        message: "内容已解析、整理并建立检索索引",
        metadata: { outcome: "enriched" },
      });
      return { accepted: true, reply, notifyOnFailure: settings.notifyOnFailure };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        this.database.updateBackgroundJob(jobId, {
          phase: "saving_fallback",
          progress: 86,
          message: "智能整理未完成，正在保存可阅读的稳定版本",
          error: detail,
        });
        await this.completeWithFallback(capture, fallback, prepared, detail);
        this.database.publishMessage(capture.id);
        this.database.finishBackgroundJob(jobId, {
          message: "智能整理未完成，已保留原始内容和解析产物",
          metadata: { outcome: "fallback", error: detail },
        });
      } catch (fallbackError) {
        const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        this.database.failBackgroundJob(jobId, fallbackDetail, "内容保存失败，需要人工重试");
        throw fallbackError;
      }
      logger.warn("Nanobot 处理失败，已使用内置规则", { captureId: capture.id, error: detail });
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
    prepared: PreparedContent,
    jobId: string,
  ): Promise<string | undefined> {
    const maximumAttempts = capture.source.url || capture.captureType === "link" ? 3 : 2;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      this.database.markAgentAttempt(capture.id);
      this.database.updateBackgroundJob(jobId, {
        status: attempt > 1 ? "retrying" : "running",
        phase: "organizing",
        progress: Math.min(72, 36 + attempt * 12),
        message: attempt > 1 ? `正在进行第 ${attempt}/${maximumAttempts} 次整理尝试` : "正在理解内容并生成整理结果",
      });
      try {
        return await this.completeWithAgent(capture, settings, prepared, jobId);
      } catch (error) {
        lastError = error;
        if (attempt >= maximumAttempts || !this.isRetryable(error)) throw error;
        logger.warn("Nanobot 处理暂时失败，将自动重试", {
          captureId: capture.id,
          attempt,
          maximumAttempts,
          error: error instanceof Error ? error.message : String(error),
        });
        this.database.updateBackgroundJob(jobId, {
          status: "retrying",
          phase: "retry_wait",
          progress: Math.min(75, 42 + attempt * 12),
          message: `本次模型调用未完成，${attempt} 秒后自动重试`,
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
    throw lastError;
  }

  private async prepareContent(capture: CaptureInput, jobId?: string): Promise<PreparedContent> {
    const tenantId = this.database.currentTenantId();
    const [web, local] = await Promise.all([
      this.extractWebContent(capture),
      extractCaptureDocuments(this.config, capture, tenantId),
    ]);
    if (jobId) {
      this.database.updateBackgroundJob(jobId, {
        phase: "extracted",
        progress: 32,
        message: `内容提取完成：${(web ? 1 : 0) + local.documents.length} 份正文、${local.assets.length} 个附件`,
        metadata: {
          extractedDocuments: (web ? 1 : 0) + local.documents.length,
          extractedAssets: local.assets.length,
          extractionWarnings: local.warnings.length,
        },
      });
    }
    return {
      documents: [...(web ? [web] : []), ...local.documents],
      assets: local.assets,
      warnings: local.warnings,
    };
  }

  private async persistPreparedContent(capture: CaptureInput, prepared: PreparedContent) {
    const attachments = [...prepared.assets];
    const warnings = [...prepared.warnings];
    for (const document of prepared.documents) {
      const bundle = await persistExtractedBundle(
        this.config,
        capture.id,
        document,
        this.database.currentTenantId(),
      );
      attachments.push(...bundle.attachments);
      warnings.push(...bundle.warnings);
    }
    return { attachments, warnings: [...new Set(warnings)].slice(0, 20) };
  }

  private async completeWithFallback(
    capture: CaptureInput,
    fallback: ReturnType<typeof defaultNote>,
    prepared: PreparedContent,
    error: string,
  ): Promise<void> {
    const persisted = await this.persistPreparedContent(capture, prepared);
    const note = {
      ...fallback,
      warnings: [...new Set([...(fallback.warnings || []), ...persisted.warnings])].slice(0, 20),
    };
    this.database.updateProcessedNote(capture.id, note, "fallback", error);
    this.database.replaceDerivedAttachments(capture.id, persisted.attachments);
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
    prepared: PreparedContent,
    jobId?: string,
  ): Promise<string | undefined> {
    const processed = await this.nanobot.process(
      capture,
      settings,
      this.database.getEnabledSkills(),
      prepared.documents,
      { tenantId: this.database.currentTenantId() || "legacy" },
    );
    const derivedDocuments: DerivedContent[] = [...prepared.documents];
    for (const document of processed.derivedDocuments) {
      if (!derivedDocuments.some((current) => current.sourceType === document.sourceType && current.title === document.title)) {
        derivedDocuments.push(document);
      }
    }
    if (!derivedDocuments.length && capture.attachments.some((attachment) => attachment.mimeType.startsWith("image/"))) {
      const keyPoints = processed.note.keyPoints?.length
        ? `\n\n## 识别要点\n\n${processed.note.keyPoints.map((point) => `- ${point}`).join("\n")}`
        : "";
      derivedDocuments.push({
        url: `https://local.knowledge-relay.invalid/${encodeURIComponent(capture.id)}`,
        title: processed.note.title,
        markdown: `# ${processed.note.title}\n\n${processed.note.summary || "图片内容已完成识别。"}${keyPoints}`,
        sourceType: "document",
      });
    }
    if (
      capture.source.url
      && ["web", "wechat_article"].includes(capture.source.type)
      && derivedDocuments.length === 0
    ) {
      throw new Error("网页解析未生成 Markdown 产物");
    }
    if (jobId) {
      this.database.updateBackgroundJob(jobId, {
        phase: "persisting",
        progress: 82,
        message: "整理结果已生成，正在保存正文、图片和检索索引",
      });
    }
    const derivedAttachments = [...prepared.assets];
    const assetWarnings: string[] = [...prepared.warnings];
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
