import crypto from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import {
  firstHttpUrl,
  inferCaptureType,
  wechatCaptureSource,
  type CaptureInput,
  type CaptureSourceType,
  type CaptureType,
} from "../capture.js";
import type { IlinkAccount } from "../ilink/types.js";
import type { PublicInboundMessage } from "../messages.js";
import { compactKnowledgePoint } from "../semantic-labels.js";
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
  username: string;
  displayName: string;
  role: "admin" | "member";
  createdAt: string;
  disabled: boolean;
};

export type StoredBotAccount = IlinkAccount & {
  id: string;
  tenantId: string;
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
  summary?: string;
  keyPoints?: string[];
  knowledgePoints?: string[];
  domains?: string[];
  tools?: string[];
  detailsMarkdown?: string;
  reason?: string;
  suggestedAction?: "none" | "knowledge" | "research" | "project" | "resource" | "practice" | "delete";
  sensitivity?: "public" | "internal" | "confidential" | "restricted";
  confidence?: "high" | "medium" | "low";
  warnings?: string[];
};

export type MessageListItem = {
  seq: number;
  id: string;
  receivedAt: string;
  sentAt?: string;
  senderId: string;
  text: string;
  contentFormat: ContentFormat;
  category: string;
  tags: string[];
  summary: string;
  keyPoints: string[];
  knowledgePoints: string[];
  domains: string[];
  tools: string[];
  title: string;
  markdown: string;
  revision: number;
  agentStatus: string;
  agentError?: string;
  agentAttempts: number;
  agentStartedAt?: string;
  agentCompletedAt?: string;
  attachmentCount: number;
  archived: boolean;
  libraryState: "inbox" | "library" | "archived";
  favorite: boolean;
  readAt?: string;
  coverAttachmentId?: string;
  coverMimeType?: string;
};

export type ContentFormat =
  | "wechat_article"
  | "web_article"
  | "document"
  | "image"
  | "audio"
  | "video"
  | "mixed"
  | "text";

export type MessageDetail = MessageListItem & {
  contentMarkdown: string;
  detailsMarkdown: string;
  reason: string;
  suggestedAction: "none" | "knowledge" | "research" | "project" | "resource" | "practice" | "delete";
  sensitivity: "public" | "internal" | "confidential" | "restricted";
  confidence: "high" | "medium" | "low";
  warnings: string[];
  source: {
    type: CaptureSourceType;
    name: string;
    url: string;
  };
  captureType: CaptureType;
};

export type KnowledgeMapNode = {
  id: string;
  label: string;
  type: "root" | "resource" | "domain" | "concept" | "tool" | "point";
  count?: number;
};

export type KnowledgeDiagramType = "mindmap" | "relationship" | "flow" | "timeline" | "comparison" | "sequence" | "state";

export type KnowledgeMapEdge = {
  source: string;
  target: string;
  label?: string;
  kind?: "primary" | "secondary";
};

export type KnowledgeMap = {
  scope: "library" | "resource";
  diagramType: KnowledgeDiagramType;
  diagramLabel: string;
  selectionReason: string;
  generatedAt: string;
  truncated: boolean;
  nodes: KnowledgeMapNode[];
  edges: KnowledgeMapEdge[];
};

export type StoredKnowledgeDiagram = KnowledgeMap & {
  messageId: string;
  noteRevision: number;
};

export function selectKnowledgeDiagram(
  item: Pick<MessageListItem, "title" | "summary" | "keyPoints" | "knowledgePoints" | "domains" | "tools">,
): Pick<KnowledgeMap, "diagramType" | "diagramLabel" | "selectionReason"> {
  const text = [
    item.title,
    item.summary,
    ...item.keyPoints,
    ...item.knowledgePoints,
  ].join("\n");
  const dateCount = (text.match(/(?:19|20)\d{2}(?:[年./-]\d{1,2})?/g) || []).length;
  const comparison = (/(?:对比|比较|横向评测|\bvs\.?\b|versus|跑赢|胜过|不如|优劣|差异|相比)/i.test(text) ? 2 : 0)
    + (/(?:成功率|命中率|成本|价格|性能|效率|排名|准确率|延迟|吞吐)/i.test(text) ? 1 : 0)
    + (item.tools.length >= 2 ? 1 : 0);
  if (comparison >= 3) {
    return { diagramType: "comparison", diagramLabel: "对比图", selectionReason: "检测到多个比较对象和评测维度" };
  }
  if (dateCount >= 3 || /(?:时间线|发展史|演进|历程|沿革|年代|先后变化)/i.test(text)) {
    return { diagramType: "timeline", diagramLabel: "时间线", selectionReason: "检测到连续时间节点或演进过程" };
  }
  if (/(?:状态机|状态流转|生命周期|待处理.*处理中|处理中.*完成|失败.*重试|恢复路径)/i.test(text)) {
    return { diagramType: "state", diagramLabel: "状态图", selectionReason: "检测到明确状态及其转换关系" };
  }
  if (/(?:关系|依赖|影响|架构|生态|协作|关联|组成)/i.test(text)
    && item.tools.length + item.knowledgePoints.length >= 3) {
    return { diagramType: "relationship", diagramLabel: "关系图", selectionReason: "内容以概念、工具和影响关系为主" };
  }
  const sequenceScore = (/(?:请求|响应|回调|消息传递|认证交互|客户端|服务端|网关|调用链|调用.+(?:返回|响应))/i.test(text) ? 1 : 0)
    + (item.tools.length >= 3 ? 1 : 0)
    + (/(?:API|HTTP|Webhook|Runtime|Agent)/i.test(text) ? 1 : 0);
  if (sequenceScore >= 3) {
    return { diagramType: "sequence", diagramLabel: "交互图", selectionReason: "检测到多个系统组件之间的交互" };
  }
  const flowScore = (/(?:流程|步骤|工作流|处理链路|操作链路|部署|安装|配置过程|方法论|阶段)/i.test(text) ? 1 : 0)
    + (/(?:首先|然后|随后|接着|最后|第一步|第二步|第\d+步)/i.test(text) ? 1 : 0)
    + (item.keyPoints.length >= 4 ? 1 : 0);
  if (flowScore >= 2) {
    return { diagramType: "flow", diagramLabel: "流程图", selectionReason: "检测到可排序的步骤或处理链路" };
  }
  if (item.tools.length + item.knowledgePoints.length >= 5 || /(?:关系|依赖|影响|架构|生态|协作|关联|组成)/i.test(text)) {
    return { diagramType: "relationship", diagramLabel: "关系图", selectionReason: "内容以概念、工具和影响关系为主" };
  }
  return { diagramType: "mindmap", diagramLabel: "思维导图", selectionReason: "内容以主题层级和概念发散为主" };
}

export type ApiToken = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  revoked: boolean;
};

export type KnowledgeFacet = { name: string; count: number };

export type KnowledgeFacets = {
  total: number;
  enriched: number;
  facetTotals: {
    categories: number;
    domains: number;
    knowledgePoints: number;
    tools: number;
  };
  categories: KnowledgeFacet[];
  domains: KnowledgeFacet[];
  knowledgePoints: KnowledgeFacet[];
  tools: KnowledgeFacet[];
};

export type InboxSearchResult = MessageListItem & { excerpt: string };

export type MessageListOptions = {
  state?: "inbox" | "library" | "archived";
  active?: boolean;
  favorite?: boolean;
  format?: ContentFormat;
  category?: string;
  domain?: string;
  organized?: boolean;
  query?: string;
};

export type DashboardStats = {
  messages: number;
  organized: number;
  pending: number;
  queued: number;
  activeProcessing: number;
  libraryItems: number;
  favorites: number;
  processing: number;
  fallback: number;
  pendingSync: number;
  archivedEvents: number;
  latestEvent: number;
  botAccounts: number;
};

export type InboxSearchOptions = {
  limit?: number;
  organized?: boolean;
  category?: string;
  domain?: string;
  knowledgePoint?: string;
  tool?: string;
  receivedAfter?: string;
  receivedBefore?: string;
};

