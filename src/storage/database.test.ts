import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
  it("加密微信凭据并使用哈希会话令牌", async () => {
    const { directory, database, ownerId } = await setup();
    const session = database.createSession(30);
    expect(database.ownerForSession(session.token)?.id).toBe(ownerId);
    database.close();

    const raw = await fs.readFile(path.join(directory, "inbox.sqlite"));
    expect(raw.includes(Buffer.from("very-secret-token"))).toBe(false);
    expect(raw.includes(Buffer.from(session.token))).toBe(false);
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

    expect(first.batchId).toBeTruthy();
    database.acknowledgeSyncBatch(created.target.id, first.batchId!);
    const empty = database.getOrCreateSyncBatch(created.target.id, 100);
    expect(empty.items).toHaveLength(0);
    expect(database.listMessages()[0]?.archived).toBe(true);
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

  it("升级时合并旧附加账户的数据并移除多用户表", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ilink-single-owner-test-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    const owner = database.createOwner({ displayName: "Owner", password: "test-password" });
    database.close();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path.join(directory, "inbox.sqlite"));
    raw.prepare(
      "INSERT INTO users(id,username,display_name,password_hash,role,created_at) SELECT ?,?,?,password_hash,'member',? FROM users WHERE id=?",
    ).run("member-id", "member", "Member", new Date().toISOString(), owner.id);
    raw.exec("CREATE TABLE invitations(id TEXT PRIMARY KEY)");
    raw.prepare("DELETE FROM metadata WHERE key='single_owner_schema'").run();
    raw.close();
    const reopened = await AppDatabase.open(directory);
    expect(reopened.ownerId()).toBe(owner.id);
    const check = new DatabaseSync(path.join(directory, "inbox.sqlite"));
    expect(check.prepare("SELECT COUNT(*) count FROM users").get()!.count).toBe(1);
    expect(check.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='invitations'").get()!.count).toBe(0);
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
    database.publishMessage(message.id);
    const target = database.createSyncTarget({ name: "Vault", folder: "Inbox", primary: true });
    const batch = database.getOrCreateSyncBatch(target.target.id, 10);
    expect(batch.items[0]?.attachments).toEqual([
      expect.objectContaining({ fileName: "article.md", mimeType: "text/markdown" }),
    ]);
    database.close();
  });
});
