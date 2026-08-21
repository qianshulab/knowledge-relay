import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotManager } from "./bot-manager.js";
import type { CaptureInput } from "./capture.js";
import type { AppConfig } from "./config.js";
import type { AccountLoginManager } from "./ilink/account-login-manager.js";
import { IngestionService } from "./ingestion-service.js";
import { createServer } from "./server.js";
import { AppDatabase } from "./storage/database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

function config(dataDir: string): AppConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    dataDir,
    sessionDays: 30,
    ilink: {
      apiBaseUrl: "https://example.weixin.qq.com/",
      cdnBaseUrl: "https://example.weixin.qq.com/",
      appId: "bot",
      botAgent: "test",
      longPollMs: 1_000,
      maxMediaBytes: 1_024 * 1_024,
      allowFrom: [],
    },
    webhook: { timeoutMs: 1_000 },
    nanobot: {
      baseUrl: "http://127.0.0.1:8900/v1/",
      model: "",
      configPath: path.join(dataDir, "nanobot", "config.json"),
      workspace: path.join(dataDir, "nanobot", "workspace"),
      managed: false,
      autoReload: true,
      timeoutMs: 1_000,
      processTimeoutMs: 900_000,
    },
    sync: { batchSize: 100 },
    autoAck: false,
    autoAckText: "已收到",
    logLevel: "error",
  };
}

describe("小范围发布候选主链路", () => {
  it("API 收件经过 AI 整理和派生附件后可由 Obsidian 幂等拉取并确认", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-rc-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    const owner = database.createOwner({
      username: "owner",
      displayName: "Owner",
      password: "test-password",
    });
    const scoped = database.forTenant(owner.id);
    scoped.saveAgentSettings({
      enabled: true,
      baseUrl: "http://127.0.0.1:8900/v1/",
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    });
    const session = database.createSessionFor(owner.id, 30);
    const apiToken = scoped.createApiToken("浏览器扩展");
    const syncTarget = scoped.createSyncTarget({ name: "Main Vault", folder: "Inbox", primary: true });
    const process = vi.fn(async (capture: CaptureInput) => ({
      note: {
        title: "可靠网页解析",
        category: "reference",
        tags: ["网页解析", "稳定性"],
        summary: "介绍可靠网页解析与失败恢复。",
        keyPoints: ["先保存原文，再执行解析"],
        knowledgePoints: ["持久任务"],
        domains: ["知识管理"],
        tools: ["Nanobot"],
        markdown: `# 可靠网页解析\n\n${capture.text}`,
      },
      derivedDocuments: [{
        url: capture.source.url || "",
        title: "网页正文",
        sourceType: "web" as const,
        markdown: "# 网页正文\n\n这是已经解析并保存的正文。",
      }, {
        url: "",
        title: "网页知识图",
        sourceType: "visualization" as const,
        fileName: "knowledge.canvas",
        mimeType: "application/json" as const,
        content: JSON.stringify({
          nodes: [{ id: "root", type: "text", text: "网页知识", x: 0, y: 0, width: 240, height: 100 }],
          edges: [],
        }),
      }],
    }));
    const ingestion = new IngestionService(config(directory), scoped, { process });
    const backgroundJobs: Promise<unknown>[] = [];
    const bots = {
      isRunning: () => false,
      acceptCapture: (tenantId: string, capture: CaptureInput) => {
        expect(tenantId).toBe(owner.id);
        const accepted = ingestion.accept(capture);
        backgroundJobs.push(accepted.job);
        return { accepted: accepted.accepted };
      },
    } as unknown as BotManager;
    const app = createServer(config(directory), database, bots, {} as AccountLoginManager);

    const captured = await app.inject({
      method: "POST",
      url: "/api/captures",
      headers: { Authorization: `Bearer ${apiToken.token}` },
      payload: {
        externalId: "browser-bookmark-1",
        url: "https://example.com/reliable-parsing",
        text: "请保存并整理这篇网页",
        sourceName: "Browser Extension",
      },
    });
    expect(captured.statusCode).toBe(202);
    expect(captured.json()).toMatchObject({ accepted: true, status: "processing" });
    await Promise.all(backgroundJobs);

    const messageId = captured.json().id as string;
    const detail = await app.inject({
      method: "GET",
      url: `/api/messages/${encodeURIComponent(messageId)}`,
      headers: { Authorization: `Bearer ${session.token}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      title: "可靠网页解析",
      agentStatus: "completed",
      agentAttempts: 1,
      contentMarkdown: expect.stringContaining("请保存并整理这篇网页"),
      source: {
        type: "web",
        name: "Browser Extension",
        url: "https://example.com/reliable-parsing",
      },
    });
    expect(detail.json().attachments).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "derived", mimeType: "text/markdown", previewable: true }),
      expect.objectContaining({ kind: "derived", mimeType: "application/json", fileName: expect.stringMatching(/\.canvas$/) }),
    ]));

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/captures",
      headers: { Authorization: `Bearer ${apiToken.token}` },
      payload: {
        externalId: "browser-bookmark-1",
        url: "https://example.com/reliable-parsing",
      },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ accepted: false, duplicate: true, id: messageId });
    expect(process).toHaveBeenCalledTimes(1);

    const pull = await app.inject({
      method: "GET",
      url: "/api/sync/pull?limit=10",
      headers: {
        Authorization: `Bearer ${syncTarget.token}`,
        "X-Knowledge-Relay-Plugin": "1.4.1",
        "X-Knowledge-Relay-Schema": "1.2",
      },
    });
    expect(pull.statusCode).toBe(200);
    expect(pull.json().items).toHaveLength(1);
    expect(pull.json().items[0]).toMatchObject({
      id: messageId,
      title: "可靠网页解析",
      processing: { status: "enriched", processor: "nanobot" },
    });
    expect(pull.json().items[0].attachments).toEqual(expect.arrayContaining([
      expect.objectContaining({ mimeType: "text/markdown" }),
      expect.objectContaining({ mimeType: "application/json", fileName: expect.stringMatching(/\.canvas$/) }),
    ]));
    const markdownAttachment = pull.json().items[0].attachments.find(
      (item: { mimeType: string }) => item.mimeType === "text/markdown",
    );
    const attachmentId = markdownAttachment.id as string;
    const attachment = await app.inject({
      method: "GET",
      url: `/api/sync/attachments/${attachmentId}`,
      headers: { Authorization: `Bearer ${syncTarget.token}` },
    });
    expect(attachment.statusCode).toBe(200);
    expect(attachment.body).toContain("这是已经解析并保存的正文");

    const acknowledged = await app.inject({
      method: "POST",
      url: "/api/sync/ack",
      headers: {
        Authorization: `Bearer ${syncTarget.token}`,
        "X-Knowledge-Relay-Schema": "1.2",
      },
      payload: {
        batchId: pull.json().batchId,
        results: [{ id: messageId, status: "written" }],
      },
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json()).toMatchObject({ ok: true });
    const emptyPull = await app.inject({
      method: "GET",
      url: "/api/sync/pull?limit=10",
      headers: { Authorization: `Bearer ${syncTarget.token}` },
    });
    expect(emptyPull.json().items).toEqual([]);

    await app.close();
    database.close();
  });
});
