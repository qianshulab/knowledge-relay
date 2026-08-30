import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotManager } from "./bot-manager.js";
import type { AppConfig } from "./config.js";
import type { AccountLoginManager } from "./ilink/account-login-manager.js";
import type { PublicInboundMessage } from "./messages.js";
import { defaultNote } from "./notes.js";
import { createServer } from "./server.js";
import { AppDatabase } from "./storage/database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

describe("收件箱 AI 检索链路", () => {
  it("先让 Nanobot 理解需求，再按受限计划匹配本地收件索引", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-search-test-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    database.createOwner({ displayName: "Owner", password: "test-password" });
    const session = database.createSession(30);
    const bot = database.addBotAccount({
      botToken: "test-token",
      botId: "bot-1",
      baseUrl: "https://example.weixin.qq.com/",
      ownerUserId: "wx-1",
      connectedAt: new Date().toISOString(),
    });
    const message: PublicInboundMessage = {
      id: "bot-1:nas-article",
      senderId: "wx-1",
      botId: "bot-1",
      receivedAt: "2026-08-13T12:00:00.000Z",
      text: "这篇内容讨论 NAS、冷数据归档和家庭存储。",
      attachments: [],
    };
    const fallback = defaultNote(message);
    database.saveMessage(bot.id, "nas-article", message, fallback);
    database.updateProcessedNote(message.id, {
      ...fallback,
      title: "家庭 NAS 与冷数据归档",
      category: "reference",
      summary: "NAS 适合家庭存储和冷数据归档。",
      domains: ["存储"],
      knowledgePoints: ["冷数据归档"],
      tools: ["NAS"],
    }, "completed");
    database.saveAgentSettings({
      enabled: true,
      baseUrl: "http://127.0.0.1:8900/v1/",
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    });
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
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        queries: ["NAS 冷数据归档", "家庭存储"],
        category: "reference",
        domains: ["存储"],
        knowledge_points: ["冷数据归档"],
        tools: ["NAS"],
        received_after: "",
        received_before: "",
        intent: "查找与 NAS 家庭存储有关的收藏内容",
      }) } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createServer(
      config,
      database,
      {} as BotManager,
      {} as AccountLoginManager,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/inbox/query",
      headers: { Authorization: `Bearer ${session.token}` },
      payload: { question: "我之前收藏过哪些和 NAS 存储有关的内容？", filters: {} },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mode: "nanobot_planned_search",
      interpretation: "查找与 NAS 家庭存储有关的收藏内容",
      resultCount: 1,
      matches: [expect.objectContaining({
        id: message.id,
        relevance: 100,
        matchReasons: expect.arrayContaining([expect.stringContaining("主题")]),
      })],
      retrieval: expect.objectContaining({ queries: expect.arrayContaining(["NAS 冷数据归档"]) }),
    });
    const inboxOnlyResponse = await app.inject({
      method: "POST",
      url: "/api/inbox/query",
      headers: { Authorization: `Bearer ${session.token}` },
      payload: {
        question: "我之前收藏过哪些和 NAS 存储有关的内容？",
        filters: { scope: "inbox" },
      },
    });
    expect(inboxOnlyResponse.statusCode).toBe(200);
    expect(inboxOnlyResponse.json().matches).toEqual([]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:8902/v1/chat/completions");

    await app.close();
    database.close();
  });

  it("围绕已整理收藏持续问答并持久保存可点击的资料依据", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-chat-test-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    database.createOwner({ displayName: "Owner", password: "test-password" });
    const session = database.createSession(30);
    const bot = database.addBotAccount({
      botToken: "test-token",
      botId: "bot-chat",
      baseUrl: "https://example.weixin.qq.com/",
      ownerUserId: "wx-chat",
      connectedAt: new Date().toISOString(),
    });
    const message: PublicInboundMessage = {
      id: "bot-chat:backup-article",
      senderId: "wx-chat",
      botId: "bot-chat",
      receivedAt: "2026-08-13T12:00:00.000Z",
      text: "家庭 NAS 应采用 3-2-1 备份，并为冷数据保留离线副本。",
      attachments: [],
    };
    const fallback = defaultNote(message);
    database.saveMessage(bot.id, "backup-article", message, fallback);
    database.updateProcessedNote(message.id, {
      ...fallback,
      title: "家庭 NAS 的 3-2-1 备份",
      category: "reference",
      summary: "家庭 NAS 应采用 3-2-1 备份并保留离线副本。",
      domains: ["数据存储"],
      knowledgePoints: ["3-2-1 备份"],
      tools: ["NAS"],
    }, "completed");
    database.saveAgentSettings({
      enabled: true,
      baseUrl: "http://127.0.0.1:8900/v1/",
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    });
    const testConfig: AppConfig = {
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
        allowFrom: ["wx-chat"],
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
        processTimeoutMs: 1_000,
        processMaxTimeoutMs: 5_000,
      },
      sync: { batchSize: 100 },
      autoAck: false,
      autoAckText: "已收到",
      logLevel: "error",
    };
    const fetchMock = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      const content = url.includes(":8902/")
        ? JSON.stringify({
          queries: ["NAS 3-2-1 备份"],
          category: "reference",
          domains: ["数据存储"],
          knowledge_points: ["3-2-1 备份"],
          tools: ["NAS"],
          received_after: "",
          received_before: "",
          intent: "归纳收藏中的 NAS 备份建议",
        })
        : JSON.stringify({
          answer: "收藏资料建议采用 3-2-1 备份，并保留离线副本。[S1]",
          cited_source_ids: [message.id],
          follow_up_questions: ["离线副本解决了什么风险？"],
        });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = createServer(testConfig, database, {} as BotManager, {} as AccountLoginManager);
    const authorization = { Authorization: `Bearer ${session.token}` };
    const created = await app.inject({ method: "POST", url: "/api/knowledge/chats", headers: authorization, payload: {} });
    const conversationId = created.json().conversation.id;
    const answer = await app.inject({
      method: "POST",
      url: `/api/knowledge/chats/${conversationId}/messages`,
      headers: authorization,
      payload: { question: "我的收藏对家庭 NAS 备份有什么建议？" },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({
      message: {
        role: "assistant",
        content: expect.stringContaining("3-2-1"),
        citations: [{ messageId: message.id, title: "家庭 NAS 的 3-2-1 备份" }],
      },
      followUps: ["离线副本解决了什么风险？"],
    });
    const stored = await app.inject({
      method: "GET",
      url: `/api/knowledge/chats/${conversationId}`,
      headers: authorization,
    });
    expect(stored.json().conversation).toMatchObject({
      title: expect.stringContaining("家庭 NAS"),
      messageCount: 2,
      messages: [
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "assistant", citations: [expect.objectContaining({ messageId: message.id })] }),
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const streamed = await app.inject({
      method: "POST",
      url: `/api/knowledge/chats/${conversationId}/messages/stream`,
      headers: authorization,
      payload: { question: "那离线副本呢？" },
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.headers["content-type"]).toContain("application/x-ndjson");
    expect(streamed.headers["x-accel-buffering"]).toBe("no");
    const events = streamed.body.trim().split("\n").map((line) => JSON.parse(line) as { type: string; content?: string });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "status" }),
      expect.objectContaining({ type: "delta", content: expect.stringContaining("3-2-1") }),
      expect.objectContaining({ type: "done" }),
    ]));
    const afterStream = await app.inject({
      method: "GET",
      url: `/api/knowledge/chats/${conversationId}`,
      headers: authorization,
    });
    expect(afterStream.json().conversation.messageCount).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await app.close();
    database.close();
  });
});
