import crypto from "node:crypto";

import * as cheerio from "cheerio";

import type { BotManager } from "./bot-manager.js";
import { stableCaptureId, type CaptureInput } from "./capture.js";
import { errorDetails, logger } from "./logger.js";
import type { AppDatabase, FeedSource } from "./storage/database.js";
import { requestPublicHtml } from "./web-assets.js";

type FeedItem = {
  externalId: string;
  title: string;
  url: string;
  excerpt: string;
  publishedAt?: string;
};

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function cleanText(value: string, maximum = 2_000): string {
  const decoded = cheerio.load(`<body>${value}</body>`)("body").text();
  return decoded.replace(/\s+/g, " ").trim().slice(0, maximum);
}

function validDate(value: string): string | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function resolveItemUrl(value: string, feedUrl: string): string | undefined {
  try {
    const url = new URL(value.trim(), feedUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function parseFeed(xml: string, feedUrl: string): FeedItem[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const result: FeedItem[] = [];
  const add = (node: ReturnType<typeof $>, atom: boolean) => {
    const title = cleanText(node.find("title").first().text(), 300) || "未命名订阅内容";
    const rawLink = atom
      ? node.find("link[rel='alternate']").first().attr("href") || node.find("link").first().attr("href") || node.find("link").first().text()
      : node.find("link").first().text() || node.find("link").first().attr("href");
    const url = rawLink ? resolveItemUrl(rawLink, feedUrl) : undefined;
    if (!url) return;
    const externalId = cleanText(node.find(atom ? "id" : "guid").first().text(), 500) || url;
    const excerpt = cleanText(
      node.find(atom ? "content" : "content\\:encoded").first().text()
        || node.find(atom ? "summary" : "description").first().text(),
      2_000,
    );
    const publishedAt = validDate(node.find(atom ? "published" : "pubDate").first().text())
      || validDate(node.find(atom ? "updated" : "dc\\:date").first().text());
    result.push({ externalId, title, url, excerpt, ...(publishedAt ? { publishedAt } : {}) });
  };
  $("item").each((_index, element) => add($(element), false));
  if (!result.length) $("entry").each((_index, element) => add($(element), true));
  const unique = new Map<string, FeedItem>();
  for (const item of result) unique.set(item.externalId || item.url, item);
  return [...unique.values()].slice(0, 50);
}

export class FeedSourceManager {
  private controller?: AbortController;
  private monitor?: Promise<void>;
  private readonly active = new Map<string, Promise<{ accepted: number; discovered: number }>>();

  constructor(
    private readonly database: AppDatabase,
    private readonly bots: BotManager,
  ) {}

  start(): void {
    if (this.monitor) return;
    this.controller = new AbortController();
    this.monitor = this.loop(this.controller.signal).finally(() => {
      this.monitor = undefined;
      this.controller = undefined;
    });
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.monitor;
  }

  refresh(source: FeedSource): Promise<{ accepted: number; discovered: number }> {
    const current = this.active.get(source.id);
    if (current) return current;
    const task = this.poll(source).finally(() => this.active.delete(source.id));
    this.active.set(source.id, task);
    return task;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const sources = this.database.dueFeedSources(20);
      for (const source of sources) {
        if (signal.aborted) return;
        try {
          await this.refresh(source);
        } catch (error) {
          logger.warn("自动来源检查失败", { sourceId: source.id, ...errorDetails(error) });
        }
      }
      await wait(30_000, signal);
    }
  }

  private async poll(source: FeedSource): Promise<{ accepted: number; discovered: number }> {
    const scoped = this.database.forTenant(source.tenantId);
    const job = scoped.enqueueBackgroundJob({
      type: "source_check",
      resourceId: `feed:${source.id}`,
      title: `检查来源：${source.name}`,
      message: "正在读取订阅并检查新内容",
      maxAttempts: 2,
    });
    scoped.startBackgroundJob(job.id, "fetching", "正在连接订阅来源");
    try {
      const response = await requestPublicHtml(source.feedUrl, 0, "feed");
      scoped.updateBackgroundJob(job.id, { phase: "parsing", progress: 38, message: "正在解析 RSS / Atom 条目" });
      const items = parseFeed(response.html, response.url);
      let accepted = 0;
      // A newly added feed should be useful immediately without flooding a
      // personal inbox with years of history. Later checks still consider the
      // full feed window and identity checks keep them incremental.
      const candidates = source.lastCheckedAt ? items : items.slice(0, 10);
      const ordered = [...candidates].reverse();
      for (let index = 0; index < ordered.length; index += 1) {
        const item = ordered[index]!;
        if (scoped.hasFeedEntry(source.id, item.externalId, item.url)) continue;
        const captureSource = {
          channel: "rss" as const,
          type: "rss" as const,
          externalId: item.externalId,
          connectionId: source.id,
          name: source.name,
          url: item.url,
        };
        const capture: CaptureInput = {
          id: stableCaptureId(captureSource),
          source: captureSource,
          captureType: "link",
          actorId: `feed:${source.id}`,
          receivedAt: new Date().toISOString(),
          ...(item.publishedAt ? { sentAt: item.publishedAt } : {}),
          text: [item.title, item.excerpt, item.url].filter(Boolean).join("\n\n"),
          attachments: [],
        };
        if (this.bots.acceptCapture(source.tenantId, capture).accepted) accepted += 1;
        scoped.updateBackgroundJob(job.id, {
          phase: "ingesting",
          progress: Math.min(92, 45 + Math.round((index + 1) / Math.max(1, ordered.length) * 47)),
          message: `已检查 ${index + 1}/${ordered.length} 条，发现 ${accepted} 条新内容`,
        });
      }
      const latest = items.map((item) => item.publishedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
      this.database.markFeedSourceChecked(source.id, { success: true, ...(latest ? { lastItemAt: latest } : {}) });
      scoped.finishBackgroundJob(job.id, {
        message: accepted ? `已接收 ${accepted} 条新内容` : "订阅已是最新，没有发现新内容",
        metadata: { discovered: items.length, accepted },
      });
      return { accepted, discovered: items.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.markFeedSourceChecked(source.id, { success: false, error: message });
      scoped.failBackgroundJob(job.id, message, "订阅检查失败，稍后会自动重试");
      throw error;
    }
  }
}
