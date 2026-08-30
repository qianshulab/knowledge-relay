import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotManager } from "./bot-manager.js";
import type { CaptureInput } from "./capture.js";
import type { AppConfig } from "./config.js";
import type { FeedSourceManager } from "./feed-source-manager.js";
import type { AccountLoginManager } from "./ilink/account-login-manager.js";
import { defaultNote } from "./notes.js";
import { createServer } from "./server.js";
import { AppDatabase } from "./storage/database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function config(directory: string): AppConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    dataDir: directory,
    sessionDays: 30,
    ilink: {
      apiBaseUrl: "https://example.weixin.qq.com/",
      cdnBaseUrl: "https://example.weixin.qq.com/",
      appId: "bot",
      botAgent: "test",
      longPollMs: 1_000,
      maxMediaBytes: 1_024,
      allowFrom: [],
    },
    webhook: { timeoutMs: 1_000 },
    nanobot: {
      baseUrl: "http://127.0.0.1:8900/v1/",
      searchBaseUrl: "http://127.0.0.1:8902/v1/",
      model: "",
      configPath: path.join(directory, "nanobot", "config.json"),
      workspace: path.join(directory, "nanobot", "workspace"),
      managed: true,
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

describe("个人知识工作流 API", () => {
  it("持久化标注、集合和回顾状态，并提供质量与导出接口", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-workflow-api-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    const owner = database.createOwner({ displayName: "Owner", password: "test-password" });
    const scoped = database.forTenant(owner.id);
    const session = scoped.createSession(30);
    const capture: CaptureInput = {
      id: "api:workflow-resource",
      source: { channel: "api", type: "api" as const, externalId: "workflow-resource", connectionId: "test", name: "测试" },
      captureType: "text" as const,
      actorId: "tester",
      receivedAt: "2026-08-01T00:00:00.000Z",
      text: "定期回顾可以避免收藏内容被遗忘。",
      attachments: [],
    };
    scoped.saveCapture(capture, defaultNote(capture));
    scoped.updateProcessedNote(capture.id, {
      ...defaultNote(capture),
      title: "定期回顾知识",
      summary: "通过回顾重新激活收藏内容。",
      domains: ["知识管理"],
    }, "completed");
    scoped.publishMessage(capture.id);
    const firstRevision = scoped.getMessage(capture.id)!.revision;
    scoped.updateProcessedNote(capture.id, {
      ...defaultNote(capture),
      title: "定期回顾知识（新版）",
      summary: "新版回顾摘要。",
      domains: ["知识管理"],
    }, "completed");
    scoped.publishMessage(capture.id);
    const refreshFeed = vi.fn(async () => ({ accepted: 0, discovered: 0 }));
    const app = createServer(
      config(directory),
      database,
      {} as BotManager,
      {} as AccountLoginManager,
      undefined,
      { refresh: refreshFeed } as unknown as FeedSourceManager,
    );
    const authorization = { Authorization: `Bearer ${session.token}` };

    const annotation = await app.inject({ method: "POST", url: `/api/messages/${encodeURIComponent(capture.id)}/annotations`, headers: authorization, payload: { quote: "定期回顾", note: "每周执行", color: "amber" } });
    expect(annotation.statusCode).toBe(201);
    expect(annotation.json().annotation).toMatchObject({ quote: "定期回顾", note: "每周执行", color: "amber" });
    const collection = await app.inject({ method: "POST", url: "/api/collections", headers: authorization, payload: { name: "知识管理", rules: { domain: "知识管理", unread: true } } });
    expect(collection.statusCode).toBe(201);
    expect(collection.json().collection).toMatchObject({ name: "知识管理", itemCount: 1 });
    const review = await app.inject({ method: "GET", url: "/api/review", headers: authorization });
    expect(review.json().suggestions).toEqual(expect.arrayContaining([expect.objectContaining({ id: capture.id })]));
    const reviewed = await app.inject({ method: "POST", url: `/api/review/${encodeURIComponent(capture.id)}`, headers: authorization, payload: { action: "reviewed" } });
    expect(reviewed.json().snoozeUntil).toEqual(expect.any(String));
    const afterReview = await app.inject({ method: "GET", url: "/api/review", headers: authorization });
    expect(afterReview.json().suggestions).toEqual([]);
    const quality = await app.inject({ method: "GET", url: "/api/quality/overview", headers: authorization });
    expect(quality.json()).toMatchObject({ total: 1, healthy: 1 });
    const revisions = await app.inject({ method: "GET", url: `/api/messages/${encodeURIComponent(capture.id)}/revisions`, headers: authorization });
    expect(revisions.json().revisions).toHaveLength(2);
    const restored = await app.inject({ method: "POST", url: `/api/messages/${encodeURIComponent(capture.id)}/revisions/${firstRevision}/restore`, headers: authorization });
    expect(restored.json()).toMatchObject({ restoredFrom: firstRevision, message: { title: "定期回顾知识" } });
    const feed = await app.inject({ method: "POST", url: "/api/feed-sources", headers: authorization, payload: { name: "测试订阅", feedUrl: "https://example.com/feed.xml", intervalMinutes: 30 } });
    expect(feed.statusCode).toBe(201);
    expect(feed.json().source).toMatchObject({ name: "测试订阅", enabled: true });
    const feedList = await app.inject({ method: "GET", url: "/api/feed-sources", headers: authorization });
    expect(feedList.json().sources).toHaveLength(1);
    const feedCheck = await app.inject({ method: "POST", url: `/api/feed-sources/${feed.json().source.id}/check`, headers: authorization });
    expect(feedCheck.statusCode).toBe(202);
    expect(feedCheck.json()).toMatchObject({ sourceId: feed.json().source.id, accepted: true });
    expect(refreshFeed).toHaveBeenCalledTimes(2);
    const exported = await app.inject({ method: "GET", url: "/api/account/export", headers: authorization });
    expect(exported.headers["content-disposition"]).toContain("knowledge-relay-");
    expect(JSON.parse(exported.body)).toMatchObject({ format: "knowledge-relay-personal-export" });

    await app.close();
    database.close();
  });

  it("accepts browser document uploads into the same tenant ingestion pipeline", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-upload-api-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    const owner = database.createOwner({ displayName: "Owner", password: "test-password" });
    const session = database.createSessionFor(owner.id, 30);
    const acceptCapture = vi.fn().mockReturnValue({ accepted: true });
    const app = createServer(config(directory), database, { acceptCapture } as unknown as BotManager, {} as AccountLoginManager);
    const boundary = "----knowledge-relay-upload";
    const payload = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="note"',
      "",
      "重点整理部署步骤",
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="guide.md"',
      "Content-Type: text/markdown",
      "",
      "# 部署指南\n\n使用 Docker Compose 部署。",
      `--${boundary}--`,
      "",
    ].join("\r\n"));

    const response = await app.inject({
      method: "POST",
      url: "/api/captures/upload",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(202);
    expect(acceptCapture).toHaveBeenCalledWith(owner.id, expect.objectContaining({
      text: "重点整理部署步骤",
      captureType: "mixed",
      attachments: [expect.objectContaining({ fileName: "guide.md", mimeType: "text/markdown" })],
    }));
    const capture = acceptCapture.mock.calls[0]?.[1] as CaptureInput;
    await expect(fs.readFile(capture.attachments[0]!.path, "utf8")).resolves.toContain("Docker Compose");

    await app.close();
    database.close();
  });
});
