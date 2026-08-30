import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BotManager } from "./bot-manager.js";
import type { CaptureInput } from "./capture.js";
import type { AppConfig } from "./config.js";
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
    const app = createServer(config(directory), database, {} as BotManager, {} as AccountLoginManager);
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
    const exported = await app.inject({ method: "GET", url: "/api/account/export", headers: authorization });
    expect(exported.headers["content-disposition"]).toContain("knowledge-relay-");
    expect(JSON.parse(exported.body)).toMatchObject({ format: "knowledge-relay-personal-export" });

    await app.close();
    database.close();
  });
});
