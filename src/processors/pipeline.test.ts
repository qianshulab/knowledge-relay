import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import type { InboundMessage } from "../messages.js";
import { processMessage } from "./pipeline.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 8787,
  dataDir: "/tmp/ilink-test",
  sessionDays: 30,
  ilink: {
    apiBaseUrl: "https://ilinkai.weixin.qq.com/",
    cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c/",
    appId: "bot",
    botAgent: "WechatInbox/0.1.0",
    longPollMs: 35_000,
    maxMediaBytes: 1024,
    allowFrom: [],
  },
  webhook: { timeoutMs: 30_000 },
  nanobot: {
    baseUrl: "http://127.0.0.1:8900/v1/",
    model: "",
    timeoutMs: 120_000,
  },
  webFetch: { allowBenchmarkNetwork: false },
  sync: { batchSize: 100 },
  autoAck: false,
  autoAckText: "已收到并保存。",
  logLevel: "info",
};

const message: InboundMessage = {
  id: "bot-1:message-1",
  senderId: "owner-1",
  botId: "bot-1",
  receivedAt: new Date().toISOString(),
  text: "/ping",
  attachments: [],
  contextToken: "do-not-leak",
};

afterEach(() => vi.unstubAllGlobals());

describe("processMessage", () => {
  it("优先执行本地命令处理器", async () => {
    await expect(processMessage(message, config)).resolves.toEqual({
      handled: true,
      reply: "pong",
    });
  });

  it("Webhook 请求不包含 contextToken", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ reply: "done" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const webhookConfig: AppConfig = {
      ...config,
      webhook: { ...config.webhook, url: "http://127.0.0.1:9000/messages" },
    };

    const result = await processMessage({ ...message, text: "普通消息" }, webhookConfig);

    expect(result.reply).toBe("done");
    const body = String((fetchMock.mock.calls[0]?.[1] as RequestInit).body);
    expect(body).not.toContain("contextToken");
    expect(body).not.toContain("do-not-leak");
  });
});