export type PendingAgentMessage = {
  capture: CaptureInput;
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
  id: string;
  messageId: string;
  revision: number;
  version: string;
  title: string;
  fileName: string;
  markdown: string;
  contentMarkdown: string;
  receivedAt: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  keyPoints: string[];
  detailsMarkdown: string;
  reason: string;
  suggestedAction: "none" | "knowledge" | "research" | "project" | "resource" | "practice" | "delete";
  source: {
    type: CaptureSourceType;
    name: string;
    url: string;
  };
  captureType: CaptureType;
  originalText: string;
  tags: string[];
  sensitivity: "public" | "internal" | "confidential" | "restricted";
  deleted: false;
  processing: {
    processor: "nanobot" | "deterministic";
    status: "pending" | "enriched" | "fallback" | "failed";
    pipelineVersion: "knowledge-relay-inbox-v1" | "knowledge-relay-inbox-v2";
    processedAt: string;
    confidence: "high" | "medium" | "low";
    warnings: string[];
  };
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

function contentFormatSql(alias = "m"): string {
  return `CASE
    WHEN ${alias}.source_type='wechat_article' THEN 'wechat_article'
    WHEN ${alias}.source_type='web' OR ${alias}.capture_type='link' THEN 'web_article'
    WHEN ${alias}.capture_type='mixed' THEN 'mixed'
    WHEN ${alias}.capture_type='image' OR ${alias}.category='image' THEN 'image'
    WHEN ${alias}.category IN ('voice','audio') THEN 'audio'
    WHEN ${alias}.category='video' THEN 'video'
    WHEN ${alias}.capture_type='file' OR ${alias}.category='document' THEN 'document'
    ELSE 'text' END`;
}

function contentFormatFromRow(row: SqlRow): ContentFormat {
  const sourceType = rowString(row, "source_type");
  const captureType = rowString(row, "capture_type");
  const category = rowString(row, "category");
  if (sourceType === "wechat_article") return "wechat_article";
  if (sourceType === "web" || captureType === "link") return "web_article";
  if (captureType === "mixed") return "mixed";
  if (captureType === "image" || category === "image") return "image";
  if (category === "voice" || category === "audio") return "audio";
  if (category === "video") return "video";
  if (captureType === "file" || category === "document") return "document";
  return "text";
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

function normalizedSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function searchTokens(value: string): string[] {
  const normalized = normalizedSearchText(value).slice(0, 40_000);
  const tokens = new Set<string>();
  for (const word of normalized.match(/[a-z0-9][a-z0-9_.+#/-]{1,63}/g) || []) tokens.add(word);
  for (const block of normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/gu) || []) {
    const characters = Array.from(block);
    if (characters.length === 2) tokens.add(block);
    for (let index = 0; index < characters.length - 1; index += 1) {
      tokens.add(characters.slice(index, index + 2).join(""));
      if (tokens.size >= 4_000) break;
    }
    if (tokens.size >= 4_000) break;
  }
  return Array.from(tokens);
}

function indexedSearchText(value: string): string {
  return searchTokens(value).join(" ");
}

function querySearchTokens(value: string): string[] {
  const cleaned = normalizedSearchText(value)
    .replace(/(?:微信公众号|公众号)/g, " mp.weixin.qq.com ")
    .replace(/(?:请|麻烦)?(?:帮我|帮忙)?(?:查找|搜索|检索|看看|看下|找找|找一下)/g, " ")
    .replace(/(?:我)?(?:之前|以前)?(?:收藏|保存|发送|发)(?:过|的)?/g, " ")
    .replace(/(?:我之前|我有没有|有没有|是否有|有哪(?:些)?|哪些|什么)(?:和|与|关于)?/g, " ")
    .replace(/(?:相关的?|有关的?|关于|内容|资料|消息|收件箱|工具)/g, " ")
    .replace(/[?？!！,，。；;：:()（）\[\]{}“”‘’]/g, " ");
  return searchTokens(cleaned).slice(0, 12);
}

function likeValue(value: string): string {
  return `%${value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

function cleanFacetValue(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 80) : "";
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

function stripNoteEnvelope(markdown: string): string {
  return markdown
    .replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "")
    .replace(/^#\s+[^\r\n]+\r?\n+/, "")
    .trim();
}

function noteSummary(markdown: string, fallback: string): string {
  const body = stripNoteEnvelope(markdown);
  const quote = body.match(/^>\s+(.+)$/m)?.[1];
  const line = quote || body.split(/\r?\n/).map((item) => item.replace(/^#+\s*/, "").trim()).find(Boolean) || fallback;
  return line.replace(/\s+/g, " ").slice(0, 500);
}

function firstWebUrl(text: string): string {
  const candidate = text.match(/https?:\/\/[^\s)>\]]+/i)?.[0] || "";
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function syncAction(category: string): SyncItem["suggestedAction"] {
  if (category === "task") return "project";
  if (["reference", "document", "image", "voice", "video"].includes(category)) return "resource";
  return "none";
}

function noteReason(markdown: string): string {
  const marker = markdown.lastIndexOf("> [!info] Agent 建议");
  if (marker < 0) return "";
  const beforeAdvice = markdown.slice(0, marker);
  const matches = [...beforeAdvice.matchAll(/^##\s+为什么值得保留\s*$/gm)];
  const heading = matches.at(-1);
  if (!heading || heading.index === undefined) return "";
  return beforeAdvice.slice(heading.index + heading[0].length).split(/^##\s+/m)[0]!
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function agentAdvice(markdown: string): string {
  const marker = markdown.lastIndexOf("> [!info] Agent 建议");
  return marker >= 0 ? markdown.slice(marker) : "";
}

function noteAction(markdown: string, category: string): SyncItem["suggestedAction"] {
  const label = agentAdvice(markdown).match(/^>\s*建议方向：(.+)$/m)?.[1]?.trim();
  const values: Record<string, SyncItem["suggestedAction"]> = {
    暂无建议: "none",
    知识卡片: "knowledge",
    研究课题: "research",
    项目: "project",
    学习资源: "resource",
    安全实践: "practice",
    建议删除: "delete",
  };
  return label && values[label] ? values[label] : syncAction(category);
}

function noteSensitivity(markdown: string): SyncItem["sensitivity"] {
  const label = agentAdvice(markdown).match(/^>\s*敏感级别：(.+)$/m)?.[1]?.trim();
  return ({ 公开: "public", 内部: "internal", 机密: "confidential", 严格受限: "restricted" } as const)[
    label as "公开" | "内部" | "机密" | "严格受限"
  ] || "internal";
}

function noteConfidence(markdown: string): SyncItem["processing"]["confidence"] {
  const label = agentAdvice(markdown).match(/^>\s*置信度：(.+)$/m)?.[1]?.trim();
  return ({ 高: "high", 中: "medium", 低: "low" } as const)[label as "高" | "中" | "低"] || "low";
}

function noteWarnings(markdown: string, status: SyncItem["processing"]["status"]): string[] {
  const warningBlock = agentAdvice(markdown).match(/^>\s*\[!warning\][^\r\n]*\r?\n((?:>[^\r\n]*(?:\r?\n|$))+)/m)?.[1] || "";
  const warnings = warningBlock
    .split(/\r?\n/)
    .map((line) => line.replace(/^>\s?/, "").trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, 10);
  if (!warnings.length && (status === "fallback" || status === "failed")) {
    warnings.push("智能整理暂时不可用，已保留原始内容。");
  }
  return warnings;
}

function processingStatus(value: string): SyncItem["processing"]["status"] {
  if (value === "completed") return "enriched";
  if (value === "failed") return "failed";
  if (value === "fallback") return "fallback";
  return "pending";
}

function mapOwner(row: SqlRow): OwnerProfile {
  return {
    id: rowString(row, "id"),
    username: rowString(row, "username"),
    displayName: rowString(row, "display_name"),
    role: rowString(row, "role") === "admin" ? "admin" : "member",
    createdAt: rowString(row, "created_at"),
    disabled: Boolean(rowOptional(row, "disabled_at")),
  };
}

export class AppDatabase {
  private constructor(
    readonly dataDir: string,
    private readonly nanobotWorkspace: string,
    private readonly database: DatabaseSync,
    private readonly secrets: SecretBox,
    private readonly tenantId?: string,
    private readonly ownsConnection = true,
  ) {}

  static async open(
    dataDir: string,
    nanobotWorkspace = path.join(dataDir, "nanobot", "workspace"),
  ): Promise<AppDatabase> {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const secrets = await SecretBox.load(dataDir);
    const database = new DatabaseSync(path.join(dataDir, "inbox.sqlite"));
    database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    database.function("compact_knowledge_point", (value) => compactKnowledgePoint(value));
    const result = new AppDatabase(dataDir, path.resolve(nanobotWorkspace), database, secrets);
    result.migrate();
    return result;
  }

  close(): void {
    if (this.ownsConnection) this.database.close();
  }

  /**
   * Return a lightweight request-scoped view over the same SQLite connection.
   * Every tenant-owned query below resolves requireOwnerId() to this immutable
   * id, preventing a route from accidentally falling back to another user.
   */
  forTenant(tenantId: string): AppDatabase {
    const user = this.maybeOne("SELECT id FROM users WHERE id=?", tenantId);
    if (!user) throw new Error("用户不存在");
    return new AppDatabase(
      this.dataDir,
      this.nanobotWorkspace,
      this.database,
      this.secrets,
      tenantId,
      false,
    );
  }

  currentTenantId(): string | undefined {
    return this.tenantId;
  }

  healthCheck(): boolean {
    try {
      return rowNumber(this.one("SELECT 1 AS ok"), "ok") === 1;
    } catch {
      return false;
    }
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
        created_at TEXT NOT NULL,
        disabled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        consumed_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_invitations_creator ON invitations(created_by, created_at DESC);
      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_tokens_tenant ON api_tokens(tenant_id, created_at DESC);
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
        bot_account_id TEXT REFERENCES bot_accounts(id) ON DELETE SET NULL,
        source_id TEXT NOT NULL,
        source_channel TEXT NOT NULL DEFAULT 'wechat',
        source_type TEXT NOT NULL DEFAULT 'wechat',
        source_external_id TEXT NOT NULL DEFAULT '',
        source_connection_id TEXT NOT NULL DEFAULT '',
        source_name TEXT NOT NULL DEFAULT '微信 iLink',
        source_url TEXT NOT NULL DEFAULT '',
        capture_type TEXT NOT NULL DEFAULT 'text',
        sender_id TEXT NOT NULL,
        session_id TEXT,
        received_at TEXT NOT NULL,
        sent_at TEXT,
        text TEXT NOT NULL,
        agent_status TEXT NOT NULL DEFAULT 'pending',
        agent_error TEXT,
        agent_attempts INTEGER NOT NULL DEFAULT 0,
        agent_started_at TEXT,
        agent_completed_at TEXT,
        note_revision INTEGER NOT NULL DEFAULT 1,
        note_title TEXT NOT NULL,
        note_markdown TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'inbox',
        tags_json TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '',
        key_points_json TEXT NOT NULL DEFAULT '[]',
        knowledge_points_json TEXT NOT NULL DEFAULT '[]',
        domains_json TEXT NOT NULL DEFAULT '[]',
        tools_json TEXT NOT NULL DEFAULT '[]',
        details_markdown TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        suggested_action TEXT NOT NULL DEFAULT 'none',
        sensitivity TEXT NOT NULL DEFAULT 'internal',
        confidence TEXT NOT NULL DEFAULT 'low',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        library_state TEXT NOT NULL DEFAULT 'inbox',
        is_favorite INTEGER NOT NULL DEFAULT 0,
        read_at TEXT,
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
      CREATE TABLE IF NOT EXISTS knowledge_diagrams (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        note_revision INTEGER NOT NULL,
        diagram_type TEXT NOT NULL,
        diagram_label TEXT NOT NULL,
        selection_reason TEXT NOT NULL,
        nodes_json TEXT NOT NULL,
        edges_json TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_diagrams_tenant ON knowledge_diagrams(tenant_id, generated_at DESC);
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
    try {
      this.database.exec("ALTER TABLE users ADD COLUMN disabled_at TEXT");
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
    }
    for (const statement of [
      "ALTER TABLE messages ADD COLUMN summary TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE messages ADD COLUMN key_points_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE messages ADD COLUMN knowledge_points_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE messages ADD COLUMN domains_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE messages ADD COLUMN tools_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE messages ADD COLUMN details_markdown TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE messages ADD COLUMN reason TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE messages ADD COLUMN suggested_action TEXT NOT NULL DEFAULT 'none'",
      "ALTER TABLE messages ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'internal'",
      "ALTER TABLE messages ADD COLUMN confidence TEXT NOT NULL DEFAULT 'low'",
      "ALTER TABLE messages ADD COLUMN warnings_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE messages ADD COLUMN source_channel TEXT NOT NULL DEFAULT 'wechat'",
      "ALTER TABLE messages ADD COLUMN source_type TEXT NOT NULL DEFAULT 'wechat'",
      "ALTER TABLE messages ADD COLUMN source_external_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE messages ADD COLUMN source_connection_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE messages ADD COLUMN source_name TEXT NOT NULL DEFAULT '微信 iLink'",
      "ALTER TABLE messages ADD COLUMN source_url TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE messages ADD COLUMN capture_type TEXT NOT NULL DEFAULT 'text'",
      "ALTER TABLE messages ADD COLUMN agent_attempts INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE messages ADD COLUMN agent_started_at TEXT",
      "ALTER TABLE messages ADD COLUMN agent_completed_at TEXT",
      "ALTER TABLE messages ADD COLUMN library_state TEXT NOT NULL DEFAULT 'inbox'",
      "ALTER TABLE messages ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE messages ADD COLUMN read_at TEXT",
    ]) {
      try {
        this.database.exec(statement);
      } catch (error) {
        if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
      }
    }
    this.migrateCaptureColumns();
    this.database.exec(`
      UPDATE messages SET
        source_external_id=CASE WHEN source_external_id='' THEN source_id ELSE source_external_id END,
        source_connection_id=CASE WHEN source_connection_id='' THEN COALESCE(bot_account_id,'owner') ELSE source_connection_id END;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_identity
        ON messages(tenant_id,source_channel,source_connection_id,source_external_id);
    `);
    for (const row of this.all("SELECT id,text,source_type,source_url,capture_type FROM messages")) {
      const text = rowString(row, "text");
      const sourceUrl = rowString(row, "source_url") || firstHttpUrl(text) || "";
      const sourceType = rowString(row, "source_type") === "wechat" && sourceUrl
        ? (new URL(sourceUrl).hostname.toLowerCase() === "mp.weixin.qq.com" ? "wechat_article" : "web")
        : rowString(row, "source_type");
      const storedCaptureType = rowString(row, "capture_type");
      const captureType = storedCaptureType === "text" && sourceUrl
        ? "link"
        : storedCaptureType || inferCaptureType(text, []);
      this.run(
        "UPDATE messages SET source_type=?,source_url=?,source_name=?,capture_type=? WHERE id=?",
        sourceType,
        sourceUrl,
        sourceType === "wechat_article" ? "微信公众号" : sourceUrl ? new URL(sourceUrl).hostname : "微信 iLink",
        captureType,
        rowString(row, "id"),
      );
    }
    const existingSearch = this.maybeOne(
      "SELECT sql FROM sqlite_master WHERE name='message_search' AND type='table'",
    );
    if (existingSearch && /CREATE VIRTUAL TABLE/i.test(rowString(existingSearch, "sql"))) {
      this.database.exec("DROP TABLE message_search");
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS message_search (
        message_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        body TEXT NOT NULL,
        tags TEXT NOT NULL,
        domains TEXT NOT NULL,
        knowledge_points TEXT NOT NULL,
        tools TEXT NOT NULL,
        all_text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_message_search_tenant ON message_search(tenant_id);
    `);
    this.rebuildSearchIndexIfNeeded();
    // Older releases stored a model-provider key and model choice here. The official
    // Nanobot Runtime owns both now, so purge those legacy values during migration.
    this.database.exec("UPDATE tenant_settings SET nanobot_api_key_enc=NULL,nanobot_model=''");
  }

  private migrateCaptureColumns(): void {
    const botColumn = this.all("PRAGMA table_info(messages)")
      .find((column) => rowString(column, "name") === "bot_account_id");
    if (!botColumn || rowNumber(botColumn, "notnull") === 0) return;
    this.database.exec("PRAGMA foreign_keys=OFF");
    try {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE messages_capture_migration (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          bot_account_id TEXT REFERENCES bot_accounts(id) ON DELETE SET NULL,
          source_id TEXT NOT NULL,
          source_channel TEXT NOT NULL DEFAULT 'wechat',
          source_type TEXT NOT NULL DEFAULT 'wechat',
          source_external_id TEXT NOT NULL DEFAULT '',
          source_connection_id TEXT NOT NULL DEFAULT '',
          source_name TEXT NOT NULL DEFAULT '微信 iLink',
          source_url TEXT NOT NULL DEFAULT '',
          capture_type TEXT NOT NULL DEFAULT 'text',
          sender_id TEXT NOT NULL,
          session_id TEXT,
          received_at TEXT NOT NULL,
          sent_at TEXT,
          text TEXT NOT NULL,
          agent_status TEXT NOT NULL DEFAULT 'pending',
          agent_error TEXT,
          agent_attempts INTEGER NOT NULL DEFAULT 0,
          agent_started_at TEXT,
          agent_completed_at TEXT,
          note_revision INTEGER NOT NULL DEFAULT 1,
          note_title TEXT NOT NULL,
          note_markdown TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'inbox',
          tags_json TEXT NOT NULL DEFAULT '[]',
          summary TEXT NOT NULL DEFAULT '',
          key_points_json TEXT NOT NULL DEFAULT '[]',
          knowledge_points_json TEXT NOT NULL DEFAULT '[]',
          domains_json TEXT NOT NULL DEFAULT '[]',
          tools_json TEXT NOT NULL DEFAULT '[]',
          details_markdown TEXT NOT NULL DEFAULT '',
          reason TEXT NOT NULL DEFAULT '',
          suggested_action TEXT NOT NULL DEFAULT 'none',
          sensitivity TEXT NOT NULL DEFAULT 'internal',
          confidence TEXT NOT NULL DEFAULT 'low',
          warnings_json TEXT NOT NULL DEFAULT '[]',
          library_state TEXT NOT NULL DEFAULT 'inbox',
          is_favorite INTEGER NOT NULL DEFAULT 0,
          read_at TEXT,
          published_revision INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO messages_capture_migration(
          seq,id,tenant_id,bot_account_id,source_id,source_external_id,source_connection_id,
          sender_id,session_id,received_at,sent_at,text,agent_status,agent_error,agent_attempts,agent_started_at,agent_completed_at,note_revision,
          note_title,note_markdown,category,tags_json,summary,key_points_json,knowledge_points_json,domains_json,
          tools_json,details_markdown,reason,suggested_action,sensitivity,confidence,warnings_json,library_state,is_favorite,read_at,
          published_revision,created_at,updated_at
        ) SELECT
          seq,id,tenant_id,bot_account_id,source_id,source_id,bot_account_id,
          sender_id,session_id,received_at,sent_at,text,agent_status,agent_error,0,NULL,NULL,note_revision,
          note_title,note_markdown,category,tags_json,summary,key_points_json,knowledge_points_json,domains_json,
          tools_json,details_markdown,reason,suggested_action,sensitivity,confidence,warnings_json,'inbox',0,NULL,
          published_revision,created_at,updated_at
        FROM messages;
        DROP TABLE messages;
        ALTER TABLE messages_capture_migration RENAME TO messages;
        CREATE INDEX idx_messages_tenant_seq ON messages(tenant_id, seq DESC);
        CREATE UNIQUE INDEX idx_messages_source_identity
          ON messages(tenant_id,source_channel,source_connection_id,source_external_id);
        COMMIT;
      `);
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Ignore rollback when SQLite already aborted the migration.
      }
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys=ON");
    }
  }

  hasOwner(): boolean {
    return rowNumber(this.one("SELECT COUNT(*) AS count FROM users"), "count") > 0;
  }

  createOwner(input: {
    displayName: string;
    password: string;
    username?: string;
  }): OwnerProfile {
    if (this.hasOwner()) throw new Error("系统已经完成初始化");
    return this.createUser({
      username: input.username || "owner",
      displayName: input.displayName,
      password: input.password,
      role: "admin",
    });
  }

  createUser(input: {
    username: string;
    displayName: string;
    password: string;
    role?: "admin" | "member";
  }): OwnerProfile {
    const username = input.username.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
      throw new Error("用户名需为 3–32 位字母、数字、点、下划线或短横线");
    }
    if (input.password.length < 8) throw new Error("密码至少需要 8 个字符");
    const displayName = input.displayName.trim().slice(0, 60) || "我的知流";
    const id = crypto.randomUUID();
    const createdAt = now();
    this.run(
      "INSERT INTO users(id,username,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
      id,
      username,
      displayName,
      hashPassword(input.password),
      input.role || "member",
      createdAt,
    );
    return { id, username, displayName, role: input.role || "member", createdAt, disabled: false };
  }

  authenticateOwner(password: string): OwnerProfile | undefined {
    const row = this.ownerRow();
    if (!row || !verifyPassword(password, rowString(row, "password_hash"))) return undefined;
    return mapOwner(row);
  }

  authenticate(username: string, password: string): OwnerProfile | undefined {
    const normalized = username.trim().toLowerCase();
    const row = normalized
      ? this.maybeOne("SELECT * FROM users WHERE username=? COLLATE NOCASE AND disabled_at IS NULL", normalized)
      : this.ownerRow();
    if (!row || !verifyPassword(password, rowString(row, "password_hash"))) return undefined;
    return mapOwner(row);
  }

  listUsers(): Array<OwnerProfile & { botCount: number; messageCount: number }> {
    this.requireAdmin();
    return this.all(
      `SELECT u.*,COUNT(DISTINCT b.id) AS bot_count,COUNT(DISTINCT m.id) AS message_count
       FROM users u
       LEFT JOIN bot_accounts b ON b.tenant_id=u.id AND b.revoked_at IS NULL
       LEFT JOIN messages m ON m.tenant_id=u.id
       GROUP BY u.id ORDER BY CASE WHEN u.role='admin' THEN 0 ELSE 1 END,u.created_at`,
    ).map((row) => ({
      ...mapOwner(row),
      botCount: rowNumber(row, "bot_count"),
      messageCount: rowNumber(row, "message_count"),
    }));
  }

  setUserDisabled(userId: string, disabled: boolean): OwnerProfile {
    const adminId = this.requireAdmin();
    if (userId === adminId) throw new Error("不能停用当前管理员账户");
    const user = this.maybeOne("SELECT * FROM users WHERE id=?", userId);
    if (!user) throw new Error("用户不存在");
    if (rowString(user, "role") === "admin") throw new Error("不能停用管理员账户");
    this.transaction(() => {
      this.run("UPDATE users SET disabled_at=? WHERE id=?", disabled ? now() : null, userId);
      if (disabled) {
        this.run("DELETE FROM sessions WHERE user_id=?", userId);
        this.run("UPDATE bot_accounts SET state='stopped' WHERE tenant_id=? AND revoked_at IS NULL", userId);
      }
    });
    return mapOwner(this.one("SELECT * FROM users WHERE id=?", userId));
  }

  deleteUser(userId: string, confirmation: string): { username: string; attachmentCount: number } {
    const adminId = this.requireAdmin();
    if (userId === adminId) throw new Error("不能删除当前管理员账户");
    const user = this.maybeOne("SELECT id,username,role FROM users WHERE id=?", userId);
    if (!user) throw new Error("用户不存在");
    if (rowString(user, "role") === "admin") throw new Error("不能删除管理员账户");
    const username = rowString(user, "username");
    if (confirmation.trim().toLocaleLowerCase("zh-CN") !== username.toLocaleLowerCase("zh-CN")) {
      throw new Error("确认用户名不匹配");
    }
    const paths = this.all(
      `SELECT DISTINCT a.storage_path FROM attachments a
       JOIN messages m ON m.id=a.message_id WHERE m.tenant_id=?`,
      userId,
    ).map((row) => rowString(row, "storage_path")).filter(Boolean);
    this.transaction(() => {
      this.run("DELETE FROM sessions WHERE user_id=?", userId);
      this.run("DELETE FROM users WHERE id=?", userId);
    });
    for (const filePath of paths) {
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch {
        // The database deletion is authoritative; a missing/unreadable stale file must not restore the account.
      }
    }
    const tenantKey = crypto.createHash("sha256").update(userId).digest("hex").slice(0, 16);
    const tenantWorkspace = path.join(this.nanobotWorkspace, "tenants", tenantKey);
    try {
      if (existsSync(tenantWorkspace)) rmSync(tenantWorkspace, { recursive: true, force: true });
    } catch {
      // Workspace cleanup is best effort after the tenant has been removed from SQLite.
    }
    return { username, attachmentCount: paths.length };
  }

  createInvitation(hours = 72): { id: string; token: string; expiresAt: string } {
    const adminId = this.requireAdmin();
    const id = crypto.randomUUID();
    const token = randomToken("invite");
    const expiresAt = new Date(Date.now() + Math.min(Math.max(hours, 1), 24 * 30) * 3_600_000).toISOString();
    this.run(
      "INSERT INTO invitations(id,token_hash,created_by,expires_at,created_at) VALUES(?,?,?,?,?)",
      id,
      tokenHash(token),
      adminId,
      expiresAt,
      now(),
    );
    return { id, token, expiresAt };
  }

  listInvitations(): Array<{
    id: string;
    expiresAt: string;
    createdAt: string;
    consumed: boolean;
    revoked: boolean;
  }> {
    const adminId = this.requireAdmin();
    return this.all(
      "SELECT * FROM invitations WHERE created_by=? ORDER BY created_at DESC LIMIT 100",
      adminId,
    ).map((row) => ({
      id: rowString(row, "id"),
      expiresAt: rowString(row, "expires_at"),
      createdAt: rowString(row, "created_at"),
      consumed: Boolean(rowOptional(row, "consumed_at")),
      revoked: Boolean(rowOptional(row, "revoked_at")),
    }));
  }

  revokeInvitation(id: string): boolean {
    const adminId = this.requireAdmin();
    return Number(this.run(
      "UPDATE invitations SET revoked_at=? WHERE id=? AND created_by=? AND consumed_at IS NULL AND revoked_at IS NULL",
      now(),
      id,
      adminId,
    ).changes) === 1;
  }

  registerWithInvitation(input: {
    token: string;
    username: string;
    displayName: string;
    password: string;
  }): OwnerProfile {
    return this.transaction(() => {
      const invitation = this.maybeOne(
        `SELECT * FROM invitations WHERE token_hash=? AND expires_at>? AND consumed_at IS NULL AND revoked_at IS NULL`,
        tokenHash(input.token),
        now(),
      );
      if (!invitation) throw new Error("邀请链接无效或已过期");
      const user = this.createUser({ ...input, role: "member" });
      this.run(
        "UPDATE invitations SET consumed_by=?,consumed_at=? WHERE id=? AND consumed_at IS NULL",
        user.id,
        now(),
        rowString(invitation, "id"),
      );
      return user;
    });
  }

  createApiToken(name: string): { token: string; apiToken: ApiToken } {
    const tenantId = this.requireOwnerId();
    const id = crypto.randomUUID();
    const token = randomToken("capture");
    const createdAt = now();
    const normalizedName = name.trim().replace(/\s+/g, " ").slice(0, 80) || "API 收件";
    this.run(
      "INSERT INTO api_tokens(id,tenant_id,name,token_hash,created_at) VALUES(?,?,?,?,?)",
      id,
      tenantId,
      normalizedName,
      tokenHash(token),
      createdAt,
    );
    return {
      token,
      apiToken: { id, name: normalizedName, createdAt, revoked: false },
    };
  }

  listApiTokens(): ApiToken[] {
    return this.all(
      "SELECT * FROM api_tokens WHERE tenant_id=? ORDER BY created_at DESC",
      this.requireOwnerId(),
    ).map((row) => ({
      id: rowString(row, "id"),
      name: rowString(row, "name"),
      createdAt: rowString(row, "created_at"),
      lastUsedAt: rowOptional(row, "last_used_at"),
      revoked: Boolean(rowOptional(row, "revoked_at")),
    }));
  }

  revokeApiToken(id: string): boolean {
    return Number(this.run(
      "UPDATE api_tokens SET revoked_at=? WHERE id=? AND tenant_id=? AND revoked_at IS NULL",
      now(),
      id,
      this.requireOwnerId(),
    ).changes) === 1;
  }

  tenantForApiToken(token: string): string | undefined {
    const row = this.maybeOne(
      `SELECT a.id,a.tenant_id FROM api_tokens a JOIN users u ON u.id=a.tenant_id
       WHERE a.token_hash=? AND a.revoked_at IS NULL AND u.disabled_at IS NULL`,
      tokenHash(token),
    );
    if (!row) return undefined;
    this.run("UPDATE api_tokens SET last_used_at=? WHERE id=?", now(), rowString(row, "id"));
    return rowString(row, "tenant_id");
  }

  updateOwnerDisplayName(displayName: string): OwnerProfile {
    const normalized = displayName.trim().replace(/\s+/g, " ").slice(0, 60);
    if (!normalized) throw new Error("账户名称不能为空");
    const userId = this.requireOwnerId();
    this.run("UPDATE users SET display_name=? WHERE id=?", normalized, userId);
    const row = this.ownerRow();
    if (!row) throw new Error("个人账户不存在");
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
    return this.createSessionFor(this.requireOwnerId(), days);
  }

  createSessionFor(userId: string, days: number): { token: string; expiresAt: string } {
    if (!this.maybeOne("SELECT id FROM users WHERE id=? AND disabled_at IS NULL", userId)) {
      throw new Error("用户不存在或已停用");
    }
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
       WHERE s.token_hash=? AND s.expires_at>? AND u.disabled_at IS NULL`,
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
    if (this.tenantId) return this.tenantId;
    const row = this.ownerRow();
    return row ? rowString(row, "id") : undefined;
  }

  private requireOwnerId(): string {
    const id = this.ownerId();
    if (!id) throw new Error("请先完成系统初始化");
    return id;
  }

  private requireAdmin(): string {
    const userId = this.requireOwnerId();
    const row = this.maybeOne("SELECT role FROM users WHERE id=?", userId);
    if (!row || rowString(row, "role") !== "admin") throw new Error("仅系统管理员可执行此操作");
    return userId;
  }

  private ownerRow(): SqlRow | undefined {
    if (this.tenantId) return this.maybeOne("SELECT * FROM users WHERE id=?", this.tenantId);
    return this.maybeOne(
      `SELECT u.* FROM users u
       LEFT JOIN bot_accounts b ON b.tenant_id=u.id AND b.revoked_at IS NULL
       LEFT JOIN messages m ON m.tenant_id=u.id
       LEFT JOIN sync_targets t ON t.tenant_id=u.id AND t.revoked_at IS NULL
       WHERE u.disabled_at IS NULL
       GROUP BY u.id
       ORDER BY (COUNT(DISTINCT b.id)+COUNT(DISTINCT m.id)+COUNT(DISTINCT t.id)) DESC,
                CASE WHEN u.role='admin' THEN 0 ELSE 1 END,
                u.created_at
       LIMIT 1`,
    );
  }

  addBotAccount(account: IlinkAccount): StoredBotAccount {
    const ownerId = this.requireOwnerId();
    const existing = this.maybeOne("SELECT id,tenant_id FROM bot_accounts WHERE bot_id=?", account.botId);
    if (existing && rowString(existing, "tenant_id") !== ownerId) {
      throw new Error("该微信机器人已绑定到其他账户");
    }
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
    const row = this.tenantId
      ? this.maybeOne("SELECT * FROM bot_accounts WHERE id=? AND tenant_id=?", id, this.tenantId)
      : this.maybeOne("SELECT * FROM bot_accounts WHERE id=?", id);
    return row ? this.mapBot(row) : undefined;
  }

  getBotAccounts(): StoredBotAccount[] {
    const rows = this.all(
      "SELECT * FROM bot_accounts WHERE tenant_id=? AND revoked_at IS NULL ORDER BY connected_at",
      this.requireOwnerId(),
    );
    return rows.map((row) => this.mapBot(row));
  }

  /** Internal startup view. HTTP handlers must use a tenant-scoped database. */
  getAllBotAccounts(includeDisabled = false): StoredBotAccount[] {
    if (this.tenantId) return this.getBotAccounts();
    return this.all(
      `SELECT b.* FROM bot_accounts b JOIN users u ON u.id=b.tenant_id
       WHERE b.revoked_at IS NULL${includeDisabled ? "" : " AND u.disabled_at IS NULL"} ORDER BY b.connected_at`,
    ).map((row) => this.mapBot(row));
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
    const source = wechatCaptureSource(sourceId, botAccountId, message.text);
    return this.saveCapture({
      id: message.id,
      source,
      captureType: inferCaptureType(message.text, message.attachments),
      actorId: message.senderId,
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      receivedAt: message.receivedAt,
      ...(message.sentAt ? { sentAt: message.sentAt } : {}),
      text: message.text,
      attachments: message.attachments,
    }, note);
  }

  saveCapture(capture: CaptureInput, note: ProcessedNote): boolean {
    if (this.hasMessage(capture.id)) return false;
    const createdAt = now();
    this.transaction(() => {
      this.run(
        `INSERT INTO messages(
          id,tenant_id,bot_account_id,source_id,source_channel,source_type,source_external_id,
          source_connection_id,source_name,source_url,capture_type,sender_id,session_id,received_at,sent_at,text,
          note_title,note_markdown,category,tags_json,summary,key_points_json,knowledge_points_json,domains_json,tools_json,
          details_markdown,reason,suggested_action,sensitivity,confidence,warnings_json,
          created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        capture.id,
        this.requireOwnerId(),
        capture.source.channel === "wechat" ? capture.source.connectionId || null : null,
        capture.source.externalId || capture.id,
        capture.source.channel,
        capture.source.type,
        capture.source.externalId || capture.id,
        capture.source.connectionId || "owner",
        capture.source.name,
        capture.source.url || "",
        capture.captureType,
        capture.actorId,
        capture.sessionId || null,
        capture.receivedAt,
        capture.sentAt || null,
        capture.text,
        note.title,
        note.markdown,
        note.category,
        JSON.stringify(note.tags),
        note.summary || "",
        JSON.stringify(note.keyPoints || []),
        JSON.stringify(note.knowledgePoints || []),
        JSON.stringify(note.domains || []),
        JSON.stringify(note.tools || []),
        note.detailsMarkdown || "",
        note.reason || "",
        note.suggestedAction || "none",
        note.sensitivity || "internal",
        note.confidence || "low",
        JSON.stringify(note.warnings || []),
        createdAt,
        createdAt,
      );
      for (const attachment of capture.attachments) {
        const sha256 = crypto
          .createHash("sha256")
          .update(requireFileBuffer(attachment.path))
          .digest("hex");
        this.run(
          `INSERT INTO attachments(id,message_id,kind,file_name,storage_path,size,mime_type,transcript,sha256)
           VALUES(?,?,?,?,?,?,?,?,?)`,
          crypto.randomUUID(),
          capture.id,
          attachment.kind,
          attachment.fileName,
          attachment.path,
          attachment.size,
          attachment.mimeType,
          attachment.transcript || null,
          sha256,
        );
      }
      this.upsertSearchIndex(capture.id);
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
      // A reprocess produces one coherent derived bundle. Keeping obsolete
      // Markdown or images would make the reader and Obsidian show two
      // different article versions, so replace only generated attachments.
      this.run(
        `DELETE FROM attachments WHERE message_id=? AND kind='derived'
         AND EXISTS(SELECT 1 FROM messages WHERE id=? AND tenant_id=?)`,
        messageId,
        messageId,
        this.requireOwnerId(),
      );
      for (const attachment of attachments) this.addAttachment(messageId, attachment);
    });
  }

  markAgentAttempt(messageId: string): number {
    const ownerId = this.requireOwnerId();
    const startedAt = now();
    const result = this.run(
      `UPDATE messages SET agent_status='processing',agent_error=NULL,
       agent_attempts=agent_attempts+1,agent_started_at=?,agent_completed_at=NULL,updated_at=?
       WHERE id=? AND tenant_id=?`,
      startedAt,
      startedAt,
      messageId,
      ownerId,
    );
    if (Number(result.changes) !== 1) throw new Error("消息不存在");
    const row = this.one("SELECT agent_attempts FROM messages WHERE id=? AND tenant_id=?", messageId, ownerId);
    return rowNumber(row, "agent_attempts");
  }

  queueMessageForReprocessing(messageId: string): boolean {
    return Number(this.run(
      `UPDATE messages SET agent_status='pending',agent_error=NULL,agent_completed_at=NULL,updated_at=?
       WHERE id=? AND tenant_id=? AND agent_status<>'processing'`,
      now(),
      messageId,
      this.requireOwnerId(),
    ).changes) === 1;
  }

  updateProcessedNote(
    messageId: string,
    note: ProcessedNote,
    status: "completed" | "fallback" | "failed",
    error?: string,
  ): void {
    const normalizedReason = note.reason ?? noteReason(note.markdown);
    const normalizedAction = note.suggestedAction ?? noteAction(note.markdown, note.category);
    const normalizedSensitivity = note.sensitivity ?? noteSensitivity(note.markdown);
    const normalizedConfidence = note.confidence ?? noteConfidence(note.markdown);
    const normalizedWarnings = note.warnings ?? noteWarnings(note.markdown, processingStatus(status));
    const row = this.maybeOne(
      `SELECT note_title,note_markdown,category,tags_json,summary,key_points_json,knowledge_points_json,domains_json,
       tools_json,details_markdown,reason,suggested_action,sensitivity,confidence,warnings_json,
       note_revision,agent_status FROM messages WHERE id=? AND tenant_id=?`,
      messageId,
      this.requireOwnerId(),
    );
    if (!row) throw new Error("消息不存在");
    const changed =
      rowString(row, "note_title") !== note.title ||
      rowString(row, "note_markdown") !== note.markdown ||
      rowString(row, "category") !== note.category ||
      rowString(row, "tags_json") !== JSON.stringify(note.tags) ||
      rowString(row, "summary") !== (note.summary || "") ||
      rowString(row, "key_points_json") !== JSON.stringify(note.keyPoints || []) ||
      rowString(row, "knowledge_points_json") !== JSON.stringify(note.knowledgePoints || []) ||
      rowString(row, "domains_json") !== JSON.stringify(note.domains || []) ||
      rowString(row, "tools_json") !== JSON.stringify(note.tools || []) ||
      rowString(row, "details_markdown") !== (note.detailsMarkdown || "") ||
      rowString(row, "reason") !== normalizedReason ||
      rowString(row, "suggested_action") !== normalizedAction ||
      rowString(row, "sensitivity") !== normalizedSensitivity ||
      rowString(row, "confidence") !== normalizedConfidence ||
      rowString(row, "warnings_json") !== JSON.stringify(normalizedWarnings) ||
      rowString(row, "agent_status") !== status;
    this.run(
      `UPDATE messages SET note_title=?,note_markdown=?,category=?,tags_json=?,summary=?,key_points_json=?,knowledge_points_json=?,
       domains_json=?,tools_json=?,details_markdown=?,reason=?,suggested_action=?,sensitivity=?,confidence=?,warnings_json=?,
       note_revision=?,agent_status=?,agent_error=?,agent_completed_at=?,updated_at=? WHERE id=? AND tenant_id=?`,
      note.title,
      note.markdown,
      note.category,
      JSON.stringify(note.tags),
      note.summary || "",
      JSON.stringify(note.keyPoints || []),
      JSON.stringify(note.knowledgePoints || []),
      JSON.stringify(note.domains || []),
      JSON.stringify(note.tools || []),
      note.detailsMarkdown || "",
      normalizedReason,
      normalizedAction,
      normalizedSensitivity,
      normalizedConfidence,
      JSON.stringify(normalizedWarnings),
      rowNumber(row, "note_revision") + (changed ? 1 : 0),
      status,
      error || null,
      now(),
      now(),
      messageId,
      this.requireOwnerId(),
    );
    if (changed) {
      this.run(
        "DELETE FROM knowledge_diagrams WHERE message_id=? AND tenant_id=?",
        messageId,
        this.requireOwnerId(),
      );
    }
    this.upsertSearchIndex(messageId);
  }

  publishMessage(messageId: string): number {
    const row = this.one("SELECT * FROM messages WHERE id=?", messageId);
    const revision = rowNumber(row, "note_revision");
    if (rowNumber(row, "published_revision") >= revision) return 0;
    const attachments = this.attachmentsForMessage(messageId);
    const markdown = rowString(row, "note_markdown");
    const title = rowString(row, "note_title");
    const category = rowString(row, "category");
    const tags = safeJson<string[]>(rowString(row, "tags_json"), []).slice(0, 10);
    const keyPoints = safeJson<string[]>(rowString(row, "key_points_json"), []).slice(0, 8);
    const sourceUrl = rowString(row, "source_url") || firstWebUrl(rowString(row, "text"));
    const sourceType = (rowString(row, "source_type") || (sourceUrl ? "web" : "manual")) as CaptureSourceType;
    const agentStatus = rowString(row, "agent_status");
    const processing = processingStatus(agentStatus);
    const storedAction = rowString(row, "suggested_action") as SyncItem["suggestedAction"];
    const suggestedAction = ["none", "knowledge", "research", "project", "resource", "practice", "delete"].includes(storedAction)
      ? storedAction
      : noteAction(markdown, category);
    const storedSensitivity = rowString(row, "sensitivity") as SyncItem["sensitivity"];
    const sensitivity = ["public", "internal", "confidential", "restricted"].includes(storedSensitivity)
      ? storedSensitivity
      : noteSensitivity(markdown);
    const storedConfidence = rowString(row, "confidence") as SyncItem["processing"]["confidence"];
    const confidence = ["high", "medium", "low"].includes(storedConfidence)
      ? storedConfidence
      : noteConfidence(markdown);
    const warnings = safeJson<string[]>(rowString(row, "warnings_json"), []).slice(0, 10);
    const updatedAt = rowString(row, "updated_at") || rowString(row, "created_at");
    const attachmentSnapshots = attachments.map((item) => ({
      id: rowString(item, "id"),
      fileName: rowString(item, "file_name"),
      mimeType: rowString(item, "mime_type"),
      size: rowNumber(item, "size"),
      sha256: rowString(item, "sha256"),
    }));
    const versionMaterial = JSON.stringify({
      title,
      markdown,
      category,
      tags,
      keyPoints,
      detailsMarkdown: rowString(row, "details_markdown"),
      reason: rowString(row, "reason"),
      suggestedAction,
      sensitivity,
      confidence,
      warnings,
      processing,
      source: {
        type: sourceType,
        name: rowString(row, "source_name"),
        url: sourceUrl,
      },
      captureType: rowString(row, "capture_type"),
      originalText: rowString(row, "text"),
      attachments: attachmentSnapshots.map((item) => ({ id: item.id, sha256: item.sha256 })),
      schemaVersion: "1.2",
      pipelineVersion: "knowledge-relay-inbox-v2",
    });
    const version = crypto.createHash("sha256").update(versionMaterial).digest("hex");
    const snapshot = {
      id: messageId,
      messageId,
      revision,
      version,
      title,
      fileName: noteFileName(title, messageId),
      markdown,
      contentMarkdown: stripNoteEnvelope(markdown),
      receivedAt: rowString(row, "received_at"),
      createdAt: rowString(row, "received_at"),
      updatedAt,
      summary: noteSummary(markdown, title),
      keyPoints,
      detailsMarkdown: rowString(row, "details_markdown"),
      reason: processing === "enriched" ? rowString(row, "reason") || noteReason(markdown) : "",
      suggestedAction: processing === "enriched" ? suggestedAction : syncAction(category),
      source: {
        type: sourceType,
        name: rowString(row, "source_name") || (sourceUrl ? new URL(sourceUrl).hostname : "微信 iLink"),
        url: sourceUrl,
      },
      captureType: (rowString(row, "capture_type") || inferCaptureType(rowString(row, "text"), [])) as CaptureType,
      originalText: rowString(row, "text"),
      tags,
      sensitivity: processing === "enriched" ? sensitivity : "internal",
      deleted: false,
      processing: {
        processor: processing === "enriched" ? "nanobot" : "deterministic",
        status: processing,
        pipelineVersion: "knowledge-relay-inbox-v2",
        processedAt: updatedAt,
        confidence: processing === "enriched" ? confidence : "low",
        warnings: processing === "enriched" && warnings.length ? warnings : noteWarnings(markdown, processing),
      },
      attachments: attachmentSnapshots,
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

  listPendingAgentMessages(limit = 100): PendingAgentMessage[] {
    return this.listPendingCaptures(limit);
  }

  /** Internal recovery view used during startup. Tenant HTTP handlers do not call this. */
  tenantIdsWithPendingCaptures(): string[] {
    if (this.tenantId) {
      return this.listPendingCaptures(1).length ? [this.tenantId] : [];
    }
    return this.all(
      `SELECT DISTINCT m.tenant_id FROM messages m
       JOIN users u ON u.id=m.tenant_id
       LEFT JOIN bot_accounts b ON b.id=m.bot_account_id
       WHERE u.disabled_at IS NULL
         AND m.agent_status IN ('pending','processing')
         AND (m.bot_account_id IS NULL OR b.revoked_at IS NULL)
       ORDER BY m.tenant_id`,
    ).map((row) => rowString(row, "tenant_id"));
  }

  listPendingCaptures(limit = 100): PendingAgentMessage[] {
    const rows = this.all(
      `SELECT m.* FROM messages m
       LEFT JOIN bot_accounts b ON b.id=m.bot_account_id
       WHERE m.tenant_id=? AND m.agent_status IN ('pending','processing')
         AND (m.bot_account_id IS NULL OR b.revoked_at IS NULL)
       ORDER BY m.seq LIMIT ?`,
      this.requireOwnerId(),
      limit,
    );
    return rows.map((row) => this.pendingCaptureFromRow(row));
  }

  captureForProcessing(messageId: string): PendingAgentMessage | undefined {
    const row = this.maybeOne(
      `SELECT m.* FROM messages m
       LEFT JOIN bot_accounts b ON b.id=m.bot_account_id
       WHERE m.tenant_id=? AND m.id=?
         AND (m.bot_account_id IS NULL OR b.revoked_at IS NULL)`,
      this.requireOwnerId(),
      messageId,
    );
    return row ? this.pendingCaptureFromRow(row) : undefined;
  }

  private pendingCaptureFromRow(row: SqlRow): PendingAgentMessage {
    return {
      capture: {
        id: rowString(row, "id"),
        source: {
          channel: (rowString(row, "source_channel") || "wechat") as CaptureInput["source"]["channel"],
          type: (rowString(row, "source_type") || "wechat") as CaptureSourceType,
          externalId: rowString(row, "source_external_id") || rowString(row, "source_id"),
          ...(rowOptional(row, "source_connection_id")
            ? { connectionId: rowString(row, "source_connection_id") }
            : {}),
          name: rowString(row, "source_name") || "微信 iLink",
          ...(rowOptional(row, "source_url") ? { url: rowString(row, "source_url") } : {}),
        },
        captureType: (rowString(row, "capture_type") || "text") as CaptureType,
        actorId: rowString(row, "sender_id"),
        ...(rowOptional(row, "session_id") ? { sessionId: rowString(row, "session_id") } : {}),
        receivedAt: rowString(row, "received_at"),
        ...(rowOptional(row, "sent_at") ? { sentAt: rowString(row, "sent_at") } : {}),
        text: rowString(row, "text"),
        attachments: this.attachmentsForMessage(rowString(row, "id")).map((attachment) => ({
          kind: rowString(attachment, "kind") as PublicInboundMessage["attachments"][number]["kind"],
          fileName: rowString(attachment, "file_name"),
          path: rowString(attachment, "storage_path"),
          size: rowNumber(attachment, "size"),
          mimeType: rowString(attachment, "mime_type"),
          ...(rowOptional(attachment, "transcript")
            ? { transcript: rowString(attachment, "transcript") }
            : {}),
        })),
      },
    };
  }

  private messageListWhere(beforeSeq?: number, options: MessageListOptions = {}): {
    clause: string;
    values: SqlValue[];
  } {
    const ownerId = this.requireOwnerId();
    const where = ["m.tenant_id=?"];
    const values: SqlValue[] = [ownerId];
    if (beforeSeq) {
      where.push("m.seq<?");
      values.push(beforeSeq);
    }
    if (options.state) {
      where.push("m.library_state=?");
      values.push(options.state);
    }
    if (options.active) where.push("m.library_state<>'archived'");
    if (options.favorite) where.push("m.is_favorite=1");
    if (options.format) {
      where.push(`${contentFormatSql("m") }=?`);
      values.push(options.format);
    }
    if (options.category) {
      where.push("m.category=?");
      values.push(options.category);
    }
    if (options.domain) {
      where.push("EXISTS(SELECT 1 FROM json_each(m.domains_json) domain WHERE domain.value=?)");
      values.push(options.domain);
    }
    if (options.organized) where.push("m.agent_status='completed'");
    const query = options.query?.trim().slice(0, 200);
    if (query) {
      const searchableColumns = [
        "m.note_title",
        "m.summary",
        "m.text",
        "m.tags_json",
        "m.domains_json",
        "m.knowledge_points_json",
        "m.tools_json",
      ];
      where.push(`(${searchableColumns.map((column) => `INSTR(LOWER(COALESCE(${column},'')),LOWER(?))>0`).join(" OR ")})`);
      values.push(...searchableColumns.map(() => query));
    }
    return { clause: where.join(" AND "), values };
  }

  listMessages(limit = 100, beforeSeq?: number, options: MessageListOptions = {}): MessageListItem[] {
    const filter = this.messageListWhere(beforeSeq, options);
    const rows = this.all(
      `SELECT m.*,(SELECT COUNT(*) FROM attachments a WHERE a.message_id=m.id) AS attachment_count,
       (SELECT a.id FROM attachments a WHERE a.message_id=m.id AND a.mime_type LIKE 'image/%'
        ORDER BY CASE WHEN a.kind='derived' THEN 0 ELSE 1 END,a.rowid LIMIT 1) AS cover_attachment_id,
       (SELECT a.mime_type FROM attachments a WHERE a.message_id=m.id AND a.mime_type LIKE 'image/%'
        ORDER BY CASE WHEN a.kind='derived' THEN 0 ELSE 1 END,a.rowid LIMIT 1) AS cover_mime_type,
       CASE WHEN EXISTS(SELECT 1 FROM sync_targets t WHERE t.tenant_id=m.tenant_id AND t.is_primary=1 AND t.revoked_at IS NULL)
         THEN CASE WHEN COALESCE((SELECT MAX(e.seq) FROM sync_events e WHERE e.message_id=m.id),0)
           <= COALESCE((SELECT MAX(t.last_ack_seq) FROM sync_targets t WHERE t.tenant_id=m.tenant_id AND t.is_primary=1 AND t.revoked_at IS NULL),0)
           THEN 1 ELSE 0 END ELSE 0 END AS archived
       FROM messages m WHERE ${filter.clause} ORDER BY m.seq DESC LIMIT ?`,
      ...filter.values,
      limit,
    );
    return rows.map((row) => this.mapMessage(row));
  }

  countMessages(options: MessageListOptions = {}): number {
    const filter = this.messageListWhere(undefined, options);
    return rowNumber(
      this.one(`SELECT COUNT(*) AS count FROM messages m WHERE ${filter.clause}`, ...filter.values),
      "count",
    );
  }

  knowledgeFacets(organizedOnly = false, facetLimit = 10): KnowledgeFacets {
    const rows = this.all(
      `SELECT source_type,capture_type,category,agent_status,domains_json,knowledge_points_json,tools_json
       FROM messages WHERE tenant_id=?${organizedOnly ? " AND agent_status='completed'" : ""} ORDER BY seq DESC`,
      this.requireOwnerId(),
    );
    const categories = new Map<string, number>();
    const domains = new Map<string, number>();
    const knowledgePoints = new Map<string, number>();
    const tools = new Map<string, number>();
    const count = (target: Map<string, number>, raw: unknown): void => {
      const value = cleanFacetValue(raw);
      if (value) target.set(value, (target.get(value) || 0) + 1);
    };
    for (const row of rows) {
      count(categories, contentFormatFromRow(row));
      for (const value of safeJson<unknown[]>(rowString(row, "domains_json"), [])) count(domains, value);
      for (const value of safeJson<unknown[]>(rowString(row, "knowledge_points_json"), [])) {
        count(knowledgePoints, compactKnowledgePoint(value));
      }
      for (const value of safeJson<unknown[]>(rowString(row, "tools_json"), [])) count(tools, value);
    }
    const safeFacetLimit = Math.max(1, Math.min(100, Math.floor(facetLimit) || 10));
    const top = (values: Map<string, number>, limit: number): KnowledgeFacet[] => Array.from(values)
      .map(([name, facetCount]) => ({ name, count: facetCount }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "zh-CN"))
      .slice(0, limit);
    return {
      total: rows.length,
      enriched: rows.filter((row) => rowString(row, "agent_status") === "completed").length,
      facetTotals: {
        categories: categories.size,
        domains: domains.size,
        knowledgePoints: knowledgePoints.size,
        tools: tools.size,
      },
      categories: top(categories, safeFacetLimit),
      domains: top(domains, safeFacetLimit),
      knowledgePoints: top(knowledgePoints, safeFacetLimit),
      tools: top(tools, safeFacetLimit),
    };
  }

  searchInbox(query: string, options: InboxSearchOptions = {}): InboxSearchResult[] {
    const terms = querySearchTokens(query);
    const values: SqlValue[] = [];
    const where: string[] = [];
    let sql = `SELECT m.*,(SELECT COUNT(*) FROM attachments a WHERE a.message_id=m.id) AS attachment_count,
      0 AS archived FROM messages m ${terms.length ? "JOIN message_search ON message_search.message_id=m.id" : ""}`;
    where.push("m.tenant_id=?");
    values.push(this.requireOwnerId());
    for (const term of terms) {
      where.push("message_search.all_text LIKE ? ESCAPE '\\'");
      values.push(likeValue(term));
    }
    if (options.organized === true) where.push("m.agent_status='completed'");
    if (options.organized === false) where.push("m.agent_status<>'completed'");
    if (options.category) {
      where.push("m.category=?");
      values.push(options.category);
    }
    for (const [field, value] of [
      ["domains_json", options.domain],
      ["tools_json", options.tool],
    ] as const) {
      if (!value) continue;
      where.push(`EXISTS(SELECT 1 FROM json_each(m.${field}) WHERE lower(value)=lower(?))`);
      values.push(value);
    }
    if (options.knowledgePoint) {
      const knowledgePoint = compactKnowledgePoint(options.knowledgePoint);
      if (!knowledgePoint) return [];
      where.push(`EXISTS(SELECT 1 FROM json_each(m.knowledge_points_json)
        WHERE lower(compact_knowledge_point(value))=lower(?))`);
      values.push(knowledgePoint);
    }
    if (options.receivedAfter) {
      where.push("m.received_at>=?");
      values.push(options.receivedAfter);
    }
    if (options.receivedBefore) {
      where.push("m.received_at<?");
      values.push(options.receivedBefore);
    }
    if (!terms.length && where.length === 1) return [];
    const resultLimit = Math.min(Math.max(options.limit || 8, 1), 20);
    sql += ` WHERE ${where.join(" AND ")} ORDER BY m.seq DESC LIMIT ?`;
    values.push(terms.length ? 500 : resultLimit);
    return this.all(sql, ...values).map((row) => {
      const item = this.mapMessage(row);
      return {
        ...item,
        excerpt: (item.summary || item.text || (item.attachmentCount ? "（仅附件）" : item.markdown))
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 240),
        searchScore: terms.reduce((score, term) => {
          const title = indexedSearchText(item.title);
          const summary = indexedSearchText(item.summary);
          const metadata = indexedSearchText([
            ...item.tags,
            ...item.domains,
            ...item.knowledgePoints,
            ...item.tools,
          ].join(" "));
          return score + (title.includes(term) ? 12 : 0) + (summary.includes(term) ? 8 : 0) +
            (metadata.includes(term) ? 9 : 0) + (indexedSearchText(item.text).includes(term) ? 3 : 0);
        }, 0),
      };
    }).sort((left, right) => right.searchScore - left.searchScore || right.seq - left.seq)
      .slice(0, resultLimit)
      .map(({ searchScore: _searchScore, ...item }) => item);
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

  getMessageDetail(messageId: string): MessageDetail | undefined {
    const row = this.maybeOne(
      `SELECT m.*,(SELECT COUNT(*) FROM attachments a WHERE a.message_id=m.id) AS attachment_count,
       0 AS archived FROM messages m WHERE m.tenant_id=? AND m.id=?`,
      this.requireOwnerId(),
      messageId,
    );
    if (!row) return undefined;
    const message = this.mapMessage(row);
    const sourceUrl = rowString(row, "source_url") || firstWebUrl(message.text);
    const storedAction = rowString(row, "suggested_action") as MessageDetail["suggestedAction"];
    const storedSensitivity = rowString(row, "sensitivity") as MessageDetail["sensitivity"];
    const storedConfidence = rowString(row, "confidence") as MessageDetail["confidence"];
    return {
      ...message,
      contentMarkdown: stripNoteEnvelope(message.markdown),
      detailsMarkdown: rowString(row, "details_markdown"),
      reason: rowString(row, "reason") || noteReason(message.markdown),
      suggestedAction: ["none", "knowledge", "research", "project", "resource", "practice", "delete"].includes(storedAction)
        ? storedAction
        : noteAction(message.markdown, message.category),
      sensitivity: ["public", "internal", "confidential", "restricted"].includes(storedSensitivity)
        ? storedSensitivity
        : noteSensitivity(message.markdown),
      confidence: ["high", "medium", "low"].includes(storedConfidence)
        ? storedConfidence
        : noteConfidence(message.markdown),
      warnings: safeJson<string[]>(rowString(row, "warnings_json"), []).slice(0, 10),
      source: {
        type: (rowString(row, "source_type") || (sourceUrl ? "web" : "manual")) as CaptureSourceType,
        name: rowString(row, "source_name") || (sourceUrl ? "网页" : "微信 iLink"),
        url: sourceUrl,
      },
      captureType: (rowString(row, "capture_type") || inferCaptureType(message.text, [])) as CaptureType,
    };
  }

  updateResourceState(
    messageId: string,
    input: { state?: "inbox" | "library" | "archived"; favorite?: boolean; read?: boolean },
  ): MessageListItem {
    const ownerId = this.requireOwnerId();
    const existing = this.getMessage(messageId);
    if (!existing) throw new Error("消息不存在");
    const state = input.state || existing.libraryState;
    const favorite = input.favorite ?? existing.favorite;
    const readAt = input.read === undefined
      ? existing.readAt || null
      : input.read
        ? now()
        : null;
    this.run(
      "UPDATE messages SET library_state=?,is_favorite=?,read_at=?,updated_at=? WHERE id=? AND tenant_id=?",
      state,
      favorite ? 1 : 0,
      readAt,
      now(),
      messageId,
      ownerId,
    );
    return this.getMessage(messageId)!;
  }

  deleteMessage(messageId: string): { attachmentCount: number } | undefined {
    const ownerId = this.requireOwnerId();
    if (!this.maybeOne("SELECT id FROM messages WHERE id=? AND tenant_id=?", messageId, ownerId)) {
      return undefined;
    }
    const paths = this.all(
      `SELECT DISTINCT a.storage_path FROM attachments a
       JOIN messages m ON m.id=a.message_id WHERE m.id=? AND m.tenant_id=?`,
      messageId,
      ownerId,
    ).map((row) => rowString(row, "storage_path")).filter(Boolean);
    this.run("DELETE FROM messages WHERE id=? AND tenant_id=?", messageId, ownerId);
    for (const filePath of paths) {
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch {
        // The resource is already gone from SQLite; stale-file cleanup remains best effort.
      }
    }
    return { attachmentCount: paths.length };
  }

  getKnowledgeDiagram(messageId: string): StoredKnowledgeDiagram | undefined {
    const ownerId = this.requireOwnerId();
    const row = this.maybeOne(
      `SELECT d.*,d.note_revision AS diagram_revision,m.note_revision AS message_revision FROM knowledge_diagrams d
       JOIN messages m ON m.id=d.message_id
       WHERE d.message_id=? AND d.tenant_id=? AND m.tenant_id=?`,
      messageId,
      ownerId,
      ownerId,
    );
    if (!row) return undefined;
    const diagramRevision = rowNumber(row, "diagram_revision");
    if (diagramRevision !== rowNumber(row, "message_revision")) return undefined;
    const allowedTypes = new Set<KnowledgeDiagramType>([
      "mindmap", "relationship", "flow", "timeline", "comparison", "sequence", "state",
    ]);
    const diagramType = rowString(row, "diagram_type") as KnowledgeDiagramType;
    if (!allowedTypes.has(diagramType)) return undefined;
    return {
      messageId,
      noteRevision: diagramRevision,
      scope: "resource",
      diagramType,
      diagramLabel: rowString(row, "diagram_label") || "智能图解",
      selectionReason: rowString(row, "selection_reason"),
      generatedAt: rowString(row, "generated_at"),
      truncated: false,
      nodes: safeJson<KnowledgeMapNode[]>(rowString(row, "nodes_json"), []),
      edges: safeJson<KnowledgeMapEdge[]>(rowString(row, "edges_json"), []),
    };
  }

  saveKnowledgeDiagram(messageId: string, diagram: KnowledgeMap, expectedRevision?: number): StoredKnowledgeDiagram {
    const ownerId = this.requireOwnerId();
    const message = this.maybeOne(
      "SELECT note_revision FROM messages WHERE id=? AND tenant_id=?",
      messageId,
      ownerId,
    );
    if (!message) throw new Error("消息不存在");
    const revision = rowNumber(message, "note_revision");
    if (expectedRevision !== undefined && revision !== expectedRevision) {
      throw new Error("内容在图解生成期间已更新，请基于新版本重新生成");
    }
    const generatedAt = now();
    this.run(
      `INSERT INTO knowledge_diagrams(
        message_id,tenant_id,note_revision,diagram_type,diagram_label,selection_reason,nodes_json,edges_json,generated_at
       ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET
        tenant_id=excluded.tenant_id,note_revision=excluded.note_revision,diagram_type=excluded.diagram_type,
        diagram_label=excluded.diagram_label,selection_reason=excluded.selection_reason,
        nodes_json=excluded.nodes_json,edges_json=excluded.edges_json,generated_at=excluded.generated_at`,
      messageId,
      ownerId,
      revision,
      diagram.diagramType,
      diagram.diagramLabel,
      diagram.selectionReason,
      JSON.stringify(diagram.nodes),
      JSON.stringify(diagram.edges),
      generatedAt,
    );
    return this.getKnowledgeDiagram(messageId)!;
  }

  deleteKnowledgeDiagram(messageId: string): boolean {
    return Number(this.run(
      "DELETE FROM knowledge_diagrams WHERE message_id=? AND tenant_id=?",
      messageId,
      this.requireOwnerId(),
    ).changes) === 1;
  }

  knowledgeMap(messageId?: string): KnowledgeMap {
    const ownerId = this.requireOwnerId();
    const nodeMap = new Map<string, KnowledgeMapNode>();
    const edgeMap = new Map<string, KnowledgeMapEdge>();
    const nodeId = (type: KnowledgeMapNode["type"], label: string): string =>
      `${type}:${crypto.createHash("sha256").update(label).digest("hex").slice(0, 12)}`;
    const addNode = (type: KnowledgeMapNode["type"], label: string, count?: number): string => {
      const clean = label.replace(/\s+/g, " ").trim().slice(0, 120);
      const id = nodeId(type, clean);
      if (!nodeMap.has(id)) nodeMap.set(id, { id, label: clean, type, ...(count ? { count } : {}) });
      return id;
    };
    const addEdge = (
      source: string,
      target: string,
      label?: string,
      kind: KnowledgeMapEdge["kind"] = "primary",
    ): void => {
      if (source === target) return;
      edgeMap.set(`${source}>${target}`, { source, target, ...(label ? { label } : {}), kind });
    };

    if (messageId) {
      const item = this.getMessage(messageId);
      if (!item) throw new Error("消息不存在");
      const diagram = selectKnowledgeDiagram(item);
      const root = addNode("resource", item.title);
      const domains = item.domains.slice(0, 4).map((label) => ({ label, id: addNode("domain", label) }));
      const concepts = item.knowledgePoints.slice(0, 8).map((label) => ({ label, id: addNode("concept", label) }));
      const tools = item.tools.slice(0, 8).map((label) => ({ label, id: addNode("tool", label) }));
      const points = item.keyPoints.slice(0, 8).map((label) => ({ label, id: addNode("point", label) }));
      const mentions = (content: string, label: string): boolean =>
        label.trim().length >= 2 && content.toLocaleLowerCase("zh-CN").includes(label.trim().toLocaleLowerCase("zh-CN"));
      const relatedNodes = (content: string) => [...tools, ...concepts].filter((entry) => mentions(content, entry.label));

      for (const domain of domains) addEdge(root, domain.id, "领域");
      if (diagram.diagramType === "comparison") {
        for (const tool of tools) addEdge(root, tool.id, "比较对象");
        for (const concept of concepts) addEdge(root, concept.id, "评测维度");
        for (const point of points) {
          const related = relatedNodes(point.label);
          if (!related.length) addEdge(root, point.id, "结论");
          else for (const entry of related) addEdge(entry.id, point.id, "证据", "secondary");
        }
      } else if (["flow", "timeline", "state", "sequence"].includes(diagram.diagramType)) {
        let previous = root;
        for (const [index, point] of points.entries()) {
          const label = diagram.diagramType === "timeline"
            ? (index ? "随后" : "起点")
            : diagram.diagramType === "state"
              ? "转换"
              : diagram.diagramType === "sequence"
                ? "交互"
                : (index ? "下一步" : "开始");
          addEdge(previous, point.id, label);
          previous = point.id;
          for (const entry of relatedNodes(point.label)) addEdge(entry.id, point.id, "参与", "secondary");
        }
        for (const tool of tools) {
          if (!points.some((point) => mentions(point.label, tool.label))) addEdge(root, tool.id, "组件");
        }
        for (const concept of concepts) {
          if (!points.some((point) => mentions(point.label, concept.label))) addEdge(root, concept.id, "概念");
        }
      } else {
        for (const concept of concepts) addEdge(root, concept.id, "概念");
        for (const tool of tools) addEdge(root, tool.id, "工具");
        for (const point of points) {
          const related = relatedNodes(point.label);
          if (!related.length) addEdge(root, point.id, "要点");
          else for (const entry of related) addEdge(entry.id, point.id, "关联", "secondary");
        }
      }
      return {
        scope: "resource",
        ...diagram,
        generatedAt: now(),
        truncated: false,
        nodes: [...nodeMap.values()],
        edges: [...edgeMap.values()],
      };
    }

    const total = rowNumber(this.one("SELECT COUNT(*) AS count FROM messages WHERE tenant_id=?", ownerId), "count");
    const rows = this.all(
      `SELECT id,note_title,domains_json,knowledge_points_json,tools_json
       FROM messages WHERE tenant_id=? AND library_state<>'archived'
       ORDER BY seq DESC LIMIT 5000`,
      ownerId,
    );
    const root = addNode("root", "我的知识库", total);
    const frequencies = (key: "domains_json" | "knowledge_points_json" | "tools_json") => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        for (const value of safeJson<string[]>(rowString(row, key), [])) {
          const clean = key === "knowledge_points_json" ? compactKnowledgePoint(value) : value.trim().slice(0, 80);
          if (clean) counts.set(clean, (counts.get(clean) || 0) + 1);
        }
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"));
    };
    const domains = frequencies("domains_json").slice(0, 8);
    const concepts = frequencies("knowledge_points_json").slice(0, 24);
    const tools = frequencies("tools_json").slice(0, 16);
    const domainIds = new Map(domains.map(([label, count]) => {
      const id = addNode("domain", label, count);
      addEdge(root, id);
      return [label, id];
    }));
    for (const [label, count] of concepts) {
      const conceptId = addNode("concept", label, count);
      const related = rows.find((row) =>
        safeJson<string[]>(rowString(row, "knowledge_points_json"), []).map(compactKnowledgePoint).includes(label));
      const domain = related
        ? safeJson<string[]>(rowString(related, "domains_json"), []).find((value) => domainIds.has(value))
        : undefined;
      addEdge(domain ? domainIds.get(domain)! : root, conceptId);
    }
    for (const [label, count] of tools) addEdge(root, addNode("tool", label, count));
    return {
      scope: "library",
      diagramType: "relationship",
      diagramLabel: "知识关系图",
      selectionReason: "聚合展示知识库中的高频领域、概念和工具关系",
      generatedAt: now(),
      truncated: total > rows.length || concepts.length >= 24 || tools.length >= 16,
      nodes: [...nodeMap.values()],
      edges: [...edgeMap.values()],
    };
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

  dashboard(): DashboardStats {
    const ownerId = this.requireOwnerId();
    const messageStats = this.one(
      `SELECT COUNT(*) AS messages,
        COALESCE(SUM(CASE WHEN agent_status='completed' THEN 1 ELSE 0 END),0) AS organized,
        COALESCE(SUM(CASE WHEN agent_status IN ('pending','processing') THEN 1 ELSE 0 END),0) AS pending,
        COALESCE(SUM(CASE WHEN agent_status='pending' THEN 1 ELSE 0 END),0) AS queued,
        COALESCE(SUM(CASE WHEN agent_status='processing' THEN 1 ELSE 0 END),0) AS active_processing,
        COALESCE(SUM(CASE WHEN library_state='library' THEN 1 ELSE 0 END),0) AS library_items,
        COALESCE(SUM(CASE WHEN is_favorite=1 THEN 1 ELSE 0 END),0) AS favorites,
        COALESCE(SUM(CASE WHEN agent_status IN ('fallback','failed') THEN 1 ELSE 0 END),0) AS fallback
       FROM messages WHERE tenant_id=?`,
      ownerId,
    );
    const eventMax = rowNumber(
      this.one("SELECT COALESCE(MAX(seq),0) AS value FROM sync_events WHERE tenant_id=?", ownerId),
      "value",
    );
    const primaryTarget = this.maybeOne(
      `SELECT last_ack_seq FROM sync_targets
       WHERE tenant_id=? AND is_primary=1 AND revoked_at IS NULL
       ORDER BY created_at LIMIT 1`,
      ownerId,
    );
    const primaryAck = primaryTarget ? rowNumber(primaryTarget, "last_ack_seq") : 0;
    const pendingSync = primaryTarget
      ? rowNumber(
          this.one(
            "SELECT COUNT(DISTINCT message_id) AS count FROM sync_events WHERE tenant_id=? AND seq>?",
            ownerId,
            primaryAck,
          ),
          "count",
        )
      : 0;
    return {
      messages: rowNumber(messageStats, "messages"),
      organized: rowNumber(messageStats, "organized"),
      pending: rowNumber(messageStats, "pending"),
      queued: rowNumber(messageStats, "queued"),
      activeProcessing: rowNumber(messageStats, "active_processing"),
      libraryItems: rowNumber(messageStats, "library_items"),
      favorites: rowNumber(messageStats, "favorites"),
      // Keep the original aggregate field for older dashboard consumers.
      processing: rowNumber(messageStats, "pending"),
      fallback: rowNumber(messageStats, "fallback"),
      pendingSync,
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
        apiKey: defaults.apiKey,
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
      `SELECT t.* FROM sync_targets t JOIN users u ON u.id=t.tenant_id
       WHERE t.token_hash=? AND t.revoked_at IS NULL AND u.disabled_at IS NULL`,
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
       JOIN (
         SELECT message_id,MAX(revision) AS revision
         FROM sync_events
         WHERE tenant_id=? AND seq>?
           AND COALESCE(json_extract(snapshot_json,'$.processing.status'),'fallback')<>'pending'
         GROUP BY message_id
       ) latest
       ON latest.message_id=e.message_id AND latest.revision=e.revision
       WHERE e.tenant_id=? AND e.seq>?
         AND COALESCE(json_extract(e.snapshot_json,'$.processing.status'),'fallback')<>'pending'
       ORDER BY e.seq LIMIT ?`,
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
      this.one(
        `SELECT COUNT(*) AS count FROM sync_events
         WHERE tenant_id=? AND seq>?
           AND COALESCE(json_extract(snapshot_json,'$.processing.status'),'fallback')<>'pending'`,
        tenantId,
        nextCursor,
      ),
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
      "SELECT * FROM sync_batches WHERE id=? AND target_id=?",
      batchId,
      targetId,
    );
    if (!batch) throw new Error("同步批次不存在或不属于这个设备");
    const cursor = rowNumber(batch, "to_seq");
    if (rowString(batch, "status") === "acked") return { cursor };
    if (rowString(batch, "status") !== "open") throw new Error("同步批次状态无效");
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

  resetSyncTargetCursor(targetId: string): { cursor: number } {
    const target = this.maybeOne(
      "SELECT id FROM sync_targets WHERE id=? AND revoked_at IS NULL",
      targetId,
    );
    if (!target) throw new Error("同步设备不存在或已撤销");
    this.transaction(() => {
      this.run("DELETE FROM sync_batches WHERE target_id=? AND status='open'", targetId);
      this.run(
        "UPDATE sync_targets SET last_ack_seq=0,last_seen_at=? WHERE id=?",
        now(),
        targetId,
      );
    });
    return { cursor: 0 };
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
      tenantId: rowString(row, "tenant_id"),
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
      contentFormat: contentFormatFromRow(row),
      category: rowString(row, "category"),
      tags: safeJson<string[]>(rowString(row, "tags_json"), []),
      summary: rowString(row, "summary"),
      keyPoints: safeJson<string[]>(rowString(row, "key_points_json"), []),
      knowledgePoints: safeJson<string[]>(rowString(row, "knowledge_points_json"), [])
        .map(compactKnowledgePoint)
        .filter(Boolean),
      domains: safeJson<string[]>(rowString(row, "domains_json"), []),
      tools: safeJson<string[]>(rowString(row, "tools_json"), []),
      title: rowString(row, "note_title"),
      markdown: rowString(row, "note_markdown"),
      revision: rowNumber(row, "note_revision"),
      agentStatus: rowString(row, "agent_status"),
      agentError: rowOptional(row, "agent_error"),
      agentAttempts: rowNumber(row, "agent_attempts"),
      agentStartedAt: rowOptional(row, "agent_started_at"),
      agentCompletedAt: rowOptional(row, "agent_completed_at"),
      attachmentCount: rowNumber(row, "attachment_count"),
      archived: Boolean(rowNumber(row, "archived")),
      libraryState: (["inbox", "library", "archived"].includes(rowString(row, "library_state"))
        ? rowString(row, "library_state")
        : "inbox") as MessageListItem["libraryState"],
      favorite: Boolean(rowNumber(row, "is_favorite")),
      readAt: rowOptional(row, "read_at"),
      coverAttachmentId: rowOptional(row, "cover_attachment_id"),
      coverMimeType: rowOptional(row, "cover_mime_type"),
    };
  }

  private upsertSearchIndex(messageId: string): void {
    const row = this.maybeOne("SELECT * FROM messages WHERE id=?", messageId);
    if (!row) return;
    this.run(
      `INSERT INTO message_search(message_id,tenant_id,title,summary,body,tags,domains,knowledge_points,tools,all_text)
       VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET
       tenant_id=excluded.tenant_id,title=excluded.title,summary=excluded.summary,body=excluded.body,
       tags=excluded.tags,domains=excluded.domains,knowledge_points=excluded.knowledge_points,
       tools=excluded.tools,all_text=excluded.all_text`,
      messageId,
      rowString(row, "tenant_id"),
      ...[
        rowString(row, "note_title"),
        rowString(row, "summary"),
        `${rowString(row, "text")}\n${rowString(row, "note_markdown")}`,
        safeJson<string[]>(rowString(row, "tags_json"), []).join(" "),
        safeJson<string[]>(rowString(row, "domains_json"), []).join(" "),
        safeJson<string[]>(rowString(row, "knowledge_points_json"), []).join(" "),
        safeJson<string[]>(rowString(row, "tools_json"), []).join(" "),
      ].map(indexedSearchText),
      indexedSearchText([
        rowString(row, "note_title"), rowString(row, "summary"), rowString(row, "text"),
        rowString(row, "note_markdown"), rowString(row, "tags_json"), rowString(row, "domains_json"),
        rowString(row, "knowledge_points_json"), rowString(row, "tools_json"),
      ].join("\n")),
    );
  }

  private rebuildSearchIndexIfNeeded(): void {
    const version = "3";
    const current = this.maybeOne("SELECT value FROM metadata WHERE key='message_search_version'");
    if (current && rowString(current, "value") === version) return;
    this.transaction(() => {
      this.run("DELETE FROM message_search");
      for (const row of this.all("SELECT id FROM messages ORDER BY seq")) {
        this.upsertSearchIndex(rowString(row, "id"));
      }
      this.run(
        `INSERT INTO metadata(key,value) VALUES('message_search_version',?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        version,
      );
    });
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
      const raw = rowString(event, "snapshot_json");
      const snapshot = safeJson<Partial<Omit<SyncItem, "eventSeq">>>(raw, {
        messageId: rowString(event, "message_id"),
        revision: rowNumber(event, "revision"),
        title: "微信收件",
        fileName: `微信收件-${rowNumber(event, "seq")}.md`,
        markdown: "",
        receivedAt: rowString(event, "created_at"),
        attachments: [],
      });
      const messageId = snapshot.id || snapshot.messageId || rowString(event, "message_id");
      const markdown = snapshot.markdown || "";
      const createdAt = snapshot.createdAt || snapshot.receivedAt || rowString(event, "created_at");
      const status = snapshot.processing?.status || "fallback";
      const item: SyncItem = {
        eventSeq: rowNumber(event, "seq"),
        id: messageId,
        messageId,
        revision: snapshot.revision || rowNumber(event, "revision") || 1,
        version: snapshot.version || crypto.createHash("sha256").update(raw).digest("hex"),
        title: snapshot.title || "微信收件",
        fileName: snapshot.fileName || `微信收件-${rowNumber(event, "seq")}.md`,
        markdown,
        contentMarkdown: snapshot.contentMarkdown ?? stripNoteEnvelope(markdown),
        captureType: snapshot.captureType ?? inferCaptureType(snapshot.originalText ?? markdown, []),
        originalText: snapshot.originalText ?? "",
        receivedAt: snapshot.receivedAt || createdAt,
        createdAt,
        updatedAt: snapshot.updatedAt || createdAt,
        summary: snapshot.summary ?? noteSummary(markdown, snapshot.title || "微信收件"),
        keyPoints: Array.isArray(snapshot.keyPoints) ? snapshot.keyPoints.slice(0, 8) : [],
        detailsMarkdown: snapshot.detailsMarkdown || "",
        reason: snapshot.reason || "",
        suggestedAction: snapshot.suggestedAction || "none",
        source: snapshot.source || { type: "manual", name: "微信 iLink", url: "" },
        tags: Array.isArray(snapshot.tags) ? snapshot.tags.slice(0, 10) : [],
        sensitivity: snapshot.sensitivity || "internal",
        deleted: false,
        processing: snapshot.processing || {
          processor: "deterministic",
          status,
          pipelineVersion: "knowledge-relay-inbox-v1",
          processedAt: snapshot.updatedAt || createdAt,
          confidence: "low",
          warnings: ["这是由旧版同步记录迁移的内容。"],
        },
        attachments: Array.isArray(snapshot.attachments) ? snapshot.attachments : [],
      };
      return item;
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
