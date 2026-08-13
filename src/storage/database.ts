import crypto from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { IlinkAccount } from "../ilink/types.js";
import type { PublicInboundMessage } from "../messages.js";
import {
  hashPassword,
  randomToken,
  SecretBox,
  tokenHash,
  verifyPassword,
} from "../security.js";
import { BUILTIN_SKILLS, skillSlug, validateSkill } from "../skills.js";

type SqlValue = string | number | null;
type SqlRow = Record<string, SqlValue>;

export type OwnerProfile = {
  id: string;
  displayName: string;
  createdAt: string;
};

export type StoredBotAccount = IlinkAccount & {
  id: string;
  cursor: string;
  state: string;
  lastPollAt?: string;
  lastMessageAt?: string;
  lastError?: string;
};

export type AgentSettings = {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  model: string;
  instructions: string;
  autoReply: boolean;
  notifyOnFailure: boolean;
};

export type ManagedSkill = {
  id: string;
  slug: string;
  name: string;
  description: string;
  content: string;
  builtin: boolean;
  enabled: boolean;
  customized: boolean;
  updatedAt?: string;
  kind: "prompt" | "adapter";
  sourceUrl?: string;
  sourceRevision?: string;
};

export type ProcessedNote = {
  title: string;
  markdown: string;
  category: string;
  tags: string[];
};

export type MessageListItem = {
  seq: number;
  id: string;
  receivedAt: string;
  sentAt?: string;
  senderId: string;
  text: string;
  category: string;
  tags: string[];
  title: string;
  markdown: string;
  revision: number;
  agentStatus: string;
  agentError?: string;
  attachmentCount: number;
  archived: boolean;
};

export type SyncTarget = {
  id: string;
  name: string;
  folder: string;
  primary: boolean;
  lastAckSeq: number;
  lastSeenAt?: string;
  createdAt: string;
  revoked: boolean;
};

export type SyncAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
};

export type MessageAttachmentView = SyncAttachment & {
  kind: string;
  transcript?: string;
  previewable: boolean;
};

export type SyncItem = {
  eventSeq: number;
  messageId: string;
  revision: number;
  title: string;
  fileName: string;
  markdown: string;
  receivedAt: string;
  attachments: SyncAttachment[];
};

export type SyncBatch = {
  batchId?: string;
  fromCursor: number;
  nextCursor: number;
  hasMore: boolean;
  items: SyncItem[];
};

function now(): string {
  return new Date().toISOString();
}

