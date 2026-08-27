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
    processTimeoutMs: 900_000,
  },
  sync: { batchSize: 100 },
  autoAck: false,
  autoAckText: "ok",
  logLevel: "info",
};

afterEach(() => vi.unstubAllGlobals());

describe("NanobotClient", () => {
  it("智能图解按需交给 Nanobot 选择图形并返回可持久化结构", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        diagram_type: "flow",
        diagram_label: "处理流程图",
        selection_reason: "资料包含明确步骤",
        nodes: [
          { id: "root", label: "资料处理", type: "root" },
          { id: "collect", label: "收集资料", type: "point", description: "汇集输入资料", evidence: "先收集资料", group: "准备" },
          { id: "analyze", label: "分析资料", type: "point", description: "分析已有资料", evidence: "再分析资料", group: "处理" },
        ],
        edges: [
          { source: "root", target: "collect", label: "第一步", kind: "primary" },
          { source: "collect", target: "analyze", label: "下一步", kind: "primary" },
        ],
      }) } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new NanobotClient(config);
    const result = await client.generateKnowledgeDiagram({
      id: "diagram-message",
      title: "资料处理方法",
      summary: "先收集资料，再分析资料。",
      keyPoints: ["先收集资料", "收集完成后进行分析"],
      knowledgePoints: ["资料收集", "资料分析"],
      domains: ["知识管理"],
      tools: [],
      detailsMarkdown: "## 步骤\n1. 收集资料\n2. 分析资料",
      contentMarkdown: "完整正文",
      text: "资料处理方法",
    } as never, {
      enabled: true,
      baseUrl: config.nanobot.baseUrl,
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    }, [{
      id: "builtin:mermaid-visualizer",
      slug: "mermaid-visualizer",
      name: "Mermaid Visualizer",
      description: "选择合适的图形",
      content: "由 Runtime 读取",
      builtin: true,
      enabled: true,
      customized: false,
      kind: "adapter",
    }], { tenantId: "tenant-one" });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.messages[0].content).toContain("先读取 workspace 中 mermaid-visualizer/SKILL.md");
    expect(body.messages[0].content).toContain("只有明确的中心主题—分支—子概念层级才用 mindmap");
    expect(body.messages[0].content).toContain("description、evidence、group");
    expect(result).toMatchObject({ diagramType: "flow", diagramLabel: "处理流程图", nodes: expect.arrayContaining([expect.objectContaining({ label: "收集资料", description: "汇集输入资料", group: "准备" })]) });
    expect(result.edges).toHaveLength(2);
  });

  it("智能图解 JSON 被截断时使用精简上下文自动重试", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '{"diagram_type":"flow","nodes":[' } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          diagram_type: "flow",
          diagram_label: "恢复后的流程图",
          selection_reason: "资料包含明确步骤",
          nodes: [
            { id: "root", label: "资料处理", type: "root" },
            { id: "done", label: "完成处理", type: "point" },
          ],
          edges: [{ source: "root", target: "done", label: "下一步", kind: "primary" }],
        }) } }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();
    const client = new NanobotClient(config);
    const result = await client.generateKnowledgeDiagram({
      id: "diagram-retry",
      title: "资料处理方法",
      summary: "先处理资料，再保存结果。",
      keyPoints: ["处理资料", "保存结果"],
      knowledgePoints: ["资料处理"],
      domains: ["知识管理"],
      tools: [],
      detailsMarkdown: "处理资料后保存结果。",
      contentMarkdown: "完整正文",
      text: "资料处理方法",
    } as never, {
      enabled: true,
      baseUrl: config.nanobot.baseUrl,
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    }, [], { tenantId: "tenant-one", onRetry });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(2, 3, expect.any(Error));
    const retryBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(retryBody.messages[0].content).toContain("结构化输出自动修复重试");
    expect(retryBody.messages[0].content).toContain("nodes 最多 18 个");
    expect(result).toMatchObject({ diagramType: "flow", diagramLabel: "恢复后的流程图" });
  });

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
          description: "TRIGGER：所有内容。SKIP：无。",
          content: "必须保留原始内容。",
          builtin: false,
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
    expect(body.messages[0].content).toContain("这不是明确的可视化请求");
  });

  it("兼容模型在 JSON 结果前后附加说明文字或 Markdown 围栏", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: [
            "已按要求完成整理：",
            "```json",
            JSON.stringify({
              title: "兼容不同模型输出",
              category: "reference",
              summary: "即使模型附加说明，仍提取完整的结构化整理结果。",
              tags: ["模型兼容"],
            }),
            "```",
            "以上为最终结果。",
          ].join("\n"),
        },
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new NanobotClient(config);
    const result = await client.process({
      id: "wrapped-json",
      senderId: "sender",
      botId: "bot",
      receivedAt: new Date().toISOString(),
      text: "测试不同模型的输出格式",
      attachments: [],
    }, {
      enabled: true,
      baseUrl: config.nanobot.baseUrl,
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    });
    expect(result.note).toMatchObject({
      title: "兼容不同模型输出",
      category: "reference",
    });
    expect(result.note.tags).toContain("模型兼容");
  });

  it("微信公众号优先路由专用解析器，并只把通用解析保留为回退", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ title: "微信文章", category: "reference", summary: "已解析正文", tags: [] }) } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new NanobotClient(config);
    const adapters = [
      { slug: "wechat-article-extractor", name: "微信解析", description: "专用解析", content: "runtime", sourceUrl: "https://example.com/wechat" },
      { slug: "fetch-skill", name: "网页解析", description: "通用回退", content: "runtime", sourceUrl: "https://example.com/fetch" },
      { slug: "excalidraw-diagram", name: "Excalidraw", description: "画图", content: "runtime", sourceUrl: "https://example.com/draw" },
    ].map((skill) => ({ id: `builtin:${skill.slug}`, ...skill, builtin: true, enabled: true, customized: false, kind: "adapter" as const }));
    await client.process({
      id: "wechat-route", actorId: "owner", receivedAt: new Date().toISOString(), text: "https://mp.weixin.qq.com/s/example", captureType: "link", attachments: [],
      source: { channel: "wechat", type: "wechat_article", externalId: "example", name: "微信公众号", url: "https://mp.weixin.qq.com/s/example" },
    } as never, { enabled: true, baseUrl: config.nanobot.baseUrl, model: "", instructions: "", autoReply: false, notifyOnFailure: true }, adapters);
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const prompt = String(body.messages[0].content);
    expect(prompt).toContain("wechat-article-extractor、fetch-skill");
    expect(prompt).toContain("专用解析器明确失败时才使用");
    expect(prompt).not.toContain("wechat-article-extractor、fetch-skill、excalidraw-diagram");
  });

  it("明确的 Canvas 请求会路由原版可视化 Skill 并约束产物目录", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ title: "知识画布", tags: [] }) } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new NanobotClient(config);
    await client.process({
      id: "canvas-request",
      senderId: "sender",
      botId: "bot",
      receivedAt: new Date().toISOString(),
      text: "把这条内容整理为可编辑的 Obsidian Canvas 画布",
      attachments: [],
    }, {
      enabled: true,
      baseUrl: config.nanobot.baseUrl,
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    }, [{
      id: "builtin:obsidian-canvas-creator",
      slug: "obsidian-canvas-creator",
      name: "Obsidian Canvas 创建器",
      description: "创建 Canvas",
      content: "完整原版内容由 Runtime 读取。",
      builtin: true,
      enabled: true,
      customized: false,
      kind: "adapter",
    }]);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.messages[0].content).toContain("使用 obsidian-canvas-creator");
    expect(body.messages[0].content).toContain("source_type=visualization");
    expect(body.messages[0].content).toContain("artifacts/");
  });

  it("使用 Nanobot 先理解检索意图并生成受限的本地检索计划", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                queries: ["Frida 动态插桩", "移动安全 动态分析", "Frida 动态插桩"],
                category: "reference",
                domains: ["网络安全"],
                knowledge_points: ["动态插桩"],
                tools: ["Frida"],
                received_after: "",
                received_before: "",
                intent: "查找收藏过的移动安全工具与动态分析资料",
              }),
            },
          }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new NanobotClient(config);
    await expect(client.planInboxQuery("我收藏过哪些安全工具？", {
      enabled: true,
      baseUrl: config.nanobot.baseUrl,
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    }, { tenantId: "search-tenant" })).resolves.toEqual({
      queries: ["Frida 动态插桩", "移动安全 动态分析"],
      category: "reference",
      domains: ["网络安全"],
      knowledgePoints: ["动态插桩"],
      tools: ["Frida"],
      intent: "查找收藏过的移动安全工具与动态分析资料",
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    const tenantKey = crypto.createHash("sha256").update("search-tenant").digest("hex").slice(0, 16);
    expect((request.headers as Record<string, string>)["X-Knowledge-Relay-Tenant"]).toBe(tenantKey);
    expect(body.model).toBeUndefined();
    expect(body.session_id).toMatch(/^knowledge-relay:inbox-search:/);
    expect(body.messages[0].content).toContain("理解用户真正想查找的内容");
    expect(body.messages[0].content).toContain("我收藏过哪些安全工具");
  });

  it("把 Nanobot SSE 中逐步生成的回答内容实时转发给知识问答", async () => {
    const fragments = [
      '{"answer":"收藏资料建议采用 ',
      '3-2-1 备份，并保留离线副本。[S1]",',
      '"cited_source_ids":["source-1"],"follow_up_questions":["离线副本有什么作用？"]}',
    ];
    const body = `${fragments.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("")}data: [DONE]\n\n`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];
    const client = new NanobotClient(config);
    const result = await client.answerKnowledgeQuestion(
      "资料中的 NAS 备份建议是什么？",
      [{
        id: "source-1",
        title: "家庭 NAS 备份",
        summary: "介绍 3-2-1 备份方法",
        content: "采用 3-2-1 备份，并保留一份离线副本。",
        domains: ["数据存储"],
        knowledgePoints: ["3-2-1 备份"],
      }],
      [],
      {
        enabled: true,
        baseUrl: config.nanobot.baseUrl,
        model: "",
        instructions: "",
        autoReply: false,
        notifyOnFailure: true,
      },
      { tenantId: "chat-tenant", conversationId: "chat-one" },
      (delta) => deltas.push(delta),
    );
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ stream: true });
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe(result.answer);
    expect(result).toEqual({
      answer: "收藏资料建议采用 3-2-1 备份，并保留离线副本。[S1]",
      citedSourceIds: ["source-1"],
      followUps: ["离线副本有什么作用？"],
    });
  });

  it("只接收 Nanobot 指定 artifacts 目录中的 Markdown 与可视化产物", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nanobot-artifact-test-"));
    const workspace = path.join(directory, "workspace");
    const runId = crypto.createHash("sha256").update("bot:1").digest("hex").slice(0, 20);
    await fs.mkdir(path.join(workspace, "artifacts", runId), { recursive: true });
    await fs.writeFile(path.join(workspace, "artifacts", runId, "article.md"), "# 原版 Skill 结果\n");
    await fs.writeFile(path.join(workspace, "artifacts", runId, "document.md"), "# 文档解析结果\n");
    const canvas = JSON.stringify({
      nodes: [{ id: "root", type: "text", text: "主题", x: 0, y: 0, width: 240, height: 100 }],
      edges: [],
    });
    await fs.writeFile(path.join(workspace, "artifacts", runId, "knowledge.canvas"), canvas);
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
                }, {
                  path: "document.md",
                  title: "附件文档",
                  source_type: "document",
                }, {
                  path: "knowledge.canvas",
                  title: "知识画布",
                  source_type: "visualization",
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
      expect.objectContaining({
        title: "附件文档",
        sourceType: "document",
        markdown: "# 文档解析结果\n",
      }),
      expect.objectContaining({
        title: "知识画布",
        sourceType: "visualization",
        fileName: "knowledge.canvas",
        mimeType: "application/json",
        content: canvas,
      }),
    ]);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("多用户请求使用独立 Runtime 标识、会话和物理产物目录", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nanobot-tenant-artifact-test-"));
    const workspace = path.join(directory, "workspace");
    const tenantId = "user-tenant-1";
    const tenantKey = crypto.createHash("sha256").update(tenantId).digest("hex").slice(0, 16);
    const runId = crypto.createHash("sha256").update(`${tenantKey}:tenant-message`).digest("hex").slice(0, 20);
    const artifactDirectory = path.join(
      workspace,
      "tenants",
      tenantKey,
      "workspace",
      "artifacts",
      runId,
    );
    await fs.mkdir(artifactDirectory, { recursive: true });
    await fs.writeFile(path.join(artifactDirectory, "article.md"), "# 租户专用产物\n");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        title: "租户文章",
        tags: [],
        derived_files: [{ path: "article.md", title: "租户文章", source_type: "web" }],
      }) } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new NanobotClient({ ...config, nanobot: { ...config.nanobot, workspace } });
    const result = await client.process(
      {
        id: "tenant-message",
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
      [],
      [],
      { tenantId },
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect((request.headers as Record<string, string>)["X-Knowledge-Relay-Tenant"]).toBe(tenantKey);
    expect(body.session_id).toBe(`knowledge-relay:tenant:${tenantKey}:inbox:${runId}`);
    const tenantArtifact = result.derivedDocuments[0];
    expect(tenantArtifact?.sourceType).toBe("web");
    expect(tenantArtifact && tenantArtifact.sourceType !== "visualization" ? tenantArtifact.markdown : "")
      .toContain("租户专用产物");
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
    const result = await client.health({
      enabled: true,
      baseUrl: config.nanobot.baseUrl,
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    });
    expect(result).toMatchObject({ ok: true, stage: "complete" });
    expect(result.runtimeMs).toBeTypeOf("number");
    expect(result.modelMs).toBeTypeOf("number");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/health");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/v1/chat/completions");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe("POST");
  });

  it("连接测试沿用 Runtime 时限并返回可操作的超时提示", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }))
      .mockRejectedValueOnce(timeout);
    vi.stubGlobal("fetch", fetchMock);
    const client = new NanobotClient({
      ...config,
      nanobot: { ...config.nanobot, timeoutMs: 120_000 },
    });

    await expect(client.health({
      enabled: true,
      baseUrl: config.nanobot.baseUrl,
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    })).resolves.toMatchObject({
      ok: false,
      stage: "model",
      error: "模型在 120 秒内没有完成连接测试，请检查模型服务网络与运行日志",
    });
  });

  it("只在 Agent 长时间没有产生新步骤时中止整理", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-idle-"));
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    })));
    const client = new NanobotClient({
      ...config,
      nanobot: {
        ...config.nanobot,
        workspace,
        processTimeoutMs: 120,
        processMaxTimeoutMs: 2_000,
      },
    });

    await expect(client.process({
      id: "bot:stalled-task",
      senderId: "sender",
      botId: "bot",
      receivedAt: new Date().toISOString(),
      text: "https://mp.weixin.qq.com/s/stalled",
      attachments: [],
    }, {
      enabled: true,
      baseUrl: config.nanobot.baseUrl,
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    })).rejects.toThrow("Nanobot 智能整理任务无进展超时");
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("Agent 会话持续产生新步骤时自动续期", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-progress-"));
    const sessions = path.join(workspace, "sessions");
    await fs.mkdir(sessions, { recursive: true });
    const messageId = "bot:progress-task";
    const runId = crypto.createHash("sha256").update(messageId).digest("hex").slice(0, 20);
    const sessionId = `knowledge-relay:inbox:${runId}`;
    const sessionFile = path.join(
      sessions,
      `${Buffer.from(`api:${sessionId}`).toString("base64url")}.jsonl`,
    );
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => {
      setTimeout(() => void fs.appendFile(sessionFile, '{"role":"user"}\n'), 80);
      setTimeout(() => void fs.appendFile(sessionFile, '{"role":"assistant","tool":"read_file"}\n'), 280);
      setTimeout(() => void fs.appendFile(sessionFile, '{"role":"tool","name":"exec"}\n'), 480);
      setTimeout(() => resolve(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ title: "持续整理成功", summary: "有效进展会自动续期。" }) } }],
      }), { status: 200 })), 620);
    })));
    const client = new NanobotClient({
      ...config,
      nanobot: {
        ...config.nanobot,
        workspace,
        processTimeoutMs: 250,
        processMaxTimeoutMs: 2_000,
      },
    });

    await expect(client.process({
      id: messageId,
      senderId: "sender",
      botId: "bot",
      receivedAt: new Date().toISOString(),
      text: "请持续处理",
      attachments: [],
    }, {
      enabled: true,
      baseUrl: config.nanobot.baseUrl,
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    })).resolves.toMatchObject({ note: { title: "持续整理成功" } });
    await fs.rm(workspace, { recursive: true, force: true });
  });
});
