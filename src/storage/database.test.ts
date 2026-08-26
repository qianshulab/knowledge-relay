import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CaptureInput } from "../capture.js";
import type { PublicInboundMessage } from "../messages.js";
import { defaultNote } from "../notes.js";
import { AppDatabase } from "./database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function setup(): Promise<{ directory: string; database: AppDatabase; ownerId: string; botId: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ilink-db-test-"));
  temporaryDirectories.push(directory);
  const database = await AppDatabase.open(directory);
  const owner = database.createOwner({
    displayName: "Owner",
    password: "test-password",
  });
  const bot = database.addBotAccount({
    botToken: "very-secret-token",
    botId: "bot-1",
    baseUrl: "https://example.weixin.qq.com/",
    ownerUserId: "wx-1",
    connectedAt: new Date().toISOString(),
  });
  return { directory, database, ownerId: owner.id, botId: bot.id };
}

describe("AppDatabase", () => {
  it("首次保存处理策略前也会携带 Nanobot Runtime 内部密钥", async () => {
    const { database } = await setup();
    const settings = database.getAgentSettings({
      baseUrl: "http://nanobot:8900/v1/",
      model: "",
      apiKey: "runtime-internal-key",
    });

    expect(settings).toMatchObject({
      enabled: false,
      baseUrl: "http://nanobot:8900/v1/",
      apiKey: "runtime-internal-key",
    });
    database.close();
  });

  it("加密微信凭据并使用哈希会话令牌", async () => {
    const { directory, database, ownerId } = await setup();
    const session = database.createSession(30);
    expect(database.ownerForSession(session.token)?.id).toBe(ownerId);
    database.close();

    const raw = await fs.readFile(path.join(directory, "inbox.sqlite"));
    expect(raw.includes(Buffer.from("very-secret-token"))).toBe(false);
    expect(raw.includes(Buffer.from(session.token))).toBe(false);
  });

  it("仪表盘使用全工作区统计并只计算已配置目标的待同步内容", async () => {
    const { database, botId } = await setup();
    const makeMessage = (id: string, text: string): PublicInboundMessage => ({
      id: `bot-1:${id}`,
      senderId: "wx-1",
      botId: "bot-1",
      receivedAt: "2026-08-13T01:02:03.000Z",
      text,
      attachments: [],
    });
    const queued = makeMessage("dashboard-queued", "排队中的内容");
    const processing = makeMessage("dashboard-processing", "正在整理的内容");
    const organized = makeMessage("dashboard-organized", "已经整理的内容");

    database.saveMessage(botId, "dashboard-queued", queued, defaultNote(queued));
    database.saveMessage(botId, "dashboard-processing", processing, defaultNote(processing));
    database.markAgentAttempt(processing.id);
    database.saveMessage(botId, "dashboard-organized", organized, defaultNote(organized));
    database.updateProcessedNote(organized.id, defaultNote(organized), "completed");
    database.publishMessage(organized.id);

    expect(database.dashboard()).toMatchObject({
      messages: 3,
      organized: 1,
      pending: 2,
      queued: 1,
      activeProcessing: 1,
      processing: 2,
      pendingSync: 0,
      botAccounts: 1,
    });

    const created = database.createSyncTarget({ name: "Vault", folder: "Inbox", primary: true });
    expect(database.dashboard().pendingSync).toBe(1);
    const batch = database.getOrCreateSyncBatch(created.target.id, 10);
    database.acknowledgeSyncBatch(created.target.id, batch.batchId!);
    expect(database.dashboard().pendingSync).toBe(0);
    database.close();
  });

  it("同一批次会稳定重试，确认后只返回新事件", async () => {
    const { database, botId } = await setup();
    const message: PublicInboundMessage = {
      id: "bot-1:message-1",
      senderId: "wx-1",
      botId: "bot-1",
      receivedAt: "2026-08-13T01:02:03.000Z",
      text: "待办：整理会议记录",
      attachments: [],
    };
    const note = defaultNote(message);
    expect(database.saveMessage(botId, "message-1", message, note)).toBe(true);
    database.updateProcessedNote(message.id, note, "fallback");
    database.publishMessage(message.id);
    const created = database.createSyncTarget({
      name: "Test Vault",
      folder: "Inbox/微信",
      primary: true,
    });

    const first = database.getOrCreateSyncBatch(created.target.id, 100);
    const retry = database.getOrCreateSyncBatch(created.target.id, 100);
    expect(retry.batchId).toBe(first.batchId);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.messageId).toBe(message.id);
    expect(first.items[0]?.id).toBe(message.id);
    expect(first.items[0]?.version).toMatch(/^[a-f0-9]{64}$/);
    expect(first.items[0]?.processing.status).toBe("fallback");
    expect(first.items[0]?.source.type).toBe("wechat");

    expect(first.batchId).toBeTruthy();
    database.acknowledgeSyncBatch(created.target.id, first.batchId!);
    const empty = database.getOrCreateSyncBatch(created.target.id, 100);
    expect(empty.items).toHaveLength(0);
    expect(database.listMessages()[0]?.archived).toBe(true);
    database.close();
  });

  it("重置设备游标后稳定重放但不改变远程 ID 和内容版本", async () => {
    const { database, botId } = await setup();
    const message: PublicInboundMessage = {
      id: "bot-1:replay-message",
      senderId: "wx-1",
      botId: "bot-1",
      receivedAt: "2026-08-13T01:02:03.000Z",
      text: "https://example.com/reference",
      attachments: [],
    };
    const note = defaultNote(message);
    database.saveMessage(botId, "replay-message", message, note);
    database.updateProcessedNote(message.id, note, "fallback");
    database.publishMessage(message.id);
    const created = database.createSyncTarget({ name: "Replay", folder: "收件箱", primary: true });
    const first = database.getOrCreateSyncBatch(created.target.id, 50);
    database.acknowledgeSyncBatch(created.target.id, first.batchId!);
    expect(database.getOrCreateSyncBatch(created.target.id, 50).items).toEqual([]);
    expect(database.resetSyncTargetCursor(created.target.id)).toEqual({ cursor: 0 });
    const replay = database.getOrCreateSyncBatch(created.target.id, 50);
    expect(replay.items[0]?.id).toBe(first.items[0]?.id);
    expect(replay.items[0]?.version).toBe(first.items[0]?.version);
    database.close();
  });

  it("原始消息持久化后等待 Agent 完成，同步只返回最终 AI 标题", async () => {
    const { database, botId } = await setup();
    const message: PublicInboundMessage = {
      id: "bot-1:progressive-message",
      senderId: "wx-1",
      botId: "bot-1",
      receivedAt: "2026-08-13T01:02:03.000Z",
      text: "一条需要继续整理的原始消息",
      attachments: [],
    };
    const fallback = defaultNote(message);
    database.saveMessage(botId, "progressive-message", message, fallback);
    database.publishMessage(message.id);
    const created = database.createSyncTarget({ name: "Progressive", folder: "收件箱", primary: true });
    const pending = database.getOrCreateSyncBatch(created.target.id, 50);
    expect(pending.items).toEqual([]);

    const enriched = { ...fallback, title: "AI 整理后的标题", summary: "AI 整理后的摘要" };
    database.updateProcessedNote(message.id, enriched, "completed");
    database.publishMessage(message.id);
    const enrichedBatch = database.getOrCreateSyncBatch(created.target.id, 50);
    expect(enrichedBatch.items).toHaveLength(1);
    expect(enrichedBatch.items[0]).toMatchObject({
      id: message.id,
      title: "AI 整理后的标题",
      processing: { status: "enriched" },
    });
    database.close();
  });

  it("重启后可重建尚未完成的 Agent 任务及其附件", async () => {
    const { directory, database, botId } = await setup();
    const attachmentPath = path.join(directory, "capture.txt");
    await fs.writeFile(attachmentPath, "captured content", "utf8");
    const message: PublicInboundMessage = {
      id: "bot-1:pending-recovery",
      senderId: "wx-1",
      botId: "bot-1",
      sessionId: "session-1",
      receivedAt: "2026-08-13T01:02:03.000Z",
      sentAt: "2026-08-13T01:02:02.000Z",
      text: "一条处理中断的消息",
      attachments: [{
        kind: "file",
        fileName: "capture.txt",
        path: attachmentPath,
        size: 16,
        mimeType: "text/plain",
      }],
    };
    database.saveMessage(botId, "pending-recovery", message, defaultNote(message));
    const pending = database.listPendingAgentMessages();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      capture: {
        id: message.id,
        source: {
          channel: "wechat",
          connectionId: botId,
          externalId: "pending-recovery",
        },
        sessionId: "session-1",
        attachments: [{ fileName: "capture.txt", path: attachmentPath }],
      },
    });
    database.updateProcessedNote(message.id, defaultNote(message), "fallback");
    expect(database.listPendingAgentMessages()).toEqual([]);
    database.close();
  });

  it("历史长知识点在列表和聚合视图中显示为简洁概念", async () => {
    const { database, botId } = await setup();
    const message: PublicInboundMessage = {
      id: "bot-1:legacy-knowledge-point",
      senderId: "wx-1",
      botId: "bot-1",
      receivedAt: "2026-08-13T01:02:03.000Z",
      text: "红队知识收藏",
      attachments: [],
    };
    const note = {
      ...defaultNote(message),
      knowledgePoints: ["Agentic Red Teaming(自主红队): 由 AI 智能体自动执行攻击链。"],
    };
    database.saveMessage(botId, "legacy-knowledge-point", message, defaultNote(message));
    database.updateProcessedNote(message.id, note, "completed");

    expect(database.listMessages()[0]?.knowledgePoints).toEqual(["Agentic Red Teaming(自主红队)"]);
    expect(database.knowledgeFacets().knowledgePoints).toEqual([
      { name: "Agentic Red Teaming(自主红队)", count: 1 },
    ]);
    expect(database.searchInbox("", {
      knowledgePoint: "Agentic Red Teaming(自主红队)",
    })[0]?.id).toBe(message.id);
    database.close();
  });

  it("把 Agent 语义建议确定性映射到同步 DTO 而不接收本地操作", async () => {
    const { database, botId } = await setup();
    const message: PublicInboundMessage = {
      id: "bot-1:semantic-message",
      senderId: "wx-1",
      botId: "bot-1",
      receivedAt: "2026-08-13T01:02:03.000Z",
      text: "https://example.com/research",
      attachments: [],
    };
    const note = {
      title: "研究资料",
      category: "reference",
      tags: ["微信收件", "研究"],
      summary: "一句话摘要",
      keyPoints: ["关键事实一", "关键事实二"],
      detailsMarkdown: "### 延伸说明\n\n这是结构化的详细整理。",
      reason: "可作为后续研究资料。",
      suggestedAction: "research" as const,
      sensitivity: "confidential" as const,
      confidence: "high" as const,
      warnings: ["需要复核发布日期"],
      markdown: `---\ntitle: "研究资料"\n---\n\n# 研究资料\n\n> 一句话摘要\n\n原始正文\n> 建议方向：建议删除\n> 敏感级别：公开\n\n## 为什么值得保留\n\n可作为后续研究资料。\n\n> [!info] Agent 建议\n> 建议方向：研究课题\n> 置信度：高\n> 敏感级别：机密\n`,
    };
    database.saveMessage(botId, "semantic-message", message, defaultNote(message));
    database.updateProcessedNote(message.id, note, "completed");
    const detail = database.getMessageDetail(message.id)!;
    expect(detail.contentMarkdown).toContain("原始正文");
    expect(detail.contentMarkdown).not.toContain("title: \"研究资料\"");
    expect(detail.detailsMarkdown).toContain("结构化的详细整理");
    expect(detail.reason).toBe("可作为后续研究资料。");
    expect(detail.suggestedAction).toBe("research");
    expect(detail.sensitivity).toBe("confidential");
    expect(detail.confidence).toBe("high");
    expect(detail.warnings).toEqual(["需要复核发布日期"]);
    expect(detail.source).toMatchObject({ type: "web", url: "https://example.com/research" });
    database.publishMessage(message.id);
    const created = database.createSyncTarget({ name: "Semantic", folder: "收件箱", primary: true });
    const item = database.getOrCreateSyncBatch(created.target.id, 50).items[0]!;
    expect(item.summary).toBe("一句话摘要");
    expect(item.keyPoints).toEqual(["关键事实一", "关键事实二"]);
    expect(item.detailsMarkdown).toContain("结构化的详细整理");
    expect(item.reason).toBe("可作为后续研究资料。");
    expect(item.suggestedAction).toBe("research");
    expect(item.sensitivity).toBe("confidential");
    expect(item.processing).toMatchObject({
      status: "enriched",
      confidence: "high",
      processor: "nanobot",
      pipelineVersion: "knowledge-relay-inbox-v2",
      warnings: ["需要复核发布日期"],
    });
    database.close();
  });

  it("为不同 Obsidian 设备维护独立游标", async () => {
    const { database, botId } = await setup();
    const message: PublicInboundMessage = {
      id: "bot-1:message-2",
      senderId: "wx-1",
      botId: "bot-1",
      receivedAt: new Date().toISOString(),
      text: "hello",
      attachments: [],
    };
    const note = defaultNote(message);
    database.saveMessage(botId, "message-2", message, note);
    database.updateProcessedNote(message.id, note, "fallback");
    database.publishMessage(message.id);
    const first = database.createSyncTarget({ name: "A", folder: "Inbox", primary: true });
    const second = database.createSyncTarget({ name: "B", folder: "Inbox", primary: false });
    const batchA = database.getOrCreateSyncBatch(first.target.id, 10);
    expect(batchA.batchId).toBeTruthy();
    database.acknowledgeSyncBatch(first.target.id, batchA.batchId!);
    expect(database.getOrCreateSyncBatch(first.target.id, 10).items).toHaveLength(0);
    expect(database.getOrCreateSyncBatch(second.target.id, 10).items).toHaveLength(1);
    database.close();
  });

  it("个人版只允许初始化一个账户", async () => {
    const { database, ownerId } = await setup();
    expect(database.ownerId()).toBe(ownerId);
    expect(() => database.createOwner({ displayName: "Other", password: "valid-password" }))
      .toThrow("已经完成初始化");
    database.close();
  });

  it("从微信专用旧表迁移到允许 API 收件的通用消息表", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ilink-capture-migration-test-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    database.createOwner({ displayName: "Owner", password: "test-password" });
    database.close();

    const { DatabaseSync } = await import("node:sqlite");
    const legacy = new DatabaseSync(path.join(directory, "inbox.sqlite"));
    legacy.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TABLE messages;
      CREATE TABLE messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bot_account_id TEXT NOT NULL REFERENCES bot_accounts(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        session_id TEXT,
        received_at TEXT NOT NULL,
        sent_at TEXT,
        text TEXT NOT NULL,
        agent_status TEXT NOT NULL DEFAULT 'pending',
        agent_error TEXT,
        note_revision INTEGER NOT NULL DEFAULT 1,
        note_title TEXT NOT NULL,
        note_markdown TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'inbox',
        tags_json TEXT NOT NULL DEFAULT '[]',
        published_revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.close();

    const migrated = await AppDatabase.open(directory);
    migrated.close();
    const check = new DatabaseSync(path.join(directory, "inbox.sqlite"), { readOnly: true });
    const columns = check.prepare("PRAGMA table_info(messages)").all() as Array<Record<string, unknown>>;
    expect(columns.find((column) => column.name === "bot_account_id")?.notnull).toBe(0);
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "source_channel",
      "capture_type",
      "key_points_json",
      "details_markdown",
    ]));
    expect(check.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    check.close();
  });

  it("通过一次性邀请创建独立用户并持久保留租户边界", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-multi-tenant-test-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    const owner = database.createOwner({ displayName: "Owner", password: "test-password" });
    const ownerDatabase = database.forTenant(owner.id);
    const invitation = ownerDatabase.createInvitation(24);
    const member = database.registerWithInvitation({
      token: invitation.token,
      username: "member",
      displayName: "Member",
      password: "member-password",
    });
    expect(() => database.registerWithInvitation({
      token: invitation.token,
      username: "second",
      displayName: "Second",
      password: "second-password",
    })).toThrow("无效或已过期");
    const memberDatabase = database.forTenant(member.id);
    ownerDatabase.addBotAccount({
      botToken: "owner-secret",
      botId: "owner-bot",
      baseUrl: "https://example.weixin.qq.com/",
      connectedAt: new Date().toISOString(),
    });
    memberDatabase.addBotAccount({
      botToken: "member-secret",
      botId: "member-bot",
      baseUrl: "https://example.weixin.qq.com/",
      connectedAt: new Date().toISOString(),
    });
    expect(ownerDatabase.getBotAccounts().map((item) => item.botId)).toEqual(["owner-bot"]);
    expect(memberDatabase.getBotAccounts().map((item) => item.botId)).toEqual(["member-bot"]);
    expect(ownerDatabase.getBotAccount(memberDatabase.getBotAccounts()[0]!.id)).toBeUndefined();
    expect(database.authenticate("member", "member-password")?.id).toBe(member.id);
    expect(ownerDatabase.listUsers()).toHaveLength(2);
    database.close();

    const reopened = await AppDatabase.open(directory);
    expect(reopened.forTenant(owner.id).getBotAccounts()).toHaveLength(1);
    expect(reopened.forTenant(member.id).getBotAccounts()).toHaveLength(1);
    const { DatabaseSync } = await import("node:sqlite");
    const check = new DatabaseSync(path.join(directory, "inbox.sqlite"));
    expect(check.prepare("SELECT COUNT(*) count FROM users").get()!.count).toBe(2);
    expect(check.prepare("SELECT COUNT(*) count FROM invitations WHERE consumed_by IS NOT NULL").get()!.count).toBe(1);
    check.close();
    reopened.close();
  });

  it("空同步不创建可确认批次，撤销设备不再显示", async () => {
    const { database, botId } = await setup();
    const message: PublicInboundMessage = {
      id: "bot-1:message-revoked",
      senderId: "wx-1",
      botId: "bot-1",
      receivedAt: new Date().toISOString(),
      text: "hello",
      attachments: [],
    };
    const note = defaultNote(message);
    database.saveMessage(botId, "message-revoked", message, note);
    database.updateProcessedNote(message.id, note, "fallback");
    database.publishMessage(message.id);
    const created = database.createSyncTarget({
      name: "Temporary",
      folder: "Inbox",
      primary: true,
    });
    const batch = database.getOrCreateSyncBatch(created.target.id, 100);
    expect(batch.batchId).toBeTruthy();
    database.acknowledgeSyncBatch(created.target.id, batch.batchId!);
    expect(database.listMessages()[0]?.archived).toBe(true);
    const empty = database.getOrCreateSyncBatch(created.target.id, 100);
    expect(empty.batchId).toBeUndefined();
    expect(empty.items).toEqual([]);
    expect(database.revokeSyncTarget(created.target.id)).toBe(true);
    expect(database.listSyncTargets()).toEqual([]);
    expect(database.listMessages()[0]?.archived).toBe(false);
    database.close();
  });

  it("修改密码会撤销已有登录会话", async () => {
    const { database, ownerId } = await setup();
    const session = database.createSession(30);
    expect(database.ownerForSession(session.token)?.id).toBe(ownerId);
    expect(database.changePassword("test-password", "new-test-password")).toBe(true);
    expect(database.ownerForSession(session.token)).toBeUndefined();
    expect(database.authenticateOwner("new-test-password")?.id).toBe(ownerId);
    database.close();
  });

  it("可以更新个人账户名称并立即反映到会话资料", async () => {
    const { database } = await setup();
    const session = database.createSession(30);
    const updated = database.updateOwnerDisplayName("  我的 知流  ");
    expect(updated.displayName).toBe("我的 知流");
    expect(database.ownerForSession(session.token)?.displayName).toBe("我的 知流");
    expect(() => database.updateOwnerDisplayName("   ")).toThrow("账户名称不能为空");
    database.close();
  });

  it("附件只能通过当前个人账户查询", async () => {
    const { directory, database, botId } = await setup();
    const filePath = path.join(directory, "sample.txt");
    await fs.writeFile(filePath, "attachment content");
    const message: PublicInboundMessage = {
      id: "bot-1:attachment-message",
      senderId: "wx-1",
      botId: "bot-1",
      receivedAt: new Date().toISOString(),
      text: "附件",
      attachments: [
        {
          kind: "file",
          fileName: "sample.txt",
          path: filePath,
          size: 18,
          mimeType: "text/plain",
        },
      ],
    };
    database.saveMessage(botId, "attachment-message", message, defaultNote(message));
    const own = database.attachmentsForMessageView(message.id);
    expect(own).toHaveLength(1);
    expect(own[0]?.previewable).toBe(true);
    expect(database.attachmentForOwner(own[0]!.id)?.fileName).toBe("sample.txt");
    database.close();
  });

  it("派生 Markdown 附件会进入同步快照且重复写入幂等", async () => {
    const { directory, database, botId } = await setup();
    const message: PublicInboundMessage = {
      id: "bot-1:derived-message",
      senderId: "wx-1",
      botId: "bot-1",
      receivedAt: new Date().toISOString(),
      text: "https://example.com/article",
      attachments: [],
    };
    database.saveMessage(botId, "derived-message", message, defaultNote(message));
    const filePath = path.join(directory, "article.md");
    await fs.writeFile(filePath, "# Parsed article\n");
    const derived = {
      kind: "derived" as const,
      fileName: "article.md",
      path: filePath,
      size: 17,
      mimeType: "text/markdown",
    };
    expect(database.addAttachment(message.id, derived)).toBe(database.addAttachment(message.id, derived));
    database.updateProcessedNote(message.id, defaultNote(message), "fallback");
    database.publishMessage(message.id);
    const target = database.createSyncTarget({ name: "Vault", folder: "Inbox", primary: true });
    const batch = database.getOrCreateSyncBatch(target.target.id, 10);
    expect(batch.items[0]?.attachments).toEqual([
      expect.objectContaining({ fileName: "article.md", mimeType: "text/markdown" }),
    ]);
    database.close();
  });

  it("入库时建立只读检索索引并聚合领域、知识点和工具", async () => {
    const { database, botId } = await setup();
    const message: PublicInboundMessage = {
      id: "bot-1:indexed-message",
      senderId: "wx-1",
      botId: "bot-1",
      receivedAt: "2026-08-13T05:00:00.000Z",
      text: "这篇文章介绍移动应用安全测试与 Frida 动态分析。",
      attachments: [],
    };
    database.saveMessage(botId, "indexed-message", message, defaultNote(message));
    database.updateProcessedNote(message.id, {
      title: "移动应用安全测试",
      category: "reference",
      tags: ["微信收件", "移动安全"],
      summary: "使用 Frida 对移动应用进行动态分析。",
      knowledgePoints: ["动态插桩", "移动应用安全"],
      domains: ["网络安全"],
      tools: ["Frida"],
      markdown: "# 移动应用安全测试\n\n使用 Frida 对移动应用进行动态分析。",
    }, "completed");

    expect(database.searchInbox("移动安全工具")).toEqual([
      expect.objectContaining({ id: message.id, tools: ["Frida"], domains: ["网络安全"] }),
    ]);
    expect(database.searchInbox("我之前收藏过哪些和移动安全有关的内容？")).toEqual([
      expect.objectContaining({ id: message.id, tools: ["Frida"], domains: ["网络安全"] }),
    ]);
    expect(database.searchInbox("", { tool: "Frida" })[0]?.id).toBe(message.id);
    expect(database.searchInbox("移动安全", { organized: true })[0]?.id).toBe(message.id);
    expect(database.searchInbox("移动安全", { organized: false })).toEqual([]);
    expect(database.knowledgeFacets()).toMatchObject({
      total: 1,
      enriched: 1,
      facetTotals: {
        categories: 1,
        domains: 1,
        knowledgePoints: 2,
        tools: 1,
      },
      domains: [{ name: "网络安全", count: 1 }],
      tools: [{ name: "Frida", count: 1 }],
    });
    const fallbackMessage: PublicInboundMessage = {
      id: "bot-1:unorganized-message",
      senderId: "wx-1",
      botId: "bot-1",
      receivedAt: "2026-08-13T05:01:00.000Z",
      text: "尚未完成智能整理的原始收藏。",
      attachments: [],
    };
    database.saveMessage(botId, "unorganized-message", fallbackMessage, defaultNote(fallbackMessage));
    database.updateProcessedNote(fallbackMessage.id, defaultNote(fallbackMessage), "fallback");
    expect(database.listMessages(10, undefined, { organized: true }).map((item) => item.id)).toEqual([message.id]);
    expect(database.listMessages(10, undefined, { organized: true, domain: "网络安全" }).map((item) => item.id)).toEqual([message.id]);
    expect(database.listMessages(10, undefined, { organized: true, format: "text" }).map((item) => item.id)).toEqual([message.id]);
    expect(database.listMessages(10, undefined, { organized: true, query: "Frida" }).map((item) => item.id)).toEqual([message.id]);
    expect(database.countMessages({ organized: true, query: "动态分析" })).toBe(1);
    expect(database.listMessages(10, undefined, { organized: true, format: "wechat_article" })).toEqual([]);
    expect(database.listMessages(10, undefined, { organized: true, domain: "不存在的主题" })).toEqual([]);
    expect(database.countMessages({ organized: true })).toBe(1);
    database.updateResourceState(message.id, { state: "archived" });
    expect(database.listMessages(10, undefined, { organized: true }).map((item) => item.id)).toEqual([message.id]);
    expect(database.listMessages(10, undefined, { organized: true, active: true })).toEqual([]);
    expect(database.knowledgeFacets(true)).toMatchObject({
      total: 1,
      enriched: 1,
      categories: [{ name: "text", count: 1 }],
    });
    database.close();
  });

  it("渠道无关收件不依赖微信账户并保留来源与幂等身份", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-api-capture-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    database.createOwner({ displayName: "Owner", password: "test-password" });
    const capture: CaptureInput = {
      id: "api:stable-capture",
      source: {
        channel: "api",
        type: "api",
        externalId: "client-request-001",
        connectionId: "personal-api",
        name: "API 投稿",
        url: "https://example.com/article",
      },
      captureType: "link",
      actorId: "personal-token",
      receivedAt: "2026-08-14T00:00:00.000Z",
      text: "https://example.com/article",
      attachments: [],
    };
    const note = defaultNote(capture);
    expect(database.saveCapture(capture, note)).toBe(true);
    expect(database.saveCapture(capture, note)).toBe(false);
    database.updateProcessedNote(capture.id, note, "fallback");
    database.publishMessage(capture.id);
    const target = database.createSyncTarget({ name: "Vault", folder: "Inbox", primary: true });
    const batch = database.getOrCreateSyncBatch(target.target.id, 10);
    expect(batch.items[0]).toMatchObject({
      id: capture.id,
      captureType: "link",
      originalText: capture.text,
      source: { type: "api", name: "API 投稿", url: "https://example.com/article" },
    });
    database.close();
  });

  it("使用消息序号稳定分页且不会重复返回边界记录", async () => {
    const { database, botId } = await setup();
    for (let index = 0; index < 25; index += 1) {
      const message: PublicInboundMessage = {
        id: `bot-1:page-${index}`,
        senderId: "wx-1",
        botId: "bot-1",
        receivedAt: new Date(Date.UTC(2026, 7, 13, 6, 0, index)).toISOString(),
        text: `分页消息 ${index}`,
        attachments: [],
      };
      database.saveMessage(botId, `page-${index}`, message, defaultNote(message));
    }
    const first = database.listMessages(10);
    const second = database.listMessages(10, first.at(-1)!.seq);
    const third = database.listMessages(10, second.at(-1)!.seq);
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(third).toHaveLength(5);
    expect(new Set([...first, ...second, ...third].map((item) => item.id)).size).toBe(25);
    expect(Math.max(...second.map((item) => item.seq))).toBeLessThan(first.at(-1)!.seq);
    database.close();
  });

  it("智能图解按内容版本持久化复用，内容更新和永久删除会同步清理", async () => {
    const { directory, database, botId } = await setup();
    const filePath = path.join(directory, "diagram-source.txt");
    await fs.writeFile(filePath, "diagram attachment");
    const message: PublicInboundMessage = {
      id: "bot-1:diagram-message",
      senderId: "wx-1",
      botId: "bot-1",
      receivedAt: new Date().toISOString(),
      text: "先收集资料，再分析并输出结论。",
      attachments: [{
        kind: "file",
        fileName: "diagram-source.txt",
        path: filePath,
        size: 18,
        mimeType: "text/plain",
      }],
    };
    const note = defaultNote(message);
    database.saveMessage(botId, "diagram-message", message, note);
    database.updateProcessedNote(message.id, note, "completed");
    const revision = database.getMessage(message.id)!.revision;
    const stored = database.saveKnowledgeDiagram(message.id, {
      scope: "resource",
      diagramType: "flow",
      diagramLabel: "处理流程图",
      selectionReason: "资料包含明确步骤",
      generatedAt: new Date().toISOString(),
      truncated: false,
      nodes: [
        { id: "root", label: "资料处理", type: "root" },
        { id: "collect", label: "收集资料", type: "point" },
      ],
      edges: [{ source: "root", target: "collect", label: "第一步", kind: "primary" }],
    }, revision);
    expect(stored).toMatchObject({ messageId: message.id, noteRevision: revision, diagramType: "flow" });
    expect(database.getKnowledgeDiagram(message.id)).toMatchObject({ diagramLabel: "处理流程图" });

    database.updateProcessedNote(message.id, { ...note, title: "更新后的资料处理" }, "completed");
    expect(database.getKnowledgeDiagram(message.id)).toBeUndefined();

    const deleted = database.deleteMessage(message.id);
    expect(deleted).toEqual({ attachmentCount: 1 });
    expect(database.getMessage(message.id)).toBeUndefined();
    await expect(fs.access(filePath)).rejects.toThrow();
    database.close();
  });

  it("管理员删除成员时要求用户名确认并清理成员工作区数据", async () => {
    const { directory, database } = await setup();
    const invitation = database.createInvitation(1);
    const member = database.registerWithInvitation({
      token: invitation.token,
      username: "member-delete",
      displayName: "待删除成员",
      password: "member-password",
    });
    const memberDatabase = database.forTenant(member.id);
    const filePath = path.join(directory, "member-attachment.txt");
    await fs.writeFile(filePath, "member data");
    const capture: CaptureInput = {
      id: "api:member-delete-message",
      source: {
        channel: "api",
        type: "api",
        externalId: "member-delete-message",
        connectionId: "member-api",
        name: "API 收件",
      },
      captureType: "file",
      actorId: "member",
      receivedAt: new Date().toISOString(),
      text: "成员资料",
      attachments: [{
        kind: "file",
        fileName: "member-attachment.txt",
        path: filePath,
        size: 11,
        mimeType: "text/plain",
      }],
    };
    memberDatabase.saveCapture(capture, defaultNote(capture));
    expect(() => database.deleteUser(member.id, "wrong-name")).toThrow("确认用户名不匹配");
    expect(database.deleteUser(member.id, "member-delete")).toEqual({
      username: "member-delete",
      attachmentCount: 1,
    });
    expect(database.authenticate("member-delete", "member-password")).toBeUndefined();
    await expect(fs.access(filePath)).rejects.toThrow();
    database.close();
  });
});
