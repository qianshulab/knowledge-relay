import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.js";
import { NanobotClient } from "./nanobot.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 8787,
  dataDir: "/tmp/nanobot-test",
  sessionDays: 30,
  ilink: {
    apiBaseUrl: "https://ilinkai.weixin.qq.com/",
    cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c/",
    appId: "bot",
    botAgent: "WechatInbox/1.0.0",
    longPollMs: 35_000,
    maxMediaBytes: 1024,
    allowFrom: [],
  },
  webhook: { timeoutMs: 30_000 },
  nanobot: { baseUrl: "http://127.0.0.1:8900/v1/", model: "", timeoutMs: 30_000 },
  webFetch: { allowBenchmarkNetwork: false },
  sync: { batchSize: 100 },
  autoAck: false,
  autoAckText: "ok",
  logLevel: "info",
};

afterEach(() => vi.unstubAllGlobals());

describe("NanobotClient", () => {
  it("默认省略 model，并使用个人收件箱 session_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify({ title: "测试", content: "内容", tags: [] }) } },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new NanobotClient(config);
    await client.process(
      {
        id: "bot:1",
        senderId: "sender",
        botId: "bot",
        receivedAt: new Date().toISOString(),
        text: "hello",
        attachments: [],
      },
      {
        enabled: true,
        baseUrl: config.nanobot.baseUrl,
        model: "",
        instructions: "",
        autoReply: false,
        notifyOnFailure: true,
      },
      [
        {
          id: "builtin:test",
          slug: "test",
          name: "测试 Skill",
          description: "用于测试",
          content: "必须保留原始内容。",
          builtin: true,
          enabled: true,
          customized: false,
          kind: "prompt",
        },
      ],
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.model).toBeUndefined();
    expect(body.session_id).toBe("knowledge-relay:inbox");
    expect(body.messages[0].content).toContain("【Skill: 测试 Skill】");
  });

  it("连接测试调用 completion 而不是只检查 models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new NanobotClient(config);
    await expect(
      client.health({
        enabled: true,
        baseUrl: config.nanobot.baseUrl,
        model: "",
        instructions: "",
        autoReply: false,
        notifyOnFailure: true,
      }),
    ).resolves.toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/chat/completions");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
  });
});
