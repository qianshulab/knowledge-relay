import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BotManager } from "./bot-manager.js";
import type { CaptureInput } from "./capture.js";
import type { AppConfig } from "./config.js";
import type { PublicInboundMessage } from "./messages.js";
import { defaultNote } from "./notes.js";
import { AppDatabase } from "./storage/database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

describe("BotManager interrupted work recovery", () => {
  it("reprocesses an orphaned pending message and publishes the enriched revision", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-recovery-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    const owner = database.createOwner({ displayName: "Owner", password: "test-password" });
    const bot = database.addBotAccount({
      botToken: "secret",
      botId: "bot-1",
      baseUrl: "https://example.weixin.qq.com/",
      ownerUserId: "wx-1",
      connectedAt: new Date().toISOString(),
    });
    const message: PublicInboundMessage = {
      id: "bot-1:interrupted",
      senderId: "wx-1",
      botId: "bot-1",
      receivedAt: "2026-08-13T01:02:03.000Z",
      text: "需要恢复处理的消息",
      attachments: [],
    };
    database.saveMessage(bot.id, "interrupted", message, defaultNote(message));

    const config: AppConfig = {
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
        allowFrom: ["wx-1"],
      },
      webhook: { timeoutMs: 1_000 },
      nanobot: {
        baseUrl: "http://127.0.0.1:8900/v1/",
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
    database.saveAgentSettings({
      enabled: true,
      baseUrl: config.nanobot.baseUrl,
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    });
    const invitation = database.createInvitation();
    const apiOnlyUser = database.registerWithInvitation({
      token: invitation.token,
      username: "api-only",
      displayName: "API User",
      password: "test-password",
    });
    const apiOnlyDatabase = database.forTenant(apiOnlyUser.id);
    apiOnlyDatabase.saveAgentSettings({
      enabled: true,
      baseUrl: config.nanobot.baseUrl,
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    });
    const apiCapture: CaptureInput = {
      id: "api:interrupted",
      source: {
        channel: "api",
        type: "manual",
        externalId: "api-interrupted",
        connectionId: "capture-api",
        name: "API",
      },
      captureType: "text",
      actorId: "api-user",
      receivedAt: "2026-08-13T01:03:03.000Z",
      text: "没有微信连接的用户也需要恢复",
      attachments: [],
    };
    apiOnlyDatabase.saveCapture(apiCapture, defaultNote(apiCapture));
    const process = vi.fn().mockResolvedValue({
      note: {
        title: "恢复后的智能笔记",
        category: "reference",
        tags: ["恢复"],
        markdown: "# 恢复后的智能笔记\n\n任务已恢复。",
      },
      derivedDocuments: [],
    });
    const manager = new BotManager(config, database);
    const timeoutAlert = Reflect.apply(
      Reflect.get(manager, "agentFailureMessage") as (...args: unknown[]) => unknown,
      manager,
      [new Error("Nanobot 智能整理任务处理超时：900 秒内未完成")],
    ) as { message: string };
    expect(timeoutAlert.message).toContain("智能整理任务处理超时");
    expect(timeoutAlert.message).toContain("基础模型连接可能仍然正常");
    const ingestion = Reflect.apply(
      Reflect.get(manager, "ingestionFor") as (...args: unknown[]) => unknown,
      manager,
      [owner.id],
    ) as object;
    Reflect.set(ingestion, "nanobot", { process });
    const apiIngestion = Reflect.apply(
      Reflect.get(manager, "ingestionFor") as (...args: unknown[]) => unknown,
      manager,
      [apiOnlyUser.id],
    ) as object;
    Reflect.set(apiIngestion, "nanobot", { process });

    await expect(manager.recoverPendingAgentMessages()).resolves.toBe(2);
    expect(process).toHaveBeenCalledTimes(2);
    expect(database.listPendingAgentMessages()).toEqual([]);
    expect(database.getMessage(message.id)).toMatchObject({
      agentStatus: "completed",
      title: "恢复后的智能笔记",
      revision: 2,
    });
    expect(apiOnlyDatabase.listPendingAgentMessages()).toEqual([]);
    expect(apiOnlyDatabase.getMessage(apiCapture.id)).toMatchObject({
      agentStatus: "completed",
      title: "恢复后的智能笔记",
      revision: 2,
    });
    database.close();
  });
});
