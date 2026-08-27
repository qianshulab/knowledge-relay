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
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function testConfig(directory: string): AppConfig {
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
      timeoutMs: 30_000,
      processTimeoutMs: 900_000,
    },
    sync: { batchSize: 100 },
    autoAck: false,
    autoAckText: "已收到",
    logLevel: "error",
  };
}

describe("智能图解后台任务", () => {
  it("关闭页面后仍可查询进度，并阻止同一内容被重复提交", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-diagram-job-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    database.createOwner({ displayName: "Owner", password: "test-password" });
    const session = database.createSession(30);
    const bot = database.addBotAccount({
      botToken: "test-token",
      botId: "bot-diagram",
      baseUrl: "https://example.weixin.qq.com/",
      ownerUserId: "wx-1",
      connectedAt: new Date().toISOString(),
    });
    const message: PublicInboundMessage = {
      id: "bot-diagram:article",
      senderId: "wx-1",
      botId: "bot-diagram",
      receivedAt: "2026-08-27T08:00:00.000Z",
      text: "先收集资料，再分析资料，最后保存图解。",
      attachments: [],
    };
    const note = defaultNote(message);
    database.saveMessage(bot.id, "article", message, note);
    database.updateProcessedNote(message.id, {
      ...note,
      title: "资料处理方法",
      summary: "资料处理包含收集、分析和保存三个步骤。",
      keyPoints: ["收集资料", "分析资料", "保存结果"],
    }, "completed");
    database.saveAgentSettings({
      enabled: true,
      baseUrl: "http://127.0.0.1:8900/v1/",
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    });

    let finishGeneration: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finishGeneration = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const bots = { isRunning: () => false } as unknown as BotManager;
    const app = createServer(testConfig(directory), database, bots, {} as AccountLoginManager);
    const headers = { Authorization: `Bearer ${session.token}` };

    const started = await app.inject({ method: "POST", url: `/api/messages/${encodeURIComponent(message.id)}/diagram`, headers, payload: { force: false } });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ status: "generating", generation: { phase: "analyzing" } });

    const reopened = await app.inject({ method: "GET", url: `/api/messages/${encodeURIComponent(message.id)}/diagram`, headers });
    expect(reopened.json()).toMatchObject({ status: "generating", generation: { startedAt: started.json().generation.startedAt } });

    const duplicate = await app.inject({ method: "POST", url: `/api/messages/${encodeURIComponent(message.id)}/diagram`, headers, payload: { force: true } });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json().generation.startedAt).toBe(started.json().generation.startedAt);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const dashboard = await app.inject({ method: "GET", url: "/api/dashboard", headers });
    expect(dashboard.json()).toMatchObject({
      diagramProcessing: 1,
      diagramJobs: [{ messageId: message.id, title: "资料处理方法", phase: "analyzing" }],
    });

    finishGeneration?.(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        diagram_type: "flow",
        diagram_label: "处理流程图",
        selection_reason: "资料包含明确步骤",
        nodes: [
          { id: "root", label: "资料处理", type: "root", role: "start" },
          { id: "analyze", label: "分析资料", type: "point", role: "process" },
          { id: "save", label: "保存结果", type: "point", role: "result" },
        ],
        edges: [
          { source: "root", target: "analyze", label: "下一步", kind: "primary" },
          { source: "analyze", target: "save", label: "下一步", kind: "primary" },
        ],
      }) } }],
    }), { status: 200 }));

    await vi.waitFor(async () => {
      const completed = await app.inject({ method: "GET", url: `/api/messages/${encodeURIComponent(message.id)}/diagram`, headers });
      expect(completed.json()).toMatchObject({ status: "ready", diagram: { diagramType: "flow" } });
    });
    const completedDashboard = await app.inject({ method: "GET", url: "/api/dashboard", headers });
    expect(completedDashboard.json().diagramProcessing).toBe(0);

    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: '{"diagram_type":"flow","nodes":[' } }],
    }), { status: 200 })));
    const fallbackStarted = await app.inject({
      method: "POST",
      url: `/api/messages/${encodeURIComponent(message.id)}/diagram`,
      headers,
      payload: { force: true },
    });
    expect(fallbackStarted.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const fallback = await app.inject({ method: "GET", url: `/api/messages/${encodeURIComponent(message.id)}/diagram`, headers });
      expect(fallback.json()).toMatchObject({
        status: "ready",
        diagram: { selectionReason: expect.stringContaining("稳定图解") },
      });
    }, { timeout: 4_000 });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await app.close();
    database.close();
  });
});
