import type { AppConfig } from "./config.js";
import type { CaptureInput } from "./capture.js";
import { logger } from "./logger.js";
import { NanobotClient } from "./nanobot.js";
import { defaultNote } from "./notes.js";
import type { AgentSettings, AppDatabase } from "./storage/database.js";
import { persistExtractedMarkdown } from "./web-content.js";

export type IngestionResult = {
  accepted: boolean;
  reply?: string;
  agentError?: unknown;
  notifyOnFailure: boolean;
};

export type CaptureAgent = Pick<NanobotClient, "process">;

/**
 * Channel-neutral capture pipeline. Adapters own authentication, transport,
 * attachment acquisition and replies; this service owns durable ingestion,
 * enrichment and sync publication.
 */
export class IngestionService {
  private readonly nanobot: CaptureAgent;

  constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
    nanobot?: CaptureAgent,
  ) {
    this.nanobot = nanobot || new NanobotClient(config);
  }

  async ingest(capture: CaptureInput): Promise<IngestionResult> {
    const fallback = defaultNote(capture);
    if (!this.database.saveCapture(capture, fallback)) {
      return { accepted: false, notifyOnFailure: false };
    }
    // Persist the raw revision immediately for recovery and audit. Sync batches
    // expose only the later enriched/fallback revision, so clients never create
    // a note from a temporary generic title while the Agent is still working.
    this.database.publishMessage(capture.id);
    const settings = this.database.getAgentSettings(this.config.nanobot);
    if (!settings.enabled) {
      this.database.updateProcessedNote(capture.id, fallback, "fallback");
      this.database.publishMessage(capture.id);
      return { accepted: true, notifyOnFailure: false };
    }
    try {
      const reply = await this.completeWithAgent(capture, settings);
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
          if (settings.enabled) await this.completeWithAgent(capture, settings);
          else this.database.updateProcessedNote(capture.id, fallback, "fallback");
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

  private async completeWithAgent(
    capture: CaptureInput,
    settings: AgentSettings,
  ): Promise<string | undefined> {
    const processed = await this.nanobot.process(
      capture,
      settings,
      this.database.getEnabledSkills(),
    );
    const derivedAttachments = [];
    for (const document of processed.derivedDocuments) {
      derivedAttachments.push(await persistExtractedMarkdown(this.config, capture.id, document));
    }
    this.database.completeProcessedMessage(capture.id, processed.note, derivedAttachments);
    return processed.reply;
  }
}
