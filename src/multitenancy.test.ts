import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotManager } from "./bot-manager.js";
import type { CaptureInput } from "./capture.js";
import type { AppConfig } from "./config.js";
import type { AccountLoginManager } from "./ilink/account-login-manager.js";
import { IngestionService } from "./ingestion-service.js";
import { defaultNote } from "./notes.js";
import { createServer } from "./server.js";
import { AppDatabase, selectKnowledgeDiagram } from "./storage/database.js";

const temporaryDirectories: string[] = [];

describe("内容自适应图形选择", () => {
  const base = {
    title: "测试内容",
    summary: "",
    keyPoints: [] as string[],
    knowledgePoints: [] as string[],
    domains: [] as string[],
    tools: [] as string[],
  };

  it("区分对比、时间、状态、交互、流程与关系内容", () => {
    expect(selectKnowledgeDiagram({
      ...base,
      title: "A 与 B 横向评测",
      summary: "比较成功率与成本差异",
      tools: ["A", "B"],
    }).diagramType).toBe("comparison");
    expect(selectKnowledgeDiagram({
      ...base,
      title: "产品演进时间线",
      keyPoints: ["2022 年立项", "2023 年发布", "2024 年重构"],
    }).diagramType).toBe("timeline");
    expect(selectKnowledgeDiagram({
      ...base,
      title: "任务状态流转",
      summary: "待处理进入处理中，失败后重试并恢复",
    }).diagramType).toBe("state");
    expect(selectKnowledgeDiagram({
      ...base,
      title: "API 认证交互",
      summary: "客户端请求网关，网关调用 Runtime 并返回响应",
      tools: ["Client", "Gateway", "Runtime"],
    }).diagramType).toBe("sequence");
    expect(selectKnowledgeDiagram({
      ...base,
      title: "部署流程",
      keyPoints: ["第一步安装", "然后配置", "随后启动", "最后验收"],
    }).diagramType).toBe("flow");
    expect(selectKnowledgeDiagram({
      ...base,
      title: "智能体工具生态",
      knowledgePoints: ["Agent Loop", "工具调用", "长期记忆"],
      tools: ["Nanobot", "MCP", "Obsidian"],
    }).diagramType).toBe("relationship");
  });
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
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

function capture(id: string, text: string, url?: string): CaptureInput {
  return {
    id,
    source: {
      channel: "api",
      type: url ? "web" : "manual",
      externalId: id,
      connectionId: "test-api",
      name: "Test API",
      ...(url ? { url } : {}),
    },
    captureType: url ? "link" : "text",
    actorId: "test",
    receivedAt: new Date().toISOString(),
    text,
    attachments: [],
  };
}

describe("多用户资源与 Agent 任务边界", () => {
  it("同一服务中的会话、消息、搜索和管理权限互相隔离", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-tenants-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    const admin = database.createOwner({
      username: "admin",
      displayName: "Admin",
      password: "admin-password",
    });
    const invitation = database.forTenant(admin.id).createInvitation();
    const member = database.registerWithInvitation({
      token: invitation.token,
      username: "member",
      displayName: "Member",
      password: "member-password",
    });
    const adminDb = database.forTenant(admin.id);
    const memberDb = database.forTenant(member.id);
    const adminCapture = capture("admin-resource", "管理员的内容");
    const memberCapture = capture("member-resource", "成员的内容");
    adminDb.saveCapture(adminCapture, defaultNote(adminCapture));
    memberDb.saveCapture(memberCapture, defaultNote(memberCapture));
    const adminSession = database.createSessionFor(admin.id, 30);
    const memberSession = database.createSessionFor(member.id, 30);
    const apiToken = memberDb.createApiToken("浏览器收件");
    const syncToken = memberDb.createSyncTarget({
      name: "成员的 Obsidian",
      folder: "Inbox",
      primary: true,
    }).token;
    const acceptCapture = vi.fn((tenantId: string, incoming: CaptureInput) => {
      const scoped = database.forTenant(tenantId);
      scoped.saveCapture(incoming, defaultNote(incoming));
      return { accepted: true };
    });
    const pauseTenant = vi.fn(async () => undefined);
    const resumeTenant = vi.fn(async () => undefined);
    const app = createServer(
      config(directory),
      database,
      { isRunning: () => false, acceptCapture, pauseTenant, resumeTenant } as unknown as BotManager,
      {} as AccountLoginManager,
    );

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, database: true });

    const memberMessages = await app.inject({
      method: "GET",
      url: "/api/messages",
      headers: { Authorization: `Bearer ${memberSession.token}` },
    });
    expect(memberMessages.json().messages.map((item: { id: string }) => item.id)).toEqual(["member-resource"]);
    const crossTenant = await app.inject({
      method: "GET",
      url: "/api/messages/admin-resource",
      headers: { Authorization: `Bearer ${memberSession.token}` },
    });
    expect(crossTenant.statusCode).toBe(404);

    const forbiddenAdmin = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { Authorization: `Bearer ${memberSession.token}` },
    });
    expect(forbiddenAdmin.statusCode).toBe(403);
    const users = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { Authorization: `Bearer ${adminSession.token}` },
    });
    expect(users.statusCode).toBe(200);
    expect(users.json().users).toHaveLength(2);

    const apiCapture = await app.inject({
      method: "POST",
      url: "/api/captures",
      headers: { Authorization: `Bearer ${apiToken.token}` },
      payload: {
        externalId: "browser-1",
        url: "https://example.com/article",
        text: "从浏览器提交的文章",
      },
    });
    expect(apiCapture.statusCode).toBe(202);
    expect(acceptCapture).toHaveBeenCalledWith(member.id, expect.objectContaining({
      source: expect.objectContaining({ channel: "api", type: "web" }),
    }));
    expect(memberDb.getMessage(apiCapture.json().id)?.text).toContain("从浏览器提交");
    expect(adminDb.getMessage(apiCapture.json().id)).toBeUndefined();

    const invalidCapture = await app.inject({
      method: "POST",
      url: "/api/captures",
      headers: { Authorization: `Bearer ${apiToken.token}` },
      payload: { externalId: "invalid-url", url: "not a url" },
    });
    expect(invalidCapture.statusCode).toBe(400);
    expect(invalidCapture.json()).toEqual({ error: "链接格式不正确" });

    const disabled = await app.inject({
      method: "PUT",
      url: `/api/admin/users/${member.id}/status`,
      headers: { Authorization: `Bearer ${adminSession.token}` },
      payload: { disabled: true },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().user.disabled).toBe(true);
    expect(pauseTenant).toHaveBeenCalledWith(member.id);
    const disabledSession = await app.inject({
      method: "GET",
      url: "/api/messages",
      headers: { Authorization: `Bearer ${memberSession.token}` },
    });
    expect(disabledSession.statusCode).toBe(401);
    const disabledApiToken = await app.inject({
      method: "POST",
      url: "/api/captures",
      headers: { Authorization: `Bearer ${apiToken.token}` },
      payload: { externalId: "disabled-user", text: "不应接收" },
    });
    expect(disabledApiToken.statusCode).toBe(401);
    const disabledSyncToken = await app.inject({
      method: "GET",
      url: "/api/sync/pull",
      headers: { Authorization: `Bearer ${syncToken}` },
    });
    expect(disabledSyncToken.statusCode).toBe(401);
    const restored = await app.inject({
      method: "PUT",
      url: `/api/admin/users/${member.id}/status`,
      headers: { Authorization: `Bearer ${adminSession.token}` },
      payload: { disabled: false },
    });
    expect(restored.json().user.disabled).toBe(false);
    expect(resumeTenant).toHaveBeenCalledWith(member.id);

    const sessionBeforeReset = database.createSessionFor(member.id, 30);
    const reset = await app.inject({
      method: "POST",
      url: `/api/admin/users/${member.id}/reset-password`,
      headers: { Authorization: `Bearer ${adminSession.token}` },
      payload: { newPassword: "member-password-new", confirmPassword: "member-password-new" },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().reset).toMatchObject({ username: "member", revokedSessions: 1 });
    const revokedByReset = await app.inject({
      method: "GET",
      url: "/api/messages",
      headers: { Authorization: `Bearer ${sessionBeforeReset.token}` },
    });
    expect(revokedByReset.statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { username: "member", password: "member-password" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { username: "member", password: "member-password-new" } })).statusCode).toBe(200);

    await app.close();
    database.close();
  });

  it("管理员可以创建、查看和撤销一次性用户邀请", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-invitations-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    const admin = database.createOwner({
      username: "admin",
      displayName: "Admin",
      password: "admin-password",
    });
    const adminSession = database.createSessionFor(admin.id, 30);
    const app = createServer(
      config(directory),
      database,
      {
        isRunning: () => false,
        acceptCapture: vi.fn(),
        pauseTenant: vi.fn(async () => undefined),
        resumeTenant: vi.fn(async () => undefined),
      } as unknown as BotManager,
      {} as AccountLoginManager,
    );
    const authorization = { Authorization: `Bearer ${adminSession.token}` };

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: authorization,
      payload: { hours: 24 },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      id: expect.any(String),
      token: expect.stringMatching(/^invite_/),
      expiresAt: expect.any(String),
    });

    const registered = await app.inject({
      method: "POST",
      url: "/api/register",
      payload: {
        inviteToken: created.json().token,
        username: "invited-user",
        displayName: "受邀用户",
        password: "member-password",
      },
    });
    expect(registered.statusCode).toBe(200);
    expect(registered.json().owner).toMatchObject({ username: "invited-user", role: "member" });

    const invitations = await app.inject({
      method: "GET",
      url: "/api/admin/invitations",
      headers: authorization,
    });
    expect(invitations.statusCode).toBe(200);
    expect(invitations.json().invitations[0]).toMatchObject({
      consumed: true,
      revoked: false,
      consumedBy: { username: "invited-user", displayName: "受邀用户" },
    });

    const reused = await app.inject({
      method: "POST",
      url: "/api/register",
      payload: {
        inviteToken: created.json().token,
        username: "second-user",
        displayName: "Second",
        password: "member-password",
      },
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.json()).toEqual({ error: "邀请链接无效或已过期" });

    const second = await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: authorization,
      payload: { hours: 72 },
    });
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/admin/invitations/${second.json().id}`,
      headers: authorization,
    });
    expect(revoked.statusCode).toBe(200);

    const invitationPage = await app.inject({
      method: "GET",
      url: "/api/admin/invitations?limit=1&offset=0&status=all",
      headers: authorization,
    });
    expect(invitationPage.statusCode).toBe(200);
    expect(invitationPage.json()).toMatchObject({
      invitations: [expect.objectContaining({ revoked: true })],
      pagination: { total: 2, limit: 1, offset: 0, hasMore: true },
    });
    const usedInvitations = await app.inject({
      method: "GET",
      url: "/api/admin/invitations?status=used",
      headers: authorization,
    });
    expect(usedInvitations.json()).toMatchObject({
      invitations: [expect.objectContaining({ consumed: true })],
      pagination: { total: 1, hasMore: false },
    });

    const revokedRegistration = await app.inject({
      method: "POST",
      url: "/api/register",
      payload: {
        inviteToken: second.json().token,
        username: "revoked-user",
        displayName: "Revoked",
        password: "member-password",
      },
    });
    expect(revokedRegistration.statusCode).toBe(400);
    expect(revokedRegistration.json()).toEqual({ error: "邀请链接无效或已过期" });

    await app.close();
    database.close();
  });

  it("链接类任务遇到瞬时网络错误会自动重试并记录进度", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-retry-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    const owner = database.createOwner({ displayName: "Owner", password: "test-password" });
    const scoped = database.forTenant(owner.id);
    scoped.saveAgentSettings({
      enabled: true,
      baseUrl: "http://127.0.0.1:8900/v1/",
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    });
    const item = capture("retry-link", "https://example.com/article", "https://example.com/article");
    const process = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue({
        note: { ...defaultNote(item), title: "重试后的文章" },
        derivedDocuments: [{
          url: "https://example.com/article",
          title: "重试后的文章",
          sourceType: "web",
          markdown: "# 重试后的文章\n\n正文。",
        }],
      });
    const extracted = {
      url: "https://example.com/article",
      title: "服务端提取正文",
      sourceType: "web" as const,
      markdown: "# 服务端提取正文\n\n这是按网页结构确定性提取的完整内容。",
    };
    const webExtractor = vi.fn().mockResolvedValue(extracted);
    const ingestion = new IngestionService(config(directory), scoped, { process } as never, webExtractor);

    await expect(ingestion.ingest(item)).resolves.toMatchObject({ accepted: true });
    expect(process).toHaveBeenCalledTimes(2);
    expect(webExtractor).toHaveBeenCalledTimes(1);
    expect(process.mock.calls[0]?.[3]).toEqual([extracted]);
    expect(process.mock.calls[1]?.[4]).toEqual({ tenantId: owner.id });
    expect(scoped.getMessage(item.id)).toMatchObject({
      agentStatus: "completed",
      agentAttempts: 2,
      title: "重试后的文章",
    });
    database.close();
  }, 5_000);

  it("同一条内容正在排队或处理时不会被重复提交给 Agent", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-deduplicated-job-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    const owner = database.createOwner({ displayName: "Owner", password: "test-password" });
    const scoped = database.forTenant(owner.id);
    scoped.saveAgentSettings({
      enabled: true,
      baseUrl: "http://127.0.0.1:8900/v1/",
      model: "",
      instructions: "",
      autoReply: false,
      notifyOnFailure: true,
    });
    const item = capture("one-active-job", "待整理内容");
    let finish: ((value: unknown) => void) | undefined;
    const process = vi.fn(() => new Promise((resolve) => {
      finish = resolve;
    }));
    const ingestion = new IngestionService(config(directory), scoped, { process } as never);

    const first = ingestion.accept(item);
    const duplicate = ingestion.reprocess(item.id);
    expect(first.accepted).toBe(true);
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.job).toBe(first.job);
    await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(1));
    finish?.({ note: defaultNote(item), derivedDocuments: [] });
    await first.job;
    expect(process).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("智能图解只使用已持久化数据，并为比较型内容生成语义连线", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-map-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    const owner = database.createOwner({ displayName: "Owner", password: "test-password" });
    const scoped = database.forTenant(owner.id);
    const item = capture("mapped-resource", "Docker 容器健康检查");
    scoped.saveCapture(item, defaultNote(item));
    scoped.updateProcessedNote(item.id, {
      ...defaultNote(item),
      title: "Docker 健康检查",
      domains: ["容器技术"],
      knowledgePoints: ["容器健康检查"],
      tools: ["Docker"],
      keyPoints: ["使用 HEALTHCHECK 声明容器健康状态"],
    }, "completed");
    scoped.updateResourceState(item.id, { state: "library", favorite: true, read: true });

    const map = scoped.knowledgeMap(item.id);
    expect(map).toMatchObject({
      diagramType: "mindmap",
      diagramLabel: "思维导图",
    });
    expect(map.nodes.map((node) => [node.type, node.label])).toEqual(expect.arrayContaining([
      ["resource", "Docker 健康检查"],
      ["domain", "容器技术"],
      ["concept", "容器健康检查"],
      ["tool", "Docker"],
      ["point", "使用 HEALTHCHECK 声明容器健康状态"],
    ]));
    expect(scoped.getMessage(item.id)).toMatchObject({
      libraryState: "library",
      favorite: true,
    });
    expect(scoped.listMessages(10, undefined, { state: "library" }).map((message) => message.id))
      .toEqual([item.id]);
    expect(scoped.listMessages(10, undefined, { state: "inbox" })).toHaveLength(0);
    expect(scoped.listMessages(10, undefined, { favorite: true }).map((message) => message.id))
      .toEqual([item.id]);
    expect(scoped.countMessages({ state: "library" })).toBe(1);

    const comparisonItem = capture("comparison-resource", "DeepSeek 与 Pi Harness、Claude Code 横向评测");
    scoped.saveCapture(comparisonItem, defaultNote(comparisonItem));
    scoped.updateProcessedNote(comparisonItem.id, {
      ...defaultNote(comparisonItem),
      title: "DeepSeek + Pi Harness 跑赢 Claude Code？",
      summary: "比较同一 DeepSeek 模型在不同 Harness 下的成功率与缓存表现。",
      domains: ["智能体工程"],
      knowledgePoints: ["Harness 乘数效应", "缓存命中率"],
      tools: ["DeepSeek", "Pi Harness", "Claude Code"],
      keyPoints: [
        "同一 DeepSeek 模型下，Pi Harness 成功率高于 Claude Code。",
        "Pi Harness 通过缓存命中率优化降低任务成本。",
      ],
    }, "completed");
    const comparisonMap = scoped.knowledgeMap(comparisonItem.id);
    expect(comparisonMap).toMatchObject({
      diagramType: "comparison",
      diagramLabel: "对比图",
      selectionReason: "检测到多个比较对象和评测维度",
    });
    const piNode = comparisonMap.nodes.find((node) => node.label === "Pi Harness")!;
    const claudeNode = comparisonMap.nodes.find((node) => node.label === "Claude Code")!;
    const successPoint = comparisonMap.nodes.find((node) => node.label.includes("成功率高于"))!;
    expect(comparisonMap.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: piNode.id, target: successPoint.id, label: "证据" }),
      expect.objectContaining({ source: claudeNode.id, target: successPoint.id, label: "证据" }),
    ]));
    database.close();
  });
});
