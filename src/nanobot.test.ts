import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

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
  nanobot: {
    baseUrl: "http://127.0.0.1:8900/v1/",
    model: "",
    configPath: "/tmp/nanobot-test/config.json",
    workspace: "/tmp/nanobot-test/workspace",
    managed: true,
    autoReload: true,
    timeoutMs: 30_000,
  },
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
            { message: { content: JSON.stringify({ title: "测试", summary: "内容摘要", tags: [] }) } },
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
    expect(body.session_id).toMatch(/^knowledge-relay:inbox:[a-f0-9]{20}$/);
    expect(body.messages[0].content).toContain("【Skill: 测试 Skill】");
  });

  it("只接收 Nanobot 指定 artifacts 目录中的派生 Markdown", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nanobot-artifact-test-"));
    const workspace = path.join(directory, "workspace");
    const runId = crypto.createHash("sha256").update("bot:1").digest("hex").slice(0, 20);
    await fs.mkdir(path.join(workspace, "artifacts", runId), { recursive: true });
    await fs.writeFile(path.join(workspace, "artifacts", runId, "article.md"), "# 原版 Skill 结果\n");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                title: "测试",
                summary: "内容摘要",
                tags: [],
                derived_files: [{
                  path: "article.md",
                  title: "文章",
                  url: "https://mp.weixin.qq.com/s/test",
                  source_type: "webpage",
                }, { path: "missing.md", title: "不存在的文件" }],
              }),
            },
          }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new NanobotClient({
      ...config,
      nanobot: { ...config.nanobot, workspace },
    });
    const result = await client.process(
      {
        id: "bot:1",
        senderId: "sender",
        botId: "bot",
        receivedAt: new Date().toISOString(),
        text: "https://mp.weixin.qq.com/s/test",
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
    );
    expect(result.derivedDocuments).toEqual([
      expect.objectContaining({
        title: "文章",
        sourceType: "wechat",
        markdown: "# 原版 Skill 结果\n",
      }),
    ]);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("拒绝把模型供应商或任意远程地址当作 Nanobot Runtime", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new NanobotClient(config);
    await expect(
      client.process(
        {
          id: "bot:remote",
          senderId: "sender",
          botId: "bot",
          receivedAt: new Date().toISOString(),
          text: "hello",
          attachments: [],
        },
        {
          enabled: true,
          baseUrl: "https://api.deepseek.com/v1/",
          model: "",
          instructions: "",
          autoReply: false,
          notifyOnFailure: true,
        },
      ),
    ).rejects.toThrow("只允许连接本机 Nanobot");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("连接测试调用 completion 而不是只检查 models", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }))
      .mockResolvedValueOnce(
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
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/health");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/v1/chat/completions");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe("POST");
  });
});