function rowString(row: SqlRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function rowOptional(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value ? value : undefined;
}

function rowNumber(row: SqlRow, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value || 0);
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function noteFileName(title: string, messageId: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const suffix = crypto.createHash("sha1").update(messageId).digest("hex").slice(0, 8);
  return `${cleaned || "微信收件"}-${suffix}.md`;
}

function mapOwner(row: SqlRow): OwnerProfile {
  return {
    id: rowString(row, "id"),
    displayName: rowString(row, "display_name"),
    createdAt: rowString(row, "created_at"),
  };
}

export class AppDatabase {
  private constructor(
    readonly dataDir: string,
    private readonly nanobotWorkspace: string,
    private readonly database: DatabaseSync,
    private readonly secrets: SecretBox,
  ) {}

  static async open(
    dataDir: string,
    nanobotWorkspace = path.join(dataDir, "nanobot", "workspace"),
  ): Promise<AppDatabase> {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const secrets = await SecretBox.load(dataDir);
    const database = new DatabaseSync(path.join(dataDir, "inbox.sqlite"));
    database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const result = new AppDatabase(dataDir, path.resolve(nanobotWorkspace), database, secrets);
    result.migrate();
    result.enforceSingleOwner();
    return result;
  }

  close(): void {
    this.database.close();
  }

  private runtimeSkillPaths(slug: string): { active: string; disabled: string; pristine: string } {
    const skillDirectory = path.join(this.nanobotWorkspace, "skills", slug);
    return {
      active: path.join(skillDirectory, "SKILL.md"),
      disabled: path.join(skillDirectory, "SKILL.md.disabled"),
      pristine: path.join(this.nanobotWorkspace, ".upstream", slug, "SKILL.md"),
    };
  }

  private runtimeSkillState(
    slug: string,
  ): { content: string; enabled: boolean; customized: boolean } | undefined {
    const paths = this.runtimeSkillPaths(slug);
    const source = existsSync(paths.active)
      ? { path: paths.active, enabled: true }
      : existsSync(paths.disabled)
        ? { path: paths.disabled, enabled: false }
        : undefined;
    if (!source) return undefined;
    const content = readFileSync(source.path, "utf8");
    const pristine = existsSync(paths.pristine) ? readFileSync(paths.pristine, "utf8") : undefined;
    return { content, enabled: source.enabled, customized: pristine !== undefined && content !== pristine };
  }

  private updateRuntimeSkill(slug: string, content: string, enabled: boolean): void {
    const builtin = BUILTIN_SKILLS.find((skill) => skill.slug === slug && skill.sourceUrl);
    if (!builtin) return;
    const paths = this.runtimeSkillPaths(slug);
    if (![paths.active, paths.disabled, paths.pristine].some(existsSync)) return;
    const destination = enabled ? paths.active : paths.disabled;
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, content, { encoding: "utf8", mode: 0o600 });
    const obsolete = enabled ? paths.disabled : paths.active;
    if (existsSync(obsolete)) unlinkSync(obsolete);
  }

  private restoreRuntimeSkill(slug: string): void {
    const paths = this.runtimeSkillPaths(slug);
    if (!existsSync(paths.pristine)) return;
    mkdirSync(path.dirname(paths.active), { recursive: true, mode: 0o700 });
    copyFileSync(paths.pristine, paths.active);
    if (existsSync(paths.disabled)) unlinkSync(paths.disabled);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','member')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_accounts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL UNIQUE,
        bot_token_enc TEXT NOT NULL,
        base_url TEXT NOT NULL,
        owner_user_id TEXT,
        connected_at TEXT NOT NULL,
        cursor TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'stopped',
        last_poll_at TEXT,
        last_message_at TEXT,
        last_error TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_bot_accounts_tenant ON bot_accounts(tenant_id);
      CREATE TABLE IF NOT EXISTS messages (
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
      CREATE INDEX IF NOT EXISTS idx_messages_tenant_seq ON messages(tenant_id, seq DESC);
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        file_name TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        transcript TEXT,
        sha256 TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
      CREATE TABLE IF NOT EXISTS sync_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(message_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_sync_events_tenant_seq ON sync_events(tenant_id, seq);
      CREATE TABLE IF NOT EXISTS sync_targets (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        folder TEXT NOT NULL DEFAULT 'Inbox/微信',
        token_hash TEXT NOT NULL UNIQUE,
        is_primary INTEGER NOT NULL DEFAULT 0,
        last_ack_seq INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sync_targets_tenant ON sync_targets(tenant_id);
      CREATE TABLE IF NOT EXISTS sync_batches (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
        from_seq INTEGER NOT NULL,
        to_seq INTEGER NOT NULL,
        has_more INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('open','acked','failed')),
        created_at TEXT NOT NULL,
        acked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sync_batches_open ON sync_batches(target_id, status);
      CREATE TABLE IF NOT EXISTS sync_batch_items (
        batch_id TEXT NOT NULL REFERENCES sync_batches(id) ON DELETE CASCADE,
        event_seq INTEGER NOT NULL REFERENCES sync_events(seq) ON DELETE CASCADE,
        PRIMARY KEY(batch_id, event_seq)
      );
      CREATE TABLE IF NOT EXISTS tenant_settings (
        tenant_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        nanobot_enabled INTEGER NOT NULL DEFAULT 0,
        nanobot_base_url TEXT NOT NULL,
        nanobot_api_key_enc TEXT,
        nanobot_model TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        auto_reply INTEGER NOT NULL DEFAULT 0,
        notify_on_failure INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tenant_skills (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        content TEXT NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(tenant_id, slug)
      );
      CREATE INDEX IF NOT EXISTS idx_tenant_skills_tenant ON tenant_skills(tenant_id, enabled);
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS failed_inbound_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bot_account_id TEXT NOT NULL REFERENCES bot_accounts(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        sender_id TEXT,
        error TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        first_failed_at TEXT NOT NULL,
        last_failed_at TEXT NOT NULL,
        UNIQUE(bot_account_id, source_id)
      );
    `);
    try {
      this.database.exec("ALTER TABLE bot_accounts ADD COLUMN revoked_at TEXT");
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
    }
    try {
      this.database.exec("ALTER TABLE tenant_settings ADD COLUMN notify_on_failure INTEGER NOT NULL DEFAULT 1");
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
    }
    // Older releases stored a model-provider key and model choice here. The official
    // Nanobot Runtime owns both now, so purge those legacy values during migration.
    this.database.exec("UPDATE tenant_settings SET nanobot_api_key_enc=NULL,nanobot_model=''");
  }

  hasOwner(): boolean {
    return rowNumber(this.one("SELECT COUNT(*) AS count FROM users"), "count") > 0;
  }

  createOwner(input: {
    displayName: string;
    password: string;
  }): OwnerProfile {
    if (this.hasOwner()) throw new Error("系统已经完成初始化");
    const displayName = input.displayName.trim().slice(0, 60) || "我的知流";
    const id = crypto.randomUUID();
    const createdAt = now();
    this.run(
      "INSERT INTO users(id,username,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
      id,
      "owner",
      displayName,
      hashPassword(input.password),
      "admin",
      createdAt,
    );
    return { id, displayName, createdAt };
  }

  authenticateOwner(password: string): OwnerProfile | undefined {
    const row = this.ownerRow();
    if (!row || !verifyPassword(password, rowString(row, "password_hash"))) return undefined;
    return mapOwner(row);
  }

  changePassword(currentPassword: string, newPassword: string): boolean {
    const userId = this.requireOwnerId();
    const row = this.maybeOne("SELECT password_hash FROM users WHERE id=?", userId);
    if (!row || !verifyPassword(currentPassword, rowString(row, "password_hash"))) return false;
    this.transaction(() => {
      this.run("UPDATE users SET password_hash=? WHERE id=?", hashPassword(newPassword), userId);
      this.run("DELETE FROM sessions WHERE user_id=?", userId);
    });
    return true;
  }

  createSession(days: number): { token: string; expiresAt: string } {
    const userId = this.requireOwnerId();
    const token = randomToken("session");
    const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
    this.run(
      "INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)",
      crypto.randomUUID(),
      userId,
      tokenHash(token),
      expiresAt,
      now(),
    );
    return { token, expiresAt };
  }

  ownerForSession(token: string): OwnerProfile | undefined {
    const row = this.maybeOne(
      `SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=? AND s.expires_at>?`,
      tokenHash(token),
      now(),
    );
    return row ? mapOwner(row) : undefined;
  }

  revokeSession(token: string): void {
    this.run("DELETE FROM sessions WHERE token_hash=?", tokenHash(token));
  }

  purgeExpired(): void {
    this.run("DELETE FROM sessions WHERE expires_at<=?", now());
  }

  ownerId(): string | undefined {
    const row = this.ownerRow();
    return row ? rowString(row, "id") : undefined;
  }

  private requireOwnerId(): string {
    const id = this.ownerId();
    if (!id) throw new Error("请先完成系统初始化");
    return id;
  }

  private ownerRow(): SqlRow | undefined {
    return this.maybeOne(
      `SELECT u.* FROM users u
       LEFT JOIN bot_accounts b ON b.tenant_id=u.id AND b.revoked_at IS NULL
       LEFT JOIN messages m ON m.tenant_id=u.id
       LEFT JOIN sync_targets t ON t.tenant_id=u.id AND t.revoked_at IS NULL
       GROUP BY u.id
       ORDER BY (COUNT(DISTINCT b.id)+COUNT(DISTINCT m.id)+COUNT(DISTINCT t.id)) DESC,
                CASE WHEN u.role='admin' THEN 0 ELSE 1 END,
                u.created_at
       LIMIT 1`,
    );
  }

  private enforceSingleOwner(): void {
    const owner = this.ownerRow();
    if (!owner) return;
    const ownerId = rowString(owner, "id");
    this.transaction(() => {
      this.database.exec("DROP TABLE IF EXISTS invitations");
      const otherRows = this.all("SELECT id FROM users WHERE id<>?", ownerId);
      for (const row of otherRows) {
        const otherId = rowString(row, "id");
        this.run("DELETE FROM sessions WHERE user_id=?", otherId);
        if (this.maybeOne("SELECT 1 AS found FROM tenant_settings WHERE tenant_id=?", ownerId)) {
          this.run("DELETE FROM tenant_settings WHERE tenant_id=?", otherId);
        } else {
          this.run("UPDATE tenant_settings SET tenant_id=? WHERE tenant_id=?", ownerId, otherId);
        }
        for (const skill of this.all("SELECT id,slug FROM tenant_skills WHERE tenant_id=?", otherId)) {
          const duplicate = this.maybeOne(
            "SELECT 1 AS found FROM tenant_skills WHERE tenant_id=? AND slug=?",
            ownerId,
            rowString(skill, "slug"),
          );
          if (duplicate) this.run("DELETE FROM tenant_skills WHERE id=?", rowString(skill, "id"));
          else this.run("UPDATE tenant_skills SET tenant_id=? WHERE id=?", ownerId, rowString(skill, "id"));
        }
        this.run("UPDATE bot_accounts SET tenant_id=? WHERE tenant_id=?", ownerId, otherId);
        this.run("UPDATE messages SET tenant_id=? WHERE tenant_id=?", ownerId, otherId);
        this.run("UPDATE sync_events SET tenant_id=? WHERE tenant_id=?", ownerId, otherId);
        this.run("UPDATE sync_targets SET tenant_id=?,is_primary=0 WHERE tenant_id=?", ownerId, otherId);
        this.run("UPDATE failed_inbound_events SET tenant_id=? WHERE tenant_id=?", ownerId, otherId);
        this.run("DELETE FROM users WHERE id=?", otherId);
      }
      const activePrimary = this.maybeOne(
        "SELECT 1 AS found FROM sync_targets WHERE tenant_id=? AND is_primary=1 AND revoked_at IS NULL",
        ownerId,
      );
      if (!activePrimary) {
        const firstTarget = this.maybeOne(
          "SELECT id FROM sync_targets WHERE tenant_id=? AND revoked_at IS NULL ORDER BY created_at LIMIT 1",
          ownerId,
        );
        if (firstTarget) this.run("UPDATE sync_targets SET is_primary=1 WHERE id=?", rowString(firstTarget, "id"));
      }
      this.run("UPDATE users SET role='admin' WHERE id=?", ownerId);
      this.setMetadata("single_owner_schema", "1");
    });
  }

  addBotAccount(account: IlinkAccount): StoredBotAccount {
    const ownerId = this.requireOwnerId();
    const existing = this.maybeOne("SELECT id FROM bot_accounts WHERE bot_id=?", account.botId);
    const id = existing ? rowString(existing, "id") : crypto.randomUUID();
    if (existing) {
      this.run(
        `UPDATE bot_accounts SET bot_token_enc=?,base_url=?,owner_user_id=?,connected_at=?,cursor='',
         state='stopped',last_error=NULL,revoked_at=NULL WHERE id=?`,
        this.secrets.encrypt(account.botToken),
        account.baseUrl,
        account.ownerUserId || null,
        account.connectedAt,
        id,
      );
    } else {
      this.run(
        `INSERT INTO bot_accounts(id,tenant_id,bot_id,bot_token_enc,base_url,owner_user_id,connected_at)
         VALUES(?,?,?,?,?,?,?)`,
        id,
        ownerId,
        account.botId,
        this.secrets.encrypt(account.botToken),
        account.baseUrl,
        account.ownerUserId || null,
        account.connectedAt,
      );
    }
    return this.getBotAccount(id)!;
  }

  getBotAccount(id: string): StoredBotAccount | undefined {
    const row = this.maybeOne("SELECT * FROM bot_accounts WHERE id=?", id);
    return row ? this.mapBot(row) : undefined;
  }

  getBotAccounts(): StoredBotAccount[] {
    const rows = this.all(
      "SELECT * FROM bot_accounts WHERE tenant_id=? AND revoked_at IS NULL ORDER BY connected_at",
      this.requireOwnerId(),
    );
    return rows.map((row) => this.mapBot(row));
  }

  removeBotAccount(id: string): boolean {
    return Number(
      this.run(
        "UPDATE bot_accounts SET revoked_at=?,state='removed' WHERE id=? AND tenant_id=? AND revoked_at IS NULL",
        now(),
        id,
        this.requireOwnerId(),
      ).changes,
    ) === 1;
  }

  updateBotCursor(id: string, cursor: string): void {
    this.run("UPDATE bot_accounts SET cursor=? WHERE id=?", cursor, id);
  }

  updateBotStatus(
    id: string,
    input: { state?: string; lastPollAt?: string; lastMessageAt?: string; lastError?: string | null },
  ): void {
    const current = this.getBotAccount(id);
    if (!current) return;
    this.run(
      `UPDATE bot_accounts SET state=?,last_poll_at=?,last_message_at=?,last_error=? WHERE id=?`,
      input.state ?? current.state,
      input.lastPollAt ?? current.lastPollAt ?? null,
      input.lastMessageAt ?? current.lastMessageAt ?? null,
      input.lastError === undefined ? current.lastError ?? null : input.lastError,
      id,
    );
  }

  clearInvalidBotToken(id: string): void {
    this.run("UPDATE bot_accounts SET state='needs_login',last_error=? WHERE id=?", "登录凭据已失效", id);
  }

  hasMessage(messageId: string): boolean {
    return Boolean(this.maybeOne("SELECT 1 AS found FROM messages WHERE id=?", messageId));
  }

  recordInboundFailure(input: {
    id: string;
    botAccountId: string;
    sourceId: string;
    senderId?: string;
    error: string;
    raw: unknown;
  }): void {
    const timestamp = now();
    this.run(
      `INSERT INTO failed_inbound_events(
        id,tenant_id,bot_account_id,source_id,sender_id,error,raw_json,first_failed_at,last_failed_at
       ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(bot_account_id,source_id) DO UPDATE SET
        error=excluded.error,raw_json=excluded.raw_json,attempts=failed_inbound_events.attempts+1,
        last_failed_at=excluded.last_failed_at`,
      input.id,
      this.requireOwnerId(),
      input.botAccountId,
      input.sourceId,
      input.senderId || null,
      input.error.slice(0, 2_000),
      JSON.stringify(input.raw),
      timestamp,
      timestamp,
    );
  }

  saveMessage(
    botAccountId: string,
    sourceId: string,
    message: PublicInboundMessage,
    note: ProcessedNote,
  ): boolean {
    if (this.hasMessage(message.id)) return false;
    const createdAt = now();
    this.transaction(() => {
      this.run(
        `INSERT INTO messages(
          id,tenant_id,bot_account_id,source_id,sender_id,session_id,received_at,sent_at,text,
          note_title,note_markdown,category,tags_json,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        message.id,
        this.requireOwnerId(),
        botAccountId,
        sourceId,
        message.senderId,
        message.sessionId || null,
        message.receivedAt,
        message.sentAt || null,
        message.text,
        note.title,
        note.markdown,
        note.category,
        JSON.stringify(note.tags),
        createdAt,
        createdAt,
      );
      for (const attachment of message.attachments) {
        const sha256 = crypto
          .createHash("sha256")
          .update(requireFileBuffer(attachment.path))
          .digest("hex");
        this.run(
          `INSERT INTO attachments(id,message_id,kind,file_name,storage_path,size,mime_type,transcript,sha256)
           VALUES(?,?,?,?,?,?,?,?,?)`,
          crypto.randomUUID(),
          message.id,
          attachment.kind,
          attachment.fileName,
          attachment.path,
          attachment.size,
          attachment.mimeType,
          attachment.transcript || null,
          sha256,
        );
      }
    });
    return true;
  }

  addAttachment(messageId: string, attachment: PublicInboundMessage["attachments"][number]): string {
    const ownerId = this.requireOwnerId();
    const message = this.maybeOne("SELECT id FROM messages WHERE id=? AND tenant_id=?", messageId, ownerId);
    if (!message) throw new Error("消息不存在");
    const content = requireFileBuffer(attachment.path);
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const existing = this.maybeOne(
      "SELECT id FROM attachments WHERE message_id=? AND kind=? AND sha256=?",
      messageId,
      attachment.kind,
      sha256,
    );
    if (existing) return rowString(existing, "id");
    const id = crypto.randomUUID();
    this.run(
      `INSERT INTO attachments(id,message_id,kind,file_name,storage_path,size,mime_type,transcript,sha256)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      id,
      messageId,
      attachment.kind,
      attachment.fileName,
      attachment.path,
      attachment.size,
      attachment.mimeType,
      attachment.transcript || null,
      sha256,
    );
    return id;
  }

  completeProcessedMessage(
    messageId: string,
    note: ProcessedNote,
    attachments: PublicInboundMessage["attachments"],
  ): void {
    this.transaction(() => {
      this.updateProcessedNote(messageId, note, "completed");
      for (const attachment of attachments) this.addAttachment(messageId, attachment);
    });
  }

  updateProcessedNote(
    messageId: string,
    note: ProcessedNote,
    status: "completed" | "fallback" | "failed",
    error?: string,
  ): void {
    const row = this.maybeOne(
      "SELECT note_title,note_markdown,category,tags_json,note_revision FROM messages WHERE id=? AND tenant_id=?",
      messageId,
      this.requireOwnerId(),
    );
    if (!row) throw new Error("消息不存在");
    const changed =
      rowString(row, "note_title") !== note.title ||
      rowString(row, "note_markdown") !== note.markdown ||
      rowString(row, "category") !== note.category ||
      rowString(row, "tags_json") !== JSON.stringify(note.tags);
    this.run(
      `UPDATE messages SET note_title=?,note_markdown=?,category=?,tags_json=?,
       note_revision=?,agent_status=?,agent_error=?,updated_at=? WHERE id=? AND tenant_id=?`,
      note.title,
      note.markdown,
      note.category,
      JSON.stringify(note.tags),
      rowNumber(row, "note_revision") + (changed ? 1 : 0),
      status,
      error || null,
      now(),
      messageId,
      this.requireOwnerId(),
    );
  }

  publishMessage(messageId: string): number {
    const row = this.one("SELECT * FROM messages WHERE id=?", messageId);
    const revision = rowNumber(row, "note_revision");
    if (rowNumber(row, "published_revision") >= revision) return 0;
    const attachments = this.attachmentsForMessage(messageId);
    const snapshot = {
      messageId,
      revision,
      title: rowString(row, "note_title"),
      fileName: noteFileName(rowString(row, "note_title"), messageId),
      markdown: rowString(row, "note_markdown"),
      receivedAt: rowString(row, "received_at"),
      attachments: attachments.map((item) => ({
        id: rowString(item, "id"),
        fileName: rowString(item, "file_name"),
        mimeType: rowString(item, "mime_type"),
        size: rowNumber(item, "size"),
        sha256: rowString(item, "sha256"),
      })),
    };
    let eventSeq = 0;
    this.transaction(() => {
      const result = this.run(
        `INSERT OR IGNORE INTO sync_events(tenant_id,message_id,revision,snapshot_json,created_at)
         VALUES(?,?,?,?,?)`,
        rowString(row, "tenant_id"),
        messageId,
        revision,
        JSON.stringify(snapshot),
        now(),
      );
      eventSeq = Number(result.lastInsertRowid || 0);
      this.run("UPDATE messages SET published_revision=? WHERE id=?", revision, messageId);
    });
    return eventSeq;
  }

  publishPendingMessages(): number {
    const rows = this.all(
      "SELECT id FROM messages WHERE published_revision < note_revision ORDER BY seq",
    );
    for (const row of rows) this.publishMessage(rowString(row, "id"));
    return rows.length;
  }

  listMessages(limit = 100, beforeSeq?: number): MessageListItem[] {
    const ownerId = this.requireOwnerId();
    const rows = beforeSeq
      ? this.all(
          `SELECT m.*,(SELECT COUNT(*) FROM attachments a WHERE a.message_id=m.id) AS attachment_count,
           CASE WHEN EXISTS(SELECT 1 FROM sync_targets t WHERE t.tenant_id=m.tenant_id AND t.is_primary=1 AND t.revoked_at IS NULL)
             THEN CASE WHEN COALESCE((SELECT MAX(e.seq) FROM sync_events e WHERE e.message_id=m.id),0)
               <= COALESCE((SELECT MAX(t.last_ack_seq) FROM sync_targets t WHERE t.tenant_id=m.tenant_id AND t.is_primary=1 AND t.revoked_at IS NULL),0)
               THEN 1 ELSE 0 END ELSE 0 END AS archived
           FROM messages m WHERE m.tenant_id=? AND m.seq<? ORDER BY m.seq DESC LIMIT ?`,
          ownerId,
          beforeSeq,
          limit,
        )
      : this.all(
          `SELECT m.*,(SELECT COUNT(*) FROM attachments a WHERE a.message_id=m.id) AS attachment_count,
           CASE WHEN EXISTS(SELECT 1 FROM sync_targets t WHERE t.tenant_id=m.tenant_id AND t.is_primary=1 AND t.revoked_at IS NULL)
             THEN CASE WHEN COALESCE((SELECT MAX(e.seq) FROM sync_events e WHERE e.message_id=m.id),0)
               <= COALESCE((SELECT MAX(t.last_ack_seq) FROM sync_targets t WHERE t.tenant_id=m.tenant_id AND t.is_primary=1 AND t.revoked_at IS NULL),0)
               THEN 1 ELSE 0 END ELSE 0 END AS archived
           FROM messages m WHERE m.tenant_id=? ORDER BY m.seq DESC LIMIT ?`,
          ownerId,
          limit,
        );
    return rows.map((row) => this.mapMessage(row));
  }

  getMessage(messageId: string): MessageListItem | undefined {
    const row = this.maybeOne(
      `SELECT m.*,(SELECT COUNT(*) FROM attachments a WHERE a.message_id=m.id) AS attachment_count,
       0 AS archived FROM messages m WHERE m.tenant_id=? AND m.id=?`,
      this.requireOwnerId(),
      messageId,
    );
    return row ? this.mapMessage(row) : undefined;
  }

  attachmentsForMessageView(messageId: string): MessageAttachmentView[] {
    return this.all(
      `SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id
       WHERE m.tenant_id=? AND m.id=? ORDER BY a.rowid`,
      this.requireOwnerId(),
      messageId,
    ).map((row) => {
      const mimeType = rowString(row, "mime_type");
      return {
        id: rowString(row, "id"),
        fileName: rowString(row, "file_name"),
        mimeType,
        size: rowNumber(row, "size"),
        sha256: rowString(row, "sha256"),
        kind: rowString(row, "kind"),
        transcript: rowOptional(row, "transcript"),
        previewable:
          mimeType.startsWith("image/") ||
          mimeType === "application/pdf" ||
          mimeType.startsWith("text/") ||
          ["application/json", "audio/mpeg", "video/mp4"].includes(mimeType),
      };
    });
  }

  attachmentForOwner(
    attachmentId: string,
  ): { path: string; fileName: string; mimeType: string; size: number } | undefined {
    const row = this.maybeOne(
      `SELECT a.storage_path,a.file_name,a.mime_type,a.size FROM attachments a
       JOIN messages m ON m.id=a.message_id WHERE m.tenant_id=? AND a.id=?`,
      this.requireOwnerId(),
      attachmentId,
    );
    return row
      ? {
          path: rowString(row, "storage_path"),
          fileName: rowString(row, "file_name"),
          mimeType: rowString(row, "mime_type"),
          size: rowNumber(row, "size"),
        }
      : undefined;
  }

  dashboard(): Record<string, number> {
    const ownerId = this.requireOwnerId();
    const messageCount = rowNumber(
      this.one("SELECT COUNT(*) AS count FROM messages WHERE tenant_id=?", ownerId),
      "count",
    );
    const eventMax = rowNumber(
      this.one("SELECT COALESCE(MAX(seq),0) AS value FROM sync_events WHERE tenant_id=?", ownerId),
      "value",
    );
    const primaryAck = rowNumber(
      this.one(
        "SELECT COALESCE(MAX(last_ack_seq),0) AS value FROM sync_targets WHERE tenant_id=? AND is_primary=1 AND revoked_at IS NULL",
        ownerId,
      ),
      "value",
    );
    return {
      messages: messageCount,
      pendingSync: rowNumber(
        this.one(
          "SELECT COUNT(DISTINCT message_id) AS count FROM sync_events WHERE tenant_id=? AND seq>?",
          ownerId,
          primaryAck,
        ),
        "count",
      ),
      archivedEvents: primaryAck,
      latestEvent: eventMax,
      botAccounts: rowNumber(
        this.one(
          "SELECT COUNT(*) AS count FROM bot_accounts WHERE tenant_id=? AND revoked_at IS NULL",
          ownerId,
        ),
        "count",
      ),
    };
  }

  getAgentSettings(defaults: { baseUrl: string; model: string; apiKey?: string }): AgentSettings {
    const row = this.maybeOne("SELECT * FROM tenant_settings WHERE tenant_id=?", this.requireOwnerId());
    if (!row) {
      return {
        enabled: false,
        baseUrl: defaults.baseUrl,
        model: defaults.model,
        instructions: "",
        autoReply: false,
        notifyOnFailure: true,
      };
    }
    return {
      enabled: Boolean(rowNumber(row, "nanobot_enabled")),
      baseUrl: defaults.baseUrl,
      apiKey: defaults.apiKey,
      model: "",
      instructions: rowString(row, "instructions"),
      autoReply: Boolean(rowNumber(row, "auto_reply")),
      notifyOnFailure: Boolean(rowNumber(row, "notify_on_failure")),
    };
  }

  saveAgentSettings(settings: AgentSettings): void {
    this.run(
      `INSERT INTO tenant_settings(
        tenant_id,nanobot_enabled,nanobot_base_url,nanobot_api_key_enc,nanobot_model,instructions,auto_reply,notify_on_failure,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET
        nanobot_enabled=excluded.nanobot_enabled,nanobot_base_url=excluded.nanobot_base_url,
        nanobot_api_key_enc=excluded.nanobot_api_key_enc,nanobot_model=excluded.nanobot_model,
        instructions=excluded.instructions,auto_reply=excluded.auto_reply,
        notify_on_failure=excluded.notify_on_failure,updated_at=excluded.updated_at`,
      this.requireOwnerId(),
      settings.enabled ? 1 : 0,
      settings.baseUrl,
      null,
      "",
      settings.instructions,
      settings.autoReply ? 1 : 0,
      settings.notifyOnFailure ? 1 : 0,
      now(),
    );
  }

  listSkills(): ManagedSkill[] {
    const ownerId = this.requireOwnerId();
    const overrides = new Map(
      this.all("SELECT * FROM tenant_skills WHERE tenant_id=? ORDER BY name", ownerId).map((row) => [
        rowString(row, "slug"),
        row,
      ]),
    );
    const builtins = BUILTIN_SKILLS.map((builtin) => {
      const override = overrides.get(builtin.slug);
      if (override) overrides.delete(builtin.slug);
      const runtime = builtin.kind === "adapter" ? this.runtimeSkillState(builtin.slug) : undefined;
      return {
        id: override ? rowString(override, "id") : `builtin:${builtin.slug}`,
        slug: builtin.slug,
        name: override ? rowString(override, "name") : builtin.name,
        description: override ? rowString(override, "description") : builtin.description,
        content: runtime?.content || (override ? rowString(override, "content") : builtin.content),
        builtin: true,
        enabled: runtime?.enabled ?? (override ? Boolean(rowNumber(override, "enabled")) : true),
        customized: runtime?.customized ?? Boolean(override),
        updatedAt: override ? rowString(override, "updated_at") : undefined,
        kind: builtin.kind,
        sourceUrl: builtin.sourceUrl,
        sourceRevision: builtin.sourceRevision,
      } satisfies ManagedSkill;
    });
    const custom = [...overrides.values()]
      .filter((row) => !Boolean(rowNumber(row, "is_builtin")))
      .map((row) => this.mapSkill(row));
    return [...builtins, ...custom];
  }

  getEnabledSkills(): ManagedSkill[] {
    return this.listSkills().filter((skill) => skill.enabled);
  }

  createSkill(
    input: { slug: string; name: string; description: string; content: string; enabled: boolean },
  ): ManagedSkill {
    const slug = skillSlug(input.slug || input.name);
    if (BUILTIN_SKILLS.some((skill) => skill.slug === slug)) {
      throw new Error("这个标识属于系统内置 Skill，请直接修改对应内置 Skill");
    }
    validateSkill(input);
    const id = crypto.randomUUID();
    const timestamp = now();
    this.run(
      `INSERT INTO tenant_skills(
        id,tenant_id,slug,name,description,content,is_builtin,enabled,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,0,?,?,?)`,
      id,
      this.requireOwnerId(),
      slug,
      input.name.trim(),
      input.description.trim(),
      input.content.trim(),
      input.enabled ? 1 : 0,
      timestamp,
      timestamp,
    );
    return this.listSkills().find((skill) => skill.id === id)!;
  }

  updateSkill(
    identifier: string,
    input: { name: string; description: string; content: string; enabled: boolean },
  ): ManagedSkill {
    validateSkill(input);
    let builtinSlug = identifier.startsWith("builtin:") ? identifier.slice(8) : undefined;
    if (!builtinSlug) {
      const existing = this.maybeOne(
        "SELECT slug,is_builtin FROM tenant_skills WHERE id=? AND tenant_id=?",
        identifier,
        this.requireOwnerId(),
      );
      if (existing && Boolean(rowNumber(existing, "is_builtin"))) {
        builtinSlug = rowString(existing, "slug");
      }
    }
    const builtin = builtinSlug
      ? BUILTIN_SKILLS.find((skill) => skill.slug === builtinSlug)
      : undefined;
    if (builtin) {
      const existing = this.maybeOne(
        "SELECT id FROM tenant_skills WHERE tenant_id=? AND slug=?",
        this.requireOwnerId(),
        builtin.slug,
      );
      const id = existing ? rowString(existing, "id") : crypto.randomUUID();
      const timestamp = now();
      this.run(
        `INSERT INTO tenant_skills(
          id,tenant_id,slug,name,description,content,is_builtin,enabled,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,1,?,?,?) ON CONFLICT(tenant_id,slug) DO UPDATE SET
          name=excluded.name,description=excluded.description,content=excluded.content,
          enabled=excluded.enabled,updated_at=excluded.updated_at`,
        id,
        this.requireOwnerId(),
        builtin.slug,
        input.name.trim(),
        input.description.trim(),
        input.content.trim(),
        input.enabled ? 1 : 0,
        timestamp,
        timestamp,
      );
      this.updateRuntimeSkill(builtin.slug, input.content.trim(), input.enabled);
      return this.listSkills().find((skill) => skill.slug === builtin.slug)!;
    }
    const result = this.run(
      `UPDATE tenant_skills SET name=?,description=?,content=?,enabled=?,updated_at=?
       WHERE id=? AND tenant_id=? AND is_builtin=0`,
      input.name.trim(),
      input.description.trim(),
      input.content.trim(),
      input.enabled ? 1 : 0,
      now(),
      identifier,
      this.requireOwnerId(),
    );
    if (!Number(result.changes)) throw new Error("自定义 Skill 不存在");
    return this.listSkills().find((skill) => skill.id === identifier)!;
  }

  deleteOrResetSkill(identifier: string): "reset" | "deleted" {
    const existing = identifier.startsWith("builtin:")
      ? undefined
      : this.maybeOne(
          "SELECT slug,is_builtin FROM tenant_skills WHERE id=? AND tenant_id=?",
          identifier,
          this.requireOwnerId(),
        );
    if (identifier.startsWith("builtin:") || (existing && Boolean(rowNumber(existing, "is_builtin")))) {
      const slug = identifier.startsWith("builtin:") ? identifier.slice(8) : rowString(existing!, "slug");
      if (!BUILTIN_SKILLS.some((skill) => skill.slug === slug)) throw new Error("内置 Skill 不存在");
      this.run("DELETE FROM tenant_skills WHERE tenant_id=? AND slug=? AND is_builtin=1", this.requireOwnerId(), slug);
      this.restoreRuntimeSkill(slug);
      return "reset";
    }
    const result = this.run(
      "DELETE FROM tenant_skills WHERE id=? AND tenant_id=? AND is_builtin=0",
      identifier,
      this.requireOwnerId(),
    );
    if (!Number(result.changes)) throw new Error("自定义 Skill 不存在");
    return "deleted";
  }

  createSyncTarget(
    input: { name: string; folder: string; primary: boolean },
  ): { target: SyncTarget; token: string } {
    const id = crypto.randomUUID();
    const token = randomToken("obsidian");
    const ownerId = this.requireOwnerId();
    if (input.primary) this.run("UPDATE sync_targets SET is_primary=0 WHERE tenant_id=?", ownerId);
    const hasTarget = rowNumber(
      this.one("SELECT COUNT(*) AS count FROM sync_targets WHERE tenant_id=? AND revoked_at IS NULL", ownerId),
      "count",
    );
    const primary = input.primary || hasTarget === 0;
    this.run(
      `INSERT INTO sync_targets(id,tenant_id,name,folder,token_hash,is_primary,created_at)
       VALUES(?,?,?,?,?,?,?)`,
      id,
      ownerId,
      input.name.trim().slice(0, 80) || "Obsidian",
      normalizeFolder(input.folder),
      tokenHash(token),
      primary ? 1 : 0,
      now(),
    );
    return { target: this.getSyncTarget(id)!, token };
  }

  listSyncTargets(): SyncTarget[] {
    return this.all(
      "SELECT * FROM sync_targets WHERE tenant_id=? AND revoked_at IS NULL ORDER BY created_at",
      this.requireOwnerId(),
    ).map(
      (row) => this.mapSyncTarget(row),
    );
  }

  syncTargetForToken(token: string): SyncTarget | undefined {
    const row = this.maybeOne(
      "SELECT * FROM sync_targets WHERE token_hash=? AND revoked_at IS NULL",
      tokenHash(token),
    );
    if (!row) return undefined;
    return this.mapSyncTarget(row);
  }

  revokeSyncTarget(targetId: string): boolean {
    return Number(
      this.run(
        "UPDATE sync_targets SET revoked_at=? WHERE id=? AND tenant_id=? AND revoked_at IS NULL",
        now(),
        targetId,
        this.requireOwnerId(),
      ).changes,
    ) === 1;
  }

  getOrCreateSyncBatch(targetId: string, batchSize: number): SyncBatch {
    const existing = this.maybeOne(
      "SELECT * FROM sync_batches WHERE target_id=? AND status='open' ORDER BY created_at DESC LIMIT 1",
      targetId,
    );
    if (existing) return this.hydrateBatch(existing);
    const target = this.one("SELECT * FROM sync_targets WHERE id=? AND revoked_at IS NULL", targetId);
    const tenantId = rowString(target, "tenant_id");
    const fromSeq = rowNumber(target, "last_ack_seq");
    const events = this.all(
      `SELECT e.* FROM sync_events e
       JOIN (SELECT message_id,MAX(revision) AS revision FROM sync_events WHERE tenant_id=? AND seq>? GROUP BY message_id) latest
       ON latest.message_id=e.message_id AND latest.revision=e.revision
       WHERE e.tenant_id=? AND e.seq>? ORDER BY e.seq LIMIT ?`,
      tenantId,
      fromSeq,
      tenantId,
      fromSeq,
      batchSize,
    );
    const nextCursor = events.length ? Math.max(...events.map((row) => rowNumber(row, "seq"))) : fromSeq;
    if (!events.length) {
      this.run("UPDATE sync_targets SET last_seen_at=? WHERE id=?", now(), targetId);
      return {
        fromCursor: fromSeq,
        nextCursor: fromSeq,
        hasMore: false,
        items: [],
      };
    }
    const remaining = rowNumber(
      this.one("SELECT COUNT(*) AS count FROM sync_events WHERE tenant_id=? AND seq>?", tenantId, nextCursor),
      "count",
    );
    const id = crypto.randomUUID();
    this.transaction(() => {
      this.run(
        `INSERT INTO sync_batches(id,target_id,from_seq,to_seq,has_more,status,created_at)
         VALUES(?,?,?,?,?,'open',?)`,
        id,
        targetId,
        fromSeq,
        nextCursor,
        remaining > 0 ? 1 : 0,
        now(),
      );
      for (const event of events) {
        this.run(
          "INSERT INTO sync_batch_items(batch_id,event_seq) VALUES(?,?)",
          id,
          rowNumber(event, "seq"),
        );
      }
      this.run("UPDATE sync_targets SET last_seen_at=? WHERE id=?", now(), targetId);
    });
    return this.hydrateBatch(this.one("SELECT * FROM sync_batches WHERE id=?", id));
  }

  acknowledgeSyncBatch(targetId: string, batchId: string): { cursor: number } {
    const batch = this.maybeOne(
      "SELECT * FROM sync_batches WHERE id=? AND target_id=? AND status='open'",
      batchId,
      targetId,
    );
    if (!batch) throw new Error("同步批次不存在、已完成或不属于这个设备");
    const cursor = rowNumber(batch, "to_seq");
    this.transaction(() => {
      this.run("UPDATE sync_batches SET status='acked',acked_at=? WHERE id=?", now(), batchId);
      this.run(
        "UPDATE sync_targets SET last_ack_seq=MAX(last_ack_seq,?),last_seen_at=? WHERE id=?",
        cursor,
        now(),
        targetId,
      );
    });
    return { cursor };
  }

  attachmentForTarget(
    targetId: string,
    attachmentId: string,
  ): { path: string; fileName: string; mimeType: string; size: number } | undefined {
    const row = this.maybeOne(
      `SELECT a.storage_path,a.file_name,a.mime_type,a.size FROM attachments a
       JOIN messages m ON m.id=a.message_id JOIN sync_targets t ON t.tenant_id=m.tenant_id
       WHERE t.id=? AND t.revoked_at IS NULL AND a.id=?`,
      targetId,
      attachmentId,
    );
    return row
      ? {
          path: rowString(row, "storage_path"),
          fileName: rowString(row, "file_name"),
          mimeType: rowString(row, "mime_type"),
          size: rowNumber(row, "size"),
        }
      : undefined;
  }

  async claimLegacyData(): Promise<{ account: boolean; messages: number }> {
    if (this.metadata("legacy_claimed") === "1") return { account: false, messages: 0 };
    const statePath = path.join(this.dataDir, "state.json");
    let accountAdded = false;
    let messageCount = 0;
    let botAccount: StoredBotAccount | undefined;
    try {
      const state = safeJson<{ account?: IlinkAccount; cursor?: string }>(
        await fs.readFile(statePath, "utf8"),
        {},
      );
      if (state.account) {
        botAccount = this.addBotAccount(state.account);
        if (state.cursor) this.updateBotCursor(botAccount.id, state.cursor);
        accountAdded = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (botAccount) {
      const inboxDir = path.join(this.dataDir, "inbox");
      try {
        const files = (await fs.readdir(inboxDir)).filter((file) => file.endsWith(".jsonl")).sort();
        for (const file of files) {
          const lines = (await fs.readFile(path.join(inboxDir, file), "utf8")).split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            const message = safeJson<PublicInboundMessage | undefined>(line, undefined);
            if (!message?.id || this.hasMessage(message.id)) continue;
            const sourceId = message.id.split(":").at(-1) || message.id;
            const title = message.text.trim().split("\n")[0]?.slice(0, 60) || "微信附件";
            const note: ProcessedNote = {
              title,
              category: "inbox",
              tags: ["微信收件"],
              markdown: legacyMarkdown(message, title),
            };
            this.saveMessage(botAccount.id, sourceId, message, note);
            this.updateProcessedNote(message.id, note, "fallback");
            this.publishMessage(message.id);
            messageCount += 1;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.setMetadata("legacy_claimed", "1");
    return { account: accountAdded, messages: messageCount };
  }

  private mapBot(row: SqlRow): StoredBotAccount {
    return {
      id: rowString(row, "id"),
      botToken: this.secrets.decrypt(rowString(row, "bot_token_enc")),
      botId: rowString(row, "bot_id"),
      baseUrl: rowString(row, "base_url"),
      ownerUserId: rowOptional(row, "owner_user_id"),
      connectedAt: rowString(row, "connected_at"),
      cursor: rowString(row, "cursor"),
      state: rowString(row, "state"),
      lastPollAt: rowOptional(row, "last_poll_at"),
      lastMessageAt: rowOptional(row, "last_message_at"),
      lastError: rowOptional(row, "last_error"),
    };
  }

  private mapMessage(row: SqlRow): MessageListItem {
    return {
      seq: rowNumber(row, "seq"),
      id: rowString(row, "id"),
      receivedAt: rowString(row, "received_at"),
      sentAt: rowOptional(row, "sent_at"),
      senderId: rowString(row, "sender_id"),
      text: rowString(row, "text"),
      category: rowString(row, "category"),
      tags: safeJson<string[]>(rowString(row, "tags_json"), []),
      title: rowString(row, "note_title"),
      markdown: rowString(row, "note_markdown"),
      revision: rowNumber(row, "note_revision"),
      agentStatus: rowString(row, "agent_status"),
      agentError: rowOptional(row, "agent_error"),
      attachmentCount: rowNumber(row, "attachment_count"),
      archived: Boolean(rowNumber(row, "archived")),
    };
  }

  private getSyncTarget(id: string): SyncTarget | undefined {
    const row = this.maybeOne("SELECT * FROM sync_targets WHERE id=?", id);
    return row ? this.mapSyncTarget(row) : undefined;
  }

  private mapSyncTarget(row: SqlRow): SyncTarget {
    return {
      id: rowString(row, "id"),
      name: rowString(row, "name"),
      folder: rowString(row, "folder"),
      primary: Boolean(rowNumber(row, "is_primary")),
      lastAckSeq: rowNumber(row, "last_ack_seq"),
      lastSeenAt: rowOptional(row, "last_seen_at"),
      createdAt: rowString(row, "created_at"),
      revoked: Boolean(rowOptional(row, "revoked_at")),
    };
  }

  private mapSkill(row: SqlRow): ManagedSkill {
    return {
      id: rowString(row, "id"),
      slug: rowString(row, "slug"),
      name: rowString(row, "name"),
      description: rowString(row, "description"),
      content: rowString(row, "content"),
      builtin: Boolean(rowNumber(row, "is_builtin")),
      enabled: Boolean(rowNumber(row, "enabled")),
      customized: Boolean(rowNumber(row, "is_builtin")),
      updatedAt: rowString(row, "updated_at"),
      kind: "prompt",
    };
  }

  private hydrateBatch(row: SqlRow): SyncBatch {
    const items = this.all(
      `SELECT e.* FROM sync_batch_items i JOIN sync_events e ON e.seq=i.event_seq
       WHERE i.batch_id=? ORDER BY e.seq`,
      rowString(row, "id"),
    ).map((event) => {
      const snapshot = safeJson<Omit<SyncItem, "eventSeq">>(rowString(event, "snapshot_json"), {
        messageId: rowString(event, "message_id"),
        revision: rowNumber(event, "revision"),
        title: "微信收件",
        fileName: `微信收件-${rowNumber(event, "seq")}.md`,
        markdown: "",
        receivedAt: rowString(event, "created_at"),
        attachments: [],
      });
      return { eventSeq: rowNumber(event, "seq"), ...snapshot };
    });
    return {
      batchId: rowString(row, "id"),
      fromCursor: rowNumber(row, "from_seq"),
      nextCursor: rowNumber(row, "to_seq"),
      hasMore: Boolean(rowNumber(row, "has_more")),
      items,
    };
  }

  private attachmentsForMessage(messageId: string): SqlRow[] {
    return this.all("SELECT * FROM attachments WHERE message_id=? ORDER BY rowid", messageId);
  }

  private metadata(key: string): string | undefined {
    const row = this.maybeOne("SELECT value FROM metadata WHERE key=?", key);
    return row ? rowString(row, "value") : undefined;
  }

  private setMetadata(key: string, value: string): void {
    this.run(
      "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      value,
    );
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private prepare(sql: string): StatementSync {
    return this.database.prepare(sql);
  }

  private run(sql: string, ...parameters: SqlValue[]): ReturnType<StatementSync["run"]> {
    return this.prepare(sql).run(...parameters);
  }

  private all(sql: string, ...parameters: SqlValue[]): SqlRow[] {
    return this.prepare(sql).all(...parameters) as SqlRow[];
  }

  private maybeOne(sql: string, ...parameters: SqlValue[]): SqlRow | undefined {
    return this.prepare(sql).get(...parameters) as SqlRow | undefined;
  }

  private one(sql: string, ...parameters: SqlValue[]): SqlRow {
    const row = this.maybeOne(sql, ...parameters);
    if (!row) throw new Error("数据库记录不存在");
    return row;
  }
}

function normalizeFolder(folder: string): string {
  const normalized = folder
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return normalized.slice(0, 200) || "Inbox/微信";
}

function requireFileBuffer(filePath: string): Buffer {
  // Attachment content was just written by the receiver. Keeping this synchronous makes
  // the message row and all attachment checksums one atomic database operation.
  return requireFile(filePath);
}

function requireFile(filePath: string): Buffer {
  const descriptor = fsSyncOpen(filePath, "r");
  try {
    return fsSyncRead(descriptor);
  } finally {
    fsSyncClose(descriptor);
  }
}

import { closeSync as fsSyncClose, openSync as fsSyncOpen, readFileSync as fsSyncRead } from "node:fs";

function legacyMarkdown(message: PublicInboundMessage, title: string): string {
  const attachmentLines = message.attachments.map(
    (item) => `- ${item.fileName}（${item.mimeType}，${item.size} bytes）`,
  );
  return [
    "---",
    `title: ${JSON.stringify(title)}`,
    `source: wechat-ilink`,
    `message_id: ${JSON.stringify(message.id)}`,
    `received_at: ${JSON.stringify(message.receivedAt)}`,
    "tags:",
    "  - 微信收件",
    "---",
    "",
    `# ${title}`,
    "",
    message.text || "（仅包含附件）",
    ...(attachmentLines.length ? ["", "## 附件", "", ...attachmentLines] : []),
    "",
  ].join("\n");
}
