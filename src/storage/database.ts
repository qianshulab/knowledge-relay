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

import Database from "better-sqlite3";

import {
  canonicalCaptureUrl,
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

export type WechatMcpSource = {
  id: string;
  enabled: boolean;
  endpoint: string;
  authorizationConfigured: boolean;
  displayName: string;
  account: string;
  pollIntervalSeconds: number;
  qrConfigured: boolean;
  qrMimeType?: string;
  lastPollAt?: string;
  lastMessageAt?: string;
  lastError?: string;
  updatedAt: string;
};

export type WechatMcpSourceSecret = WechatMcpSource & {
  authorization: string;
  qrPath?: string;
};

export type WechatMcpBinding = {
  id: string;
  tenantId: string;
  username?: string;
  userDisplayName?: string;
  account: string;
  wechatUsername: string;
  wechatDisplayName: string;
  avatar?: string;
  boundAt: string;
  lastMessageId?: string;
  lastMessageAt?: string;
};

export type WechatMcpUserBindingStatus = {
  tenantId: string;
  username: string;
  userDisplayName: string;
  role: OwnerProfile["role"];
  disabled: boolean;
  binding?: WechatMcpBinding;
};

export type FeedSource = {
  id: string;
  tenantId: string;
  name: string;
  feedUrl: string;
  enabled: boolean;
  intervalMinutes: number;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastItemAt?: string;
  lastError?: string;
  nextCheckAt: string;
  createdAt: string;
  updatedAt: string;
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
  duplicateCount: number;
  lastDuplicateAt?: string;
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
  integrity: ContentIntegrity;
};

export type ContentIntegrity = {
  score: number;
  bodyCharacters: number;
  imageReferences: number;
  localImages: number;
  missingImageReferences: string[];
  issues: Array<"missing_body" | "broken_asset" | "missing_summary" | "missing_cover" | "unindexed">;
};

export type ContentRevision = {
  revision: number;
  createdAt: string;
  title: string;
  summary: string;
  status: string;
  current: boolean;
};

export type ContentRevisionDetail = ContentRevision & {
  snapshot: Record<string, unknown>;
};

export type MessageAnnotation = {
  id: string;
  messageId: string;
  quote: string;
  note: string;
  color: "mint" | "amber" | "blue" | "rose";
  createdAt: string;
  updatedAt: string;
};

export type SmartCollectionRules = Pick<MessageListOptions,
  "favorite" | "format" | "domain" | "knowledgePoint" | "tool" | "query"> & {
  unread?: boolean;
};

export type SmartCollection = {
  id: string;
  name: string;
  description: string;
  rules: SmartCollectionRules;
  pinned: boolean;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ReviewSuggestion = MessageListItem & {
  reason: string;
  priority: number;
};

export type QualityIssue = MessageListItem & {
  issues: Array<"failed" | "fallback" | "missing_summary" | "missing_cover" | "missing_body" | "broken_asset" | "warning" | "unindexed">;
};

export type QualityOverview = {
  total: number;
  healthy: number;
  processing: number;
  failed: number;
  fallback: number;
  missingSummary: number;
  missingCover: number;
  missingBody: number;
  brokenAssets: number;
  duplicateMessages: number;
  duplicateReceipts: number;
  unindexed: number;
  warnings: number;
  issues: QualityIssue[];
};

export type BackgroundJobType = "ingestion" | "reprocess" | "diagram" | "index" | "sync" | "source_check";
export type BackgroundJobStatus = "queued" | "running" | "retrying" | "completed" | "failed" | "cancelled";

export type BackgroundJob = {
  id: string;
  type: BackgroundJobType;
  resourceId: string;
  title: string;
  status: BackgroundJobStatus;
  phase: string;
  progress: number;
  message: string;
  attempts: number;
  maxAttempts: number;
  error?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
};

export type BackgroundJobOverview = {
  active: number;
  queued: number;
  running: number;
  retrying: number;
  failed: number;
  completedToday: number;
  jobs: BackgroundJob[];
};

export type SearchIndexHealth = {
  completedMessages: number;
  indexedMessages: number;
  indexedChunks: number;
  missingMessages: number;
  coverage: number;
  engine: "fts5" | "scan";
};

export type KnowledgeMapNode = {
  id: string;
  label: string;
  type: "root" | "resource" | "domain" | "concept" | "tool" | "point";
  description?: string;
  evidence?: string;
  group?: string;
  role?: "start" | "process" | "decision" | "result" | "actor" | "artifact" | "milestone" | "topic";
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

export type KnowledgeChunkSearchResult = {
  messageId: string;
  ordinal: number;
  title: string;
  summary: string;
  heading: string;
  content: string;
  domains: string[];
  knowledgePoints: string[];
  score: number;
};

export type KnowledgeChatCitation = {
  messageId: string;
  title: string;
  excerpt: string;
  reference?: string;
};

export type KnowledgeChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: KnowledgeChatCitation[];
  createdAt: string;
};

export type KnowledgeConversation = {
  id: string;
  title: string;
  scopeType: "library" | "message" | "domain" | "collection";
  scopeValue: string;
  scopeLabel: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage?: string;
};

export type MessageListOptions = {
  state?: "inbox" | "library" | "archived";
  active?: boolean;
  favorite?: boolean;
  unread?: boolean;
  format?: ContentFormat;
  category?: string;
  domain?: string;
  knowledgePoint?: string;
  tool?: string;
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

function semanticCoverSql(attachmentAlias = "a", messageAlias = "m"): string {
  return `(
    ${attachmentAlias}.file_name LIKE '%封面%'
    OR ${attachmentAlias}.file_name LIKE '%首图%'
    OR LOWER(${attachmentAlias}.file_name) LIKE '%cover%'
    OR LOWER(${attachmentAlias}.file_name) LIKE '%thumbnail%'
    OR LOWER(${attachmentAlias}.file_name) LIKE '%poster%'
    OR ((${contentFormatSql(messageAlias)})='image' AND ${attachmentAlias}.kind='image')
  )`;
}

function semanticCoverOrderSql(attachmentAlias = "a"): string {
  return `CASE
    WHEN ${attachmentAlias}.file_name LIKE '%封面%'
      OR ${attachmentAlias}.file_name LIKE '%首图%'
      OR LOWER(${attachmentAlias}.file_name) LIKE '%cover%'
      OR LOWER(${attachmentAlias}.file_name) LIKE '%thumbnail%'
      OR LOWER(${attachmentAlias}.file_name) LIKE '%poster%' THEN 0
    ELSE 1 END`;
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

function ftsQuery(terms: string[], operator: "AND" | "OR" = "AND"): string {
  return terms
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(` ${operator} `);
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

function knowledgeContentChunks(
  title: string,
  summary: string,
  keyPoints: string[],
  markdown: string,
  detailsMarkdown: string,
): Array<{ heading: string; content: string }> {
  const sources = [
    { heading: "内容摘要", text: [summary, ...keyPoints.map((point) => `- ${point}`)].filter(Boolean).join("\n") },
    { heading: "文章正文", text: stripNoteEnvelope(markdown) },
    { heading: "延伸整理", text: detailsMarkdown.trim() },
  ];
  const chunks: Array<{ heading: string; content: string }> = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source.text) continue;
    let heading = source.heading;
    let buffer = "";
    const flush = (): void => {
      const content = buffer.trim();
      buffer = "";
      if (content.length < 20) return;
      const fingerprint = normalizedSearchText(content);
      if (seen.has(fingerprint)) return;
      seen.add(fingerprint);
      chunks.push({ heading, content: content.slice(0, 2_000) });
    };
    const paragraphs = source.text.replace(/\r\n/g, "\n").split(/\n{2,}/);
    for (const rawParagraph of paragraphs) {
      const paragraph = rawParagraph.trim();
      if (!paragraph) continue;
      const nextHeading = paragraph.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim();
      if (nextHeading) {
        flush();
        heading = nextHeading.slice(0, 120);
        continue;
      }
      if (paragraph.length > 1_800) {
        flush();
        for (let offset = 0; offset < paragraph.length && chunks.length < 100; offset += 1_500) {
          const content = paragraph.slice(offset, offset + 1_700).trim();
          if (content.length >= 20) chunks.push({ heading, content });
        }
        continue;
      }
      if (buffer && buffer.length + paragraph.length > 1_600) flush();
      buffer += `${buffer ? "\n\n" : ""}${paragraph}`;
    }
    flush();
  }
  if (!chunks.length && title.trim()) chunks.push({ heading: "资料", content: title.trim() });
  return chunks.slice(0, 100);
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
    private readonly database: Database.Database,
    private readonly secrets: SecretBox,
    private readonly tenantId?: string,
    private readonly ownsConnection = true,
    private readonly ftsEnabled = true,
  ) {}

  static async open(
    dataDir: string,
    nanobotWorkspace = path.join(dataDir, "nanobot", "workspace"),
    options: { forceSearchFallback?: boolean } = {},
  ): Promise<AppDatabase> {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const secrets = await SecretBox.load(dataDir);
    const database = new Database(path.join(dataDir, "inbox.sqlite"), { timeout: 5_000 });
    database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    database.function("compact_knowledge_point", (value) => compactKnowledgePoint(value));
    let ftsEnabled = false;
    if (!options.forceSearchFallback) {
      try {
        database.exec("CREATE VIRTUAL TABLE temp.knowledge_relay_fts_probe USING fts5(value)");
        database.exec("DROP TABLE temp.knowledge_relay_fts_probe");
        ftsEnabled = true;
      } catch {
        // Some official Node builds omit FTS5. The durable search tables below
        // remain available and provide a slower token-scan fallback.
      }
    }
    const result = new AppDatabase(dataDir, path.resolve(nanobotWorkspace), database, secrets, undefined, true, ftsEnabled);
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
      this.ftsEnabled,
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
      CREATE TABLE IF NOT EXISTS wechat_mcp_sources (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        endpoint TEXT NOT NULL,
        authorization_enc TEXT,
        display_name TEXT NOT NULL DEFAULT '知流助手',
        account TEXT NOT NULL DEFAULT '',
        poll_interval_seconds INTEGER NOT NULL DEFAULT 8,
        assistant_qr_path TEXT,
        assistant_qr_mime_type TEXT,
        last_poll_at TEXT,
        last_message_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wechat_mcp_binding_codes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_wechat_mcp_codes_tenant ON wechat_mcp_binding_codes(tenant_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS wechat_mcp_bindings (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES wechat_mcp_sources(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account TEXT NOT NULL,
        wechat_username TEXT NOT NULL,
        wechat_display_name TEXT NOT NULL,
        avatar TEXT,
        bound_at TEXT NOT NULL,
        last_message_id TEXT,
        last_message_at TEXT,
        UNIQUE(source_id, account, wechat_username),
        UNIQUE(source_id, tenant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_wechat_mcp_bindings_tenant ON wechat_mcp_bindings(tenant_id);
      CREATE TABLE IF NOT EXISTS feed_sources (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        feed_url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        interval_minutes INTEGER NOT NULL DEFAULT 60,
        last_checked_at TEXT,
        last_success_at TEXT,
        last_item_at TEXT,
        last_error TEXT,
        next_check_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(tenant_id, feed_url)
      );
      CREATE INDEX IF NOT EXISTS idx_feed_sources_due ON feed_sources(enabled, next_check_at);
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
        source_url_key TEXT NOT NULL DEFAULT '',
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
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        last_duplicate_at TEXT,
        published_revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_tenant_seq ON messages(tenant_id, seq DESC);
      CREATE TABLE IF NOT EXISTS message_annotations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        quote TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT 'mint',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_message_annotations_message
        ON message_annotations(tenant_id, message_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS smart_collections (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        rules_json TEXT NOT NULL DEFAULT '{}',
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_smart_collections_tenant
        ON smart_collections(tenant_id, pinned DESC, updated_at DESC);
      CREATE TABLE IF NOT EXISTS message_reviews (
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK(action IN ('reviewed','snoozed','mastered','dismissed')),
        snooze_until TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, message_id)
      );
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
      CREATE TABLE IF NOT EXISTS knowledge_conversations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        scope_type TEXT NOT NULL DEFAULT 'library',
        scope_value TEXT NOT NULL DEFAULT '',
        scope_label TEXT NOT NULL DEFAULT '全部知识库',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_conversations_tenant
        ON knowledge_conversations(tenant_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS knowledge_chat_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES knowledge_conversations(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL,
        citations_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_chat_messages_conversation
        ON knowledge_chat_messages(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        heading TEXT NOT NULL,
        content TEXT NOT NULL,
        indexed_text TEXT NOT NULL,
        UNIQUE(message_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_tenant ON knowledge_chunks(tenant_id, message_id);
      CREATE TABLE IF NOT EXISTS background_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        resource_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('queued','running','retrying','completed','failed','cancelled')),
        phase TEXT NOT NULL DEFAULT 'queued',
        progress INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        error TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_background_jobs_tenant_updated
        ON background_jobs(tenant_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_background_jobs_active_resource
        ON background_jobs(tenant_id, type, resource_id)
        WHERE status IN ('queued','running','retrying') AND resource_id<>'';
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
      "ALTER TABLE messages ADD COLUMN duplicate_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE messages ADD COLUMN last_duplicate_at TEXT",
      "ALTER TABLE knowledge_conversations ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'library'",
      "ALTER TABLE knowledge_conversations ADD COLUMN scope_value TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE knowledge_conversations ADD COLUMN scope_label TEXT NOT NULL DEFAULT '全部知识库'",
    ]) {
      try {
        this.database.exec(statement);
      } catch (error) {
        if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
      }
    }
    this.migrateCaptureColumns();
    try {
      this.database.exec("ALTER TABLE messages ADD COLUMN source_url_key TEXT NOT NULL DEFAULT ''");
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
    }
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
    const claimedUrlKeys = new Set<string>();
    for (const row of this.all("SELECT id,tenant_id,source_url FROM messages WHERE source_url<>'' ORDER BY seq")) {
      const key = canonicalCaptureUrl(rowString(row, "source_url"));
      const tenantKey = `${rowString(row, "tenant_id")}\n${key}`;
      const uniqueKey = key && !claimedUrlKeys.has(tenantKey) ? key : "";
      if (uniqueKey) claimedUrlKeys.add(tenantKey);
      this.run("UPDATE messages SET source_url_key=? WHERE id=?", uniqueKey, rowString(row, "id"));
    }
    this.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_tenant_source_url
      ON messages(tenant_id,source_url_key) WHERE source_url_key<>''`);
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
    if (this.ftsEnabled) {
      this.database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS message_search_fts USING fts5(
          message_id UNINDEXED,
          tenant_id UNINDEXED,
          title,
          summary,
          body,
          metadata,
          all_text,
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
          message_id UNINDEXED,
          tenant_id UNINDEXED,
          ordinal UNINDEXED,
          heading,
          content,
          indexed_text,
          tokenize='unicode61 remove_diacritics 2'
        );
      `);
    }
    this.database.exec(`
      UPDATE background_jobs SET
        status='failed',phase='interrupted',message=CASE
          WHEN type='diagram' THEN '服务重启后需要重新提交图解任务'
          WHEN type='index' THEN '服务重启后需要重新启动索引检查'
          ELSE '服务重启前同步任务未完成，需要重新提交'
        END,
        error=COALESCE(error,'服务在任务完成前重新启动'),completed_at=COALESCE(completed_at,updated_at)
      WHERE type IN ('diagram','index','sync') AND status IN ('queued','running','retrying');
      UPDATE background_jobs SET
        status='queued',phase='recovering',progress=MIN(progress,10),message='服务已恢复，等待继续处理',started_at=NULL
      WHERE type IN ('ingestion','reprocess','source_check') AND status IN ('running','retrying');
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

  resetUserPassword(userId: string, newPassword: string): { username: string; revokedSessions: number } {
    const adminId = this.requireAdmin();
    if (userId === adminId) throw new Error("请在账号与安全中修改当前管理员密码");
    if (newPassword.length < 8) throw new Error("新密码至少需要 8 个字符");
    const user = this.maybeOne("SELECT id,username,role FROM users WHERE id=?", userId);
    if (!user) throw new Error("用户不存在");
    if (rowString(user, "role") === "admin") throw new Error("不能重置其他管理员账户密码");
    const revokedSessions = this.transaction(() => {
      this.run("UPDATE users SET password_hash=? WHERE id=?", hashPassword(newPassword), userId);
      return Number(this.run("DELETE FROM sessions WHERE user_id=?", userId).changes);
    });
    return { username: rowString(user, "username"), revokedSessions };
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

  listInvitations(options: {
    limit?: number;
    offset?: number;
    status?: "all" | "pending" | "used" | "expired" | "revoked";
  } = {}): {
    invitations: Array<{
    id: string;
    expiresAt: string;
    createdAt: string;
    consumed: boolean;
    revoked: boolean;
    consumedBy?: {
      username: string;
      displayName: string;
    };
    }>;
    total: number;
    limit: number;
    offset: number;
  } {
    const adminId = this.requireAdmin();
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit || 10)));
    const offset = Math.max(0, Math.floor(options.offset || 0));
    const status = options.status || "all";
    const statusSql = status === "pending"
      ? " AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?"
      : status === "used"
        ? " AND i.consumed_at IS NOT NULL"
        : status === "expired"
          ? " AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at<=?"
          : status === "revoked"
            ? " AND i.revoked_at IS NOT NULL"
            : "";
    const statusValues: SqlValue[] = [adminId, ...(["pending", "expired"].includes(status) ? [now()] : [])];
    const total = rowNumber(this.one(
      `SELECT COUNT(*) AS count FROM invitations i WHERE i.created_by=?${statusSql}`,
      ...statusValues,
    ), "count");
    const invitations = this.all(
      `SELECT i.*,u.username AS consumed_username,u.display_name AS consumed_display_name
       FROM invitations i
       LEFT JOIN users u ON u.id=i.consumed_by
       WHERE i.created_by=?${statusSql} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
      ...statusValues,
      limit,
      offset,
    ).map((row) => ({
      id: rowString(row, "id"),
      expiresAt: rowString(row, "expires_at"),
      createdAt: rowString(row, "created_at"),
      consumed: Boolean(rowOptional(row, "consumed_at")),
      revoked: Boolean(rowOptional(row, "revoked_at")),
      ...(rowOptional(row, "consumed_username") ? {
        consumedBy: {
          username: rowString(row, "consumed_username"),
          displayName: rowString(row, "consumed_display_name"),
        },
      } : {}),
    }));
    return { invitations, total, limit, offset };
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

  listKnowledgeConversations(limit = 30, offset = 0, search = ""): {
    conversations: KnowledgeConversation[];
    total: number;
  } {
    const tenantId = this.requireOwnerId();
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit) || 30));
    const safeOffset = Math.max(0, Math.floor(offset) || 0);
    const normalizedSearch = search.trim().slice(0, 160);
    const searchPattern = `%${normalizedSearch.replace(/[\\%_]/g, "\\$&")}%`;
    const filterSql = normalizedSearch
      ? ` AND (c.title LIKE ? ESCAPE '\\' OR EXISTS (
          SELECT 1 FROM knowledge_chat_messages sm
          WHERE sm.conversation_id=c.id AND sm.content LIKE ? ESCAPE '\\'
        ))`
      : "";
    const filterArgs = normalizedSearch ? [searchPattern, searchPattern] : [];
    const total = rowNumber(this.one(
      `SELECT COUNT(*) AS count FROM knowledge_conversations c WHERE c.tenant_id=?${filterSql}`,
      tenantId,
      ...filterArgs,
    ), "count");
    const conversations = this.all(
      `SELECT c.*,
        (SELECT COUNT(*) FROM knowledge_chat_messages m WHERE m.conversation_id=c.id) AS message_count,
        (SELECT content FROM knowledge_chat_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) AS last_message
       FROM knowledge_conversations c
       WHERE c.tenant_id=?${filterSql} ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`,
      tenantId,
      ...filterArgs,
      safeLimit,
      safeOffset,
    ).map((row) => ({
      id: rowString(row, "id"),
      title: rowString(row, "title"),
      scopeType: this.knowledgeConversationScopeType(rowString(row, "scope_type")),
      scopeValue: rowString(row, "scope_value"),
      scopeLabel: rowString(row, "scope_label") || "全部知识库",
      createdAt: rowString(row, "created_at"),
      updatedAt: rowString(row, "updated_at"),
      messageCount: rowNumber(row, "message_count"),
      lastMessage: rowOptional(row, "last_message"),
    }));
    return { conversations, total };
  }

  createKnowledgeConversation(
    title = "新对话",
    scope: { type?: "library" | "message" | "domain" | "collection"; value?: string; label?: string } = {},
  ): KnowledgeConversation {
    const tenantId = this.requireOwnerId();
    const id = crypto.randomUUID();
    const timestamp = now();
    const normalizedTitle = title.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80) || "新对话";
    const scopeType = this.knowledgeConversationScopeType(scope.type || "library");
    const scopeValue = scopeType === "library" ? "" : (scope.value || "").trim().slice(0, 300);
    const scopeLabel = (scope.label || (scopeType === "library" ? "全部知识库" : scopeValue))
      .replace(/[\r\n\t]+/g, " ").trim().slice(0, 120) || "全部知识库";
    this.run(
      `INSERT INTO knowledge_conversations(
        id,tenant_id,title,scope_type,scope_value,scope_label,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?)`,
      id,
      tenantId,
      normalizedTitle,
      scopeType,
      scopeValue,
      scopeLabel,
      timestamp,
      timestamp,
    );
    return {
      id,
      title: normalizedTitle,
      scopeType,
      scopeValue,
      scopeLabel,
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: 0,
    };
  }

  getKnowledgeConversation(id: string): (KnowledgeConversation & { messages: KnowledgeChatMessage[] }) | undefined {
    const tenantId = this.requireOwnerId();
    const row = this.maybeOne(
      `SELECT c.*,(SELECT COUNT(*) FROM knowledge_chat_messages m WHERE m.conversation_id=c.id) AS message_count
       FROM knowledge_conversations c WHERE c.id=? AND c.tenant_id=?`,
      id,
      tenantId,
    );
    if (!row) return undefined;
    const messages = this.all(
      "SELECT * FROM knowledge_chat_messages WHERE conversation_id=? AND tenant_id=? ORDER BY created_at,rowid",
      id,
      tenantId,
    ).map((message) => ({
      id: rowString(message, "id"),
      role: rowString(message, "role") === "assistant" ? "assistant" as const : "user" as const,
      content: rowString(message, "content"),
      citations: safeJson<KnowledgeChatCitation[]>(rowString(message, "citations_json"), [])
        .filter((citation) => citation && typeof citation.messageId === "string" && typeof citation.title === "string")
        .slice(0, 24),
      createdAt: rowString(message, "created_at"),
    }));
    return {
      id: rowString(row, "id"),
      title: rowString(row, "title"),
      scopeType: this.knowledgeConversationScopeType(rowString(row, "scope_type")),
      scopeValue: rowString(row, "scope_value"),
      scopeLabel: rowString(row, "scope_label") || "全部知识库",
      createdAt: rowString(row, "created_at"),
      updatedAt: rowString(row, "updated_at"),
      messageCount: rowNumber(row, "message_count"),
      messages,
    };
  }

  appendKnowledgeChatMessage(
    conversationId: string,
    role: "user" | "assistant",
    content: string,
    citations: KnowledgeChatCitation[] = [],
  ): KnowledgeChatMessage {
    const tenantId = this.requireOwnerId();
    const conversation = this.maybeOne(
      "SELECT id,title FROM knowledge_conversations WHERE id=? AND tenant_id=?",
      conversationId,
      tenantId,
    );
    if (!conversation) throw new Error("问答会话不存在");
    const normalizedContent = content.trim().slice(0, 20_000);
    if (!normalizedContent) throw new Error("消息内容不能为空");
    const normalizedCitations = citations
      .filter((citation) => citation.messageId && citation.title)
      .slice(0, 24)
      .map((citation) => ({
        messageId: citation.messageId.slice(0, 300),
        title: citation.title.replace(/[\r\n\t]+/g, " ").trim().slice(0, 160),
        excerpt: citation.excerpt.replace(/[\r\n\t]+/g, " ").trim().slice(0, 500),
        ...(citation.reference && /^S\d{1,2}$/.test(citation.reference) ? { reference: citation.reference } : {}),
      }));
    const id = crypto.randomUUID();
    const createdAt = now();
    this.transaction(() => {
      this.run(
        "INSERT INTO knowledge_chat_messages(id,conversation_id,tenant_id,role,content,citations_json,created_at) VALUES(?,?,?,?,?,?,?)",
        id,
        conversationId,
        tenantId,
        role,
        normalizedContent,
        JSON.stringify(normalizedCitations),
        createdAt,
      );
      const nextTitle = role === "user" && rowString(conversation, "title") === "新对话"
        ? normalizedContent.replace(/[?？!！。]+$/g, "").slice(0, 48) || "新对话"
        : rowString(conversation, "title");
      this.run("UPDATE knowledge_conversations SET title=?,updated_at=? WHERE id=?", nextTitle, createdAt, conversationId);
    });
    return { id, role, content: normalizedContent, citations: normalizedCitations, createdAt };
  }

  deleteKnowledgeConversation(id: string): boolean {
    return Number(this.run(
      "DELETE FROM knowledge_conversations WHERE id=? AND tenant_id=?",
      id,
      this.requireOwnerId(),
    ).changes) === 1;
  }

  knowledgeConversationScopeMessageIds(conversation: KnowledgeConversation, limit = 5_000): string[] | undefined {
    if (conversation.scopeType === "library") return undefined;
    if (conversation.scopeType === "message") {
      return this.getMessage(conversation.scopeValue) ? [conversation.scopeValue] : [];
    }
    if (conversation.scopeType === "domain") {
      return this.listMessages(limit, undefined, { organized: true, domain: conversation.scopeValue })
        .map((item) => item.id);
    }
    const collection = this.listSmartCollections().find((item) => item.id === conversation.scopeValue);
    if (!collection) return [];
    return this.listMessages(limit, undefined, {
      organized: true,
      ...(collection.rules.favorite ? { favorite: true } : {}),
      ...(collection.rules.unread ? { unread: true } : {}),
      ...(collection.rules.format ? { format: collection.rules.format } : {}),
      ...(collection.rules.domain ? { domain: collection.rules.domain } : {}),
      ...(collection.rules.knowledgePoint ? { knowledgePoint: collection.rules.knowledgePoint } : {}),
      ...(collection.rules.tool ? { tool: collection.rules.tool } : {}),
      ...(collection.rules.query ? { query: collection.rules.query } : {}),
    }).map((item) => item.id);
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

  getWechatMcpSource(): WechatMcpSource | undefined {
    const row = this.maybeOne("SELECT * FROM wechat_mcp_sources WHERE id='default'");
    if (!row) return undefined;
    return {
      id: rowString(row, "id"),
      enabled: Boolean(rowNumber(row, "enabled")),
      endpoint: rowString(row, "endpoint"),
      authorizationConfigured: Boolean(rowString(row, "authorization_enc")),
      displayName: rowString(row, "display_name") || "知流助手",
      account: rowString(row, "account"),
      pollIntervalSeconds: Math.max(3, rowNumber(row, "poll_interval_seconds") || 8),
      qrConfigured: Boolean(rowString(row, "assistant_qr_path")),
      qrMimeType: rowString(row, "assistant_qr_mime_type") || undefined,
      lastPollAt: rowString(row, "last_poll_at") || undefined,
      lastMessageAt: rowString(row, "last_message_at") || undefined,
      lastError: rowString(row, "last_error") || undefined,
      updatedAt: rowString(row, "updated_at"),
    };
  }

  getWechatMcpSourceSecret(): WechatMcpSourceSecret | undefined {
    const source = this.getWechatMcpSource();
    if (!source) return undefined;
    const row = this.one("SELECT authorization_enc,assistant_qr_path FROM wechat_mcp_sources WHERE id=?", source.id);
    const encrypted = rowString(row, "authorization_enc");
    return {
      ...source,
      authorization: encrypted ? this.secrets.decrypt(encrypted) : "",
      qrPath: rowString(row, "assistant_qr_path") || undefined,
    };
  }

  saveWechatMcpSource(input: {
    endpoint: string;
    authorization?: string;
    displayName: string;
    account: string;
    pollIntervalSeconds: number;
    enabled: boolean;
  }): WechatMcpSource {
    const endpoint = new URL(input.endpoint.trim()).toString();
    const existing = this.maybeOne("SELECT authorization_enc FROM wechat_mcp_sources WHERE id='default'");
    const authorization = input.authorization?.trim();
    const authorizationEnc = authorization
      ? this.secrets.encrypt(authorization)
      : existing ? rowString(existing, "authorization_enc") || null : null;
    if (input.enabled && !authorizationEnc) throw new Error("启用微信助手前请配置 MCP Authorization");
    this.run(
      `INSERT INTO wechat_mcp_sources(
        id,enabled,endpoint,authorization_enc,display_name,account,poll_interval_seconds,updated_at
       ) VALUES('default',?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        enabled=excluded.enabled,endpoint=excluded.endpoint,authorization_enc=excluded.authorization_enc,
        display_name=excluded.display_name,account=excluded.account,
        poll_interval_seconds=excluded.poll_interval_seconds,updated_at=excluded.updated_at`,
      input.enabled ? 1 : 0,
      endpoint,
      authorizationEnc,
      input.displayName.trim().slice(0, 80) || "知流助手",
      input.account.trim().slice(0, 200),
      Math.max(3, Math.min(60, Math.floor(input.pollIntervalSeconds || 8))),
      now(),
    );
    return this.getWechatMcpSource()!;
  }

  setWechatMcpQr(filePath?: string, mimeType?: string): void {
    const source = this.getWechatMcpSource();
    if (!source) throw new Error("请先保存微信助手 MCP 配置");
    this.run(
      "UPDATE wechat_mcp_sources SET assistant_qr_path=?,assistant_qr_mime_type=?,updated_at=? WHERE id=?",
      filePath || null,
      mimeType || null,
      now(),
      source.id,
    );
  }

  updateWechatMcpStatus(input: { lastPollAt?: string; lastMessageAt?: string; lastError?: string | null }): void {
    const source = this.getWechatMcpSource();
    if (!source) return;
    this.run(
      `UPDATE wechat_mcp_sources SET
        last_poll_at=COALESCE(?,last_poll_at),last_message_at=COALESCE(?,last_message_at),last_error=?
       WHERE id=?`,
      input.lastPollAt || null,
      input.lastMessageAt || null,
      input.lastError === undefined ? source.lastError || null : input.lastError,
      source.id,
    );
  }

  listFeedSources(): FeedSource[] {
    return this.all(
      "SELECT * FROM feed_sources WHERE tenant_id=? ORDER BY enabled DESC,updated_at DESC",
      this.requireOwnerId(),
    ).map((row) => this.mapFeedSource(row));
  }

  createFeedSource(input: { name: string; feedUrl: string; intervalMinutes?: number; enabled?: boolean }): FeedSource {
    const feedUrl = normalizeFeedUrl(input.feedUrl);
    const createdAt = now();
    const id = crypto.randomUUID();
    this.run(
      `INSERT INTO feed_sources(
        id,tenant_id,name,feed_url,enabled,interval_minutes,next_check_at,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
      id,
      this.requireOwnerId(),
      input.name.trim().slice(0, 80) || new URL(feedUrl).hostname,
      feedUrl,
      input.enabled === false ? 0 : 1,
      Math.max(15, Math.min(1440, Math.floor(input.intervalMinutes || 60))),
      createdAt,
      createdAt,
      createdAt,
    );
    return this.listFeedSources().find((item) => item.id === id)!;
  }

  updateFeedSource(sourceId: string, input: Partial<Pick<FeedSource, "name" | "feedUrl" | "enabled" | "intervalMinutes">>): FeedSource | undefined {
    const tenantId = this.requireOwnerId();
    const row = this.maybeOne("SELECT * FROM feed_sources WHERE id=? AND tenant_id=?", sourceId, tenantId);
    if (!row) return undefined;
    const feedUrl = input.feedUrl === undefined ? rowString(row, "feed_url") : normalizeFeedUrl(input.feedUrl);
    const enabled = input.enabled === undefined ? Boolean(rowNumber(row, "enabled")) : input.enabled;
    this.run(
      `UPDATE feed_sources SET name=?,feed_url=?,enabled=?,interval_minutes=?,next_check_at=?,updated_at=?
       WHERE id=? AND tenant_id=?`,
      input.name === undefined ? rowString(row, "name") : input.name.trim().slice(0, 80) || new URL(feedUrl).hostname,
      feedUrl,
      enabled ? 1 : 0,
      input.intervalMinutes === undefined
        ? rowNumber(row, "interval_minutes")
        : Math.max(15, Math.min(1440, Math.floor(input.intervalMinutes || 60))),
      enabled ? now() : rowString(row, "next_check_at"),
      now(),
      sourceId,
      tenantId,
    );
    return this.listFeedSources().find((item) => item.id === sourceId);
  }

  deleteFeedSource(sourceId: string): boolean {
    return this.run(
      "DELETE FROM feed_sources WHERE id=? AND tenant_id=?",
      sourceId,
      this.requireOwnerId(),
    ).changes > 0;
  }

  dueFeedSources(limit = 20): FeedSource[] {
    return this.all(
      `SELECT f.* FROM feed_sources f JOIN users u ON u.id=f.tenant_id
       WHERE f.enabled=1 AND f.next_check_at<=? AND u.disabled_at IS NULL
       ORDER BY f.next_check_at LIMIT ?`,
      now(),
      Math.max(1, Math.min(100, limit)),
    ).map((row) => this.mapFeedSource(row));
  }

  markFeedSourceChecked(sourceId: string, input: { success: boolean; lastItemAt?: string; error?: string }): void {
    const row = this.maybeOne("SELECT interval_minutes FROM feed_sources WHERE id=?", sourceId);
    if (!row) return;
    const checkedAt = now();
    const nextCheckAt = new Date(Date.now() + Math.max(15, rowNumber(row, "interval_minutes")) * 60_000).toISOString();
    this.run(
      `UPDATE feed_sources SET last_checked_at=?,last_success_at=CASE WHEN ?=1 THEN ? ELSE last_success_at END,
       last_item_at=COALESCE(?,last_item_at),last_error=?,next_check_at=?,updated_at=? WHERE id=?`,
      checkedAt,
      input.success ? 1 : 0,
      checkedAt,
      input.lastItemAt || null,
      input.success ? null : (input.error || "订阅检查失败").slice(0, 500),
      nextCheckAt,
      checkedAt,
      sourceId,
    );
  }

  hasFeedEntry(sourceId: string, externalId: string, url?: string): boolean {
    const sourceUrlKey = canonicalCaptureUrl(url);
    const identity = this.maybeOne(
      `SELECT id FROM messages WHERE tenant_id=? AND source_channel='rss'
       AND source_connection_id=? AND source_external_id=? LIMIT 1`,
      this.requireOwnerId(),
      sourceId,
      externalId,
    );
    if (identity) return true;
    return Boolean(sourceUrlKey && this.maybeOne(
      "SELECT id FROM messages WHERE tenant_id=? AND source_url_key=? LIMIT 1",
      this.requireOwnerId(),
      sourceUrlKey,
    ));
  }

  createWechatMcpBindingCode(minutes = 15): { code: string; expiresAt: string } {
    const tenantId = this.requireOwnerId();
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let body = "";
    for (const byte of crypto.randomBytes(8)) body += alphabet[byte % alphabet.length];
    const code = `ZL-${body.slice(0, 4)}-${body.slice(4)}`;
    const createdAt = now();
    const expiresAt = new Date(Date.now() + Math.max(5, Math.min(60, minutes)) * 60_000).toISOString();
    this.transaction(() => {
      this.run("DELETE FROM wechat_mcp_binding_codes WHERE tenant_id=? AND consumed_at IS NULL", tenantId);
      this.run(
        "INSERT INTO wechat_mcp_binding_codes(id,tenant_id,code_hash,expires_at,created_at) VALUES(?,?,?,?,?)",
        crypto.randomUUID(),
        tenantId,
        tokenHash(code),
        expiresAt,
        createdAt,
      );
    });
    return { code, expiresAt };
  }

  consumeWechatMcpBindingCode(input: {
    code: string;
    sourceId: string;
    account: string;
    wechatUsername: string;
    wechatDisplayName: string;
    avatar?: string;
  }): WechatMcpBinding | undefined {
    const code = input.code.trim().toUpperCase();
    const row = this.maybeOne(
      `SELECT * FROM wechat_mcp_binding_codes
       WHERE code_hash=? AND consumed_at IS NULL AND expires_at>?`,
      tokenHash(code),
      now(),
    );
    if (!row) return undefined;
    const tenantId = rowString(row, "tenant_id");
    const id = crypto.randomUUID();
    const boundAt = now();
    this.transaction(() => {
      this.run("DELETE FROM wechat_mcp_bindings WHERE source_id=? AND tenant_id=?", input.sourceId, tenantId);
      this.run(
        `INSERT INTO wechat_mcp_bindings(
          id,source_id,tenant_id,account,wechat_username,wechat_display_name,avatar,bound_at
         ) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_id,account,wechat_username) DO UPDATE SET
          tenant_id=excluded.tenant_id,wechat_display_name=excluded.wechat_display_name,
          avatar=excluded.avatar,bound_at=excluded.bound_at,last_message_id=NULL,last_message_at=NULL`,
        id,
        input.sourceId,
        tenantId,
        input.account,
        input.wechatUsername,
        input.wechatDisplayName,
        input.avatar || null,
        boundAt,
      );
      this.run("UPDATE wechat_mcp_binding_codes SET consumed_at=? WHERE id=?", boundAt, rowString(row, "id"));
    });
    return this.getWechatMcpBindingForTenant(tenantId);
  }

  getWechatMcpBinding(sourceId: string, account: string, wechatUsername: string): WechatMcpBinding | undefined {
    const row = this.maybeOne(
      `SELECT b.*,u.username,u.display_name AS user_display_name FROM wechat_mcp_bindings b
       JOIN users u ON u.id=b.tenant_id AND u.disabled_at IS NULL
       WHERE b.source_id=? AND b.account=? AND b.wechat_username=?`,
      sourceId,
      account,
      wechatUsername,
    );
    return row ? this.mapWechatMcpBinding(row) : undefined;
  }

  getWechatMcpBindingForTenant(tenantId = this.requireOwnerId()): WechatMcpBinding | undefined {
    const row = this.maybeOne(
      `SELECT b.*,u.username,u.display_name AS user_display_name FROM wechat_mcp_bindings b
       JOIN users u ON u.id=b.tenant_id WHERE b.source_id='default' AND b.tenant_id=?`,
      tenantId,
    );
    return row ? this.mapWechatMcpBinding(row) : undefined;
  }

  listWechatMcpBindings(): WechatMcpBinding[] {
    return this.all(
      `SELECT b.*,u.username,u.display_name AS user_display_name FROM wechat_mcp_bindings b
       JOIN users u ON u.id=b.tenant_id ORDER BY b.bound_at DESC`,
    ).map((row) => this.mapWechatMcpBinding(row));
  }

  listWechatMcpUserBindingStatuses(): WechatMcpUserBindingStatus[] {
    this.requireAdmin();
    return this.all(
      `SELECT
        u.id AS user_tenant_id,u.username,u.display_name AS user_display_name,
        u.role,u.disabled_at,
        b.id AS binding_id,b.source_id,b.tenant_id,b.account,b.wechat_username,
        b.wechat_display_name,b.avatar,b.bound_at,b.last_message_id,b.last_message_at
       FROM users u
       LEFT JOIN wechat_mcp_bindings b ON b.source_id='default' AND b.tenant_id=u.id
       ORDER BY CASE WHEN u.role='admin' THEN 0 ELSE 1 END,u.created_at`,
    ).map((row) => {
      const tenantId = rowString(row, "user_tenant_id");
      const username = rowString(row, "username");
      const userDisplayName = rowString(row, "user_display_name");
      const bindingId = rowString(row, "binding_id");
      return {
        tenantId,
        username,
        userDisplayName,
        role: rowString(row, "role") === "admin" ? "admin" as const : "member" as const,
        disabled: Boolean(rowString(row, "disabled_at")),
        ...(bindingId ? {
          binding: {
            id: bindingId,
            tenantId,
            username,
            userDisplayName,
            account: rowString(row, "account"),
            wechatUsername: rowString(row, "wechat_username"),
            wechatDisplayName: rowString(row, "wechat_display_name"),
            avatar: rowString(row, "avatar") || undefined,
            boundAt: rowString(row, "bound_at"),
            lastMessageId: rowString(row, "last_message_id") || undefined,
            lastMessageAt: rowString(row, "last_message_at") || undefined,
          },
        } : {}),
      };
    });
  }

  deleteWechatMcpBindingForTenant(tenantId = this.requireOwnerId()): boolean {
    return Number(this.run("DELETE FROM wechat_mcp_bindings WHERE source_id='default' AND tenant_id=?", tenantId).changes) > 0;
  }

  deleteWechatMcpBinding(id: string): boolean {
    return Number(this.run("DELETE FROM wechat_mcp_bindings WHERE id=?", id).changes) > 0;
  }

  updateWechatMcpBindingCursor(id: string, messageId: string, messageAt: string): void {
    this.run(
      "UPDATE wechat_mcp_bindings SET last_message_id=?,last_message_at=? WHERE id=?",
      messageId,
      messageAt,
      id,
    );
  }

  private mapWechatMcpBinding(row: SqlRow): WechatMcpBinding {
    return {
      id: rowString(row, "id"),
      tenantId: rowString(row, "tenant_id"),
      username: rowString(row, "username") || undefined,
      userDisplayName: rowString(row, "user_display_name") || undefined,
      account: rowString(row, "account"),
      wechatUsername: rowString(row, "wechat_username"),
      wechatDisplayName: rowString(row, "wechat_display_name"),
      avatar: rowString(row, "avatar") || undefined,
      boundAt: rowString(row, "bound_at"),
      lastMessageId: rowString(row, "last_message_id") || undefined,
      lastMessageAt: rowString(row, "last_message_at") || undefined,
    };
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
    const ownerId = this.requireOwnerId();
    const sameId = this.maybeOne(
      "SELECT id FROM messages WHERE tenant_id=? AND id=? LIMIT 1",
      ownerId,
      capture.id,
    );
    if (sameId) {
      this.recordDuplicateCapture(rowString(sameId, "id"), capture.receivedAt);
      return false;
    }
    const sourceUrl = capture.source.url || firstHttpUrl(capture.text) || "";
    const sourceUrlKey = canonicalCaptureUrl(sourceUrl);
    const sameUrl = sourceUrlKey ? this.maybeOne(
      "SELECT id FROM messages WHERE tenant_id=? AND source_url_key=? LIMIT 1",
      ownerId,
      sourceUrlKey,
    ) : undefined;
    if (sameUrl) {
      this.recordDuplicateCapture(rowString(sameUrl, "id"), capture.receivedAt);
      return false;
    }
    const connectionId = capture.source.connectionId;
    // Shared WeChat assistant intake uses the WeChat channel for source
    // semantics, but it is not an iLink bot account. Only persist the optional
    // bot foreign key when the connection really belongs to this tenant.
    const botAccountId = capture.source.channel === "wechat" && connectionId
      ? rowString(this.maybeOne(
        "SELECT id FROM bot_accounts WHERE id=? AND tenant_id=?",
        connectionId,
        ownerId,
      ) || {}, "id") || null
      : null;
    const createdAt = now();
    this.transaction(() => {
      this.run(
        `INSERT INTO messages(
          id,tenant_id,bot_account_id,source_id,source_channel,source_type,source_external_id,
          source_connection_id,source_name,source_url,source_url_key,capture_type,sender_id,session_id,received_at,sent_at,text,
          note_title,note_markdown,category,tags_json,summary,key_points_json,knowledge_points_json,domains_json,tools_json,
          details_markdown,reason,suggested_action,sensitivity,confidence,warnings_json,
          created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        capture.id,
        ownerId,
        botAccountId,
        capture.source.externalId || capture.id,
        capture.source.channel,
        capture.source.type,
        capture.source.externalId || capture.id,
        capture.source.connectionId || "owner",
        capture.source.name,
        sourceUrl,
        sourceUrlKey,
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

  private recordDuplicateCapture(messageId: string, receivedAt?: string): void {
    this.run(
      `UPDATE messages SET duplicate_count=duplicate_count+1,last_duplicate_at=?,updated_at=?
       WHERE id=? AND tenant_id=?`,
      receivedAt || now(),
      now(),
      messageId,
      this.requireOwnerId(),
    );
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

  replaceDerivedAttachments(
    messageId: string,
    attachments: PublicInboundMessage["attachments"],
  ): void {
    this.transaction(() => {
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
    const knowledgePoints = safeJson<string[]>(rowString(row, "knowledge_points_json"), []).slice(0, 20);
    const domains = safeJson<string[]>(rowString(row, "domains_json"), []).slice(0, 20);
    const tools = safeJson<string[]>(rowString(row, "tools_json"), []).slice(0, 20);
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
      knowledgePoints,
      domains,
      tools,
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
      category,
      knowledgePoints,
      domains,
      tools,
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
    if (options.unread) where.push("m.read_at IS NULL");
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
    if (options.knowledgePoint) {
      const point = compactKnowledgePoint(options.knowledgePoint);
      where.push("EXISTS(SELECT 1 FROM json_each(m.knowledge_points_json) point WHERE compact_knowledge_point(point.value)=?)");
      values.push(point);
    }
    if (options.tool) {
      where.push("EXISTS(SELECT 1 FROM json_each(m.tools_json) tool WHERE LOWER(tool.value)=LOWER(?))");
      values.push(options.tool);
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
        AND ${semanticCoverSql("a", "m")}
        ORDER BY ${semanticCoverOrderSql("a")},a.rowid LIMIT 1) AS cover_attachment_id,
       (SELECT a.mime_type FROM attachments a WHERE a.message_id=m.id AND a.mime_type LIKE 'image/%'
        AND ${semanticCoverSql("a", "m")}
        ORDER BY ${semanticCoverOrderSql("a")},a.rowid LIMIT 1) AS cover_mime_type,
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
    const useFts = terms.length > 0 && this.ftsEnabled;
    const values: SqlValue[] = [];
    const where: string[] = [];
    let sql = `SELECT m.*,(SELECT COUNT(*) FROM attachments a WHERE a.message_id=m.id) AS attachment_count,
      0 AS archived,${useFts ? "bm25(message_search_fts,0,0,10,7,2,5,1)" : "0"} AS fts_rank
      FROM messages m ${useFts
        ? "JOIN message_search_fts ON message_search_fts.message_id=m.id"
        : terms.length ? "JOIN message_search ON message_search.message_id=m.id" : ""}`;
    where.push("m.tenant_id=?");
    values.push(this.requireOwnerId());
    if (useFts) {
      where.push("message_search_fts.tenant_id=?");
      values.push(this.requireOwnerId());
      where.push("message_search_fts MATCH ?");
      values.push(ftsQuery(terms));
    } else if (terms.length) {
      where.push("message_search.tenant_id=?");
      values.push(this.requireOwnerId());
      where.push(terms.map(() => "instr(message_search.all_text,?)>0").join(" AND "));
      values.push(...terms);
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
        }, Math.max(0, -rowNumber(row, "fts_rank") * 100)),
      };
    }).sort((left, right) => right.searchScore - left.searchScore || right.seq - left.seq)
      .slice(0, resultLimit)
      .map(({ searchScore: _searchScore, ...item }) => item);
  }

  searchKnowledgeChunks(query: string, limit = 30): KnowledgeChunkSearchResult[] {
    const terms = querySearchTokens(query);
    if (!terms.length) return [];
    const tenantId = this.requireOwnerId();
    const rows = this.ftsEnabled
      ? this.all(
        `SELECT k.*,m.note_title,m.summary,m.domains_json,m.knowledge_points_json,m.seq,
          bm25(knowledge_chunks_fts,0,0,0,8,3,1) AS fts_rank
         FROM knowledge_chunks k
         JOIN knowledge_chunks_fts ON knowledge_chunks_fts.message_id=k.message_id
          AND CAST(knowledge_chunks_fts.ordinal AS INTEGER)=k.ordinal
         JOIN messages m ON m.id=k.message_id
         WHERE k.tenant_id=? AND m.tenant_id=? AND m.agent_status='completed'
           AND knowledge_chunks_fts.tenant_id=? AND knowledge_chunks_fts MATCH ?
         ORDER BY m.seq DESC,k.ordinal LIMIT 1200`,
        tenantId,
        tenantId,
        tenantId,
        ftsQuery(terms, "OR"),
      )
      : this.all(
        `SELECT k.*,m.note_title,m.summary,m.domains_json,m.knowledge_points_json,m.seq,0 AS fts_rank
         FROM knowledge_chunks k JOIN messages m ON m.id=k.message_id
         WHERE k.tenant_id=? AND m.tenant_id=? AND m.agent_status='completed'
           AND (${terms.map(() => "instr(k.indexed_text,?)>0").join(" OR ")})
         ORDER BY m.seq DESC,k.ordinal LIMIT 1200`,
        tenantId,
        tenantId,
        ...terms,
      );
    const safeLimit = Math.max(1, Math.min(80, Math.floor(limit) || 30));
    return rows.map((row) => {
      const titleIndex = indexedSearchText(rowString(row, "note_title"));
      const headingIndex = indexedSearchText(rowString(row, "heading"));
      const contentIndex = rowString(row, "indexed_text");
      const matchedTerms = terms.filter((term) => contentIndex.includes(term));
      return {
        messageId: rowString(row, "message_id"),
        ordinal: rowNumber(row, "ordinal"),
        title: rowString(row, "note_title"),
        summary: rowString(row, "summary"),
        heading: rowString(row, "heading"),
        content: rowString(row, "content"),
        domains: safeJson<string[]>(rowString(row, "domains_json"), []),
        knowledgePoints: safeJson<string[]>(rowString(row, "knowledge_points_json"), [])
          .map(compactKnowledgePoint)
          .filter(Boolean),
        score: Math.max(0, -rowNumber(row, "fts_rank") * 100) + matchedTerms.length * 3
          + matchedTerms.filter((term) => titleIndex.includes(term)).length * 9
          + matchedTerms.filter((term) => headingIndex.includes(term)).length * 7,
      };
    }).sort((left, right) => right.score - left.score || left.ordinal - right.ordinal).slice(0, safeLimit);
  }

  knowledgeChunksForMessage(messageId: string, limit = 4): KnowledgeChunkSearchResult[] {
    const rows = this.all(
      `SELECT k.*,m.note_title,m.summary,m.domains_json,m.knowledge_points_json
       FROM knowledge_chunks k JOIN messages m ON m.id=k.message_id
       WHERE k.message_id=? AND k.tenant_id=? AND m.tenant_id=? AND m.agent_status='completed'
       ORDER BY k.ordinal LIMIT ?`,
      messageId,
      this.requireOwnerId(),
      this.requireOwnerId(),
      Math.max(1, Math.min(12, Math.floor(limit) || 4)),
    );
    return rows.map((row) => ({
      messageId: rowString(row, "message_id"),
      ordinal: rowNumber(row, "ordinal"),
      title: rowString(row, "note_title"),
      summary: rowString(row, "summary"),
      heading: rowString(row, "heading"),
      content: rowString(row, "content"),
      domains: safeJson<string[]>(rowString(row, "domains_json"), []),
      knowledgePoints: safeJson<string[]>(rowString(row, "knowledge_points_json"), [])
        .map(compactKnowledgePoint)
        .filter(Boolean),
      score: 0,
    }));
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
      integrity: this.contentIntegrityFromRow(row),
    };
  }

  listMessageRevisions(messageId: string): ContentRevision[] {
    const current = this.getMessage(messageId);
    if (!current) return [];
    this.publishMessage(messageId);
    return this.all(
      `SELECT revision,snapshot_json,created_at FROM sync_events
       WHERE tenant_id=? AND message_id=? ORDER BY revision DESC`,
      this.requireOwnerId(),
      messageId,
    ).map((row) => this.mapContentRevision(row, current.revision));
  }

  getMessageRevision(messageId: string, revision: number): ContentRevisionDetail | undefined {
    const current = this.getMessage(messageId);
    if (!current) return undefined;
    this.publishMessage(messageId);
    const row = this.maybeOne(
      `SELECT revision,snapshot_json,created_at FROM sync_events
       WHERE tenant_id=? AND message_id=? AND revision=?`,
      this.requireOwnerId(),
      messageId,
      revision,
    );
    if (!row) return undefined;
    return {
      ...this.mapContentRevision(row, current.revision),
      snapshot: safeJson<Record<string, unknown>>(rowString(row, "snapshot_json"), {}),
    };
  }

  restoreMessageRevision(messageId: string, revision: number): MessageDetail | undefined {
    const current = this.getMessageDetail(messageId);
    const historical = this.getMessageRevision(messageId, revision);
    if (!current || !historical) return undefined;
    if (historical.current) return current;
    const snapshot = historical.snapshot;
    const processing = snapshot.processing && typeof snapshot.processing === "object"
      ? snapshot.processing as Record<string, unknown>
      : {};
    const stringList = (value: unknown, fallback: string[]) => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : fallback;
    const title = typeof snapshot.title === "string" && snapshot.title.trim() ? snapshot.title : current.title;
    const markdown = typeof snapshot.markdown === "string" && snapshot.markdown.trim() ? snapshot.markdown : current.markdown;
    const status = processing.status === "fallback" ? "fallback" : "completed";
    this.updateProcessedNote(messageId, {
      title,
      markdown,
      category: typeof snapshot.category === "string" ? snapshot.category : current.category,
      tags: stringList(snapshot.tags, current.tags),
      summary: typeof snapshot.summary === "string" ? snapshot.summary : current.summary,
      keyPoints: stringList(snapshot.keyPoints, current.keyPoints),
      knowledgePoints: stringList(snapshot.knowledgePoints, current.knowledgePoints),
      domains: stringList(snapshot.domains, current.domains),
      tools: stringList(snapshot.tools, current.tools),
      detailsMarkdown: typeof snapshot.detailsMarkdown === "string" ? snapshot.detailsMarkdown : current.detailsMarkdown,
      reason: current.reason,
      suggestedAction: current.suggestedAction,
      sensitivity: current.sensitivity,
      confidence: current.confidence,
      warnings: [
        ...current.warnings.filter((warning) => !warning.startsWith("已从历史版本")),
        `已从历史版本 ${revision} 恢复`,
      ],
    }, status);
    this.publishMessage(messageId);
    return this.getMessageDetail(messageId);
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

  listMessageAnnotations(messageId: string): MessageAnnotation[] {
    const tenantId = this.requireOwnerId();
    if (!this.maybeOne("SELECT id FROM messages WHERE id=? AND tenant_id=?", messageId, tenantId)) return [];
    return this.all(
      "SELECT * FROM message_annotations WHERE tenant_id=? AND message_id=? ORDER BY created_at DESC",
      tenantId,
      messageId,
    ).map((row) => ({
      id: rowString(row, "id"),
      messageId: rowString(row, "message_id"),
      quote: rowString(row, "quote"),
      note: rowString(row, "note"),
      color: (["mint", "amber", "blue", "rose"].includes(rowString(row, "color"))
        ? rowString(row, "color")
        : "mint") as MessageAnnotation["color"],
      createdAt: rowString(row, "created_at"),
      updatedAt: rowString(row, "updated_at"),
    }));
  }

  createMessageAnnotation(
    messageId: string,
    input: { quote?: string; note?: string; color?: MessageAnnotation["color"] },
  ): MessageAnnotation {
    const tenantId = this.requireOwnerId();
    if (!this.getMessage(messageId)) throw new Error("消息不存在");
    const quote = (input.quote || "").trim().slice(0, 2000);
    const note = (input.note || "").trim().slice(0, 5000);
    if (!quote && !note) throw new Error("请选择正文或填写笔记");
    const color = input.color && ["mint", "amber", "blue", "rose"].includes(input.color) ? input.color : "mint";
    const id = crypto.randomUUID();
    const timestamp = now();
    this.run(
      "INSERT INTO message_annotations(id,tenant_id,message_id,quote,note,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      id,
      tenantId,
      messageId,
      quote,
      note,
      color,
      timestamp,
      timestamp,
    );
    return this.listMessageAnnotations(messageId).find((item) => item.id === id)!;
  }

  updateMessageAnnotation(
    annotationId: string,
    input: { note?: string; color?: MessageAnnotation["color"] },
  ): MessageAnnotation | undefined {
    const tenantId = this.requireOwnerId();
    const row = this.maybeOne(
      "SELECT message_id,note,color FROM message_annotations WHERE id=? AND tenant_id=?",
      annotationId,
      tenantId,
    );
    if (!row) return undefined;
    const note = input.note === undefined ? rowString(row, "note") : input.note.trim().slice(0, 5000);
    const requestedColor = input.color || rowString(row, "color");
    const color = ["mint", "amber", "blue", "rose"].includes(requestedColor) ? requestedColor : "mint";
    this.run(
      "UPDATE message_annotations SET note=?,color=?,updated_at=? WHERE id=? AND tenant_id=?",
      note,
      color,
      now(),
      annotationId,
      tenantId,
    );
    return this.listMessageAnnotations(rowString(row, "message_id")).find((item) => item.id === annotationId);
  }

  deleteMessageAnnotation(annotationId: string): boolean {
    const result = this.run(
      "DELETE FROM message_annotations WHERE id=? AND tenant_id=?",
      annotationId,
      this.requireOwnerId(),
    );
    return result.changes > 0;
  }

  listSmartCollections(): SmartCollection[] {
    const rows = this.all(
      "SELECT * FROM smart_collections WHERE tenant_id=? ORDER BY pinned DESC,updated_at DESC",
      this.requireOwnerId(),
    );
    return rows.map((row) => {
      const rules = safeJson<SmartCollectionRules>(rowString(row, "rules_json"), {});
      const options: MessageListOptions = {
        organized: true,
        ...(rules.favorite ? { favorite: true } : {}),
        ...(rules.unread ? { unread: true } : {}),
        ...(rules.format ? { format: rules.format } : {}),
        ...(rules.domain ? { domain: rules.domain } : {}),
        ...(rules.knowledgePoint ? { knowledgePoint: rules.knowledgePoint } : {}),
        ...(rules.tool ? { tool: rules.tool } : {}),
        ...(rules.query ? { query: rules.query } : {}),
      };
      const itemCount = this.countMessages(options);
      return {
        id: rowString(row, "id"),
        name: rowString(row, "name"),
        description: rowString(row, "description"),
        rules,
        pinned: Boolean(rowNumber(row, "pinned")),
        itemCount,
        createdAt: rowString(row, "created_at"),
        updatedAt: rowString(row, "updated_at"),
      };
    });
  }

  createSmartCollection(input: {
    name: string;
    description?: string;
    rules?: SmartCollectionRules;
    pinned?: boolean;
  }): SmartCollection {
    const tenantId = this.requireOwnerId();
    const name = input.name.trim().slice(0, 60);
    if (!name) throw new Error("请输入集合名称");
    const id = crypto.randomUUID();
    const timestamp = now();
    this.run(
      "INSERT INTO smart_collections(id,tenant_id,name,description,rules_json,pinned,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      id,
      tenantId,
      name,
      (input.description || "").trim().slice(0, 240),
      JSON.stringify(input.rules || {}),
      input.pinned ? 1 : 0,
      timestamp,
      timestamp,
    );
    return this.listSmartCollections().find((item) => item.id === id)!;
  }

  updateSmartCollection(
    collectionId: string,
    input: Partial<Pick<SmartCollection, "name" | "description" | "rules" | "pinned">>,
  ): SmartCollection | undefined {
    const tenantId = this.requireOwnerId();
    const row = this.maybeOne("SELECT * FROM smart_collections WHERE id=? AND tenant_id=?", collectionId, tenantId);
    if (!row) return undefined;
    const name = input.name === undefined ? rowString(row, "name") : input.name.trim().slice(0, 60);
    if (!name) throw new Error("请输入集合名称");
    this.run(
      "UPDATE smart_collections SET name=?,description=?,rules_json=?,pinned=?,updated_at=? WHERE id=? AND tenant_id=?",
      name,
      input.description === undefined ? rowString(row, "description") : input.description.trim().slice(0, 240),
      JSON.stringify(input.rules === undefined ? safeJson(rowString(row, "rules_json"), {}) : input.rules),
      input.pinned === undefined ? rowNumber(row, "pinned") : input.pinned ? 1 : 0,
      now(),
      collectionId,
      tenantId,
    );
    return this.listSmartCollections().find((item) => item.id === collectionId);
  }

  deleteSmartCollection(collectionId: string): boolean {
    return this.run(
      "DELETE FROM smart_collections WHERE id=? AND tenant_id=?",
      collectionId,
      this.requireOwnerId(),
    ).changes > 0;
  }

  listReviewSuggestions(limit = 8): ReviewSuggestion[] {
    const tenantId = this.requireOwnerId();
    const rows = this.all(
      `SELECT m.*,(SELECT COUNT(*) FROM attachments a WHERE a.message_id=m.id) AS attachment_count,
       0 AS archived,r.action,r.snooze_until,r.updated_at AS review_updated_at
       FROM messages m LEFT JOIN message_reviews r ON r.tenant_id=m.tenant_id AND r.message_id=m.id
       WHERE m.tenant_id=? AND m.agent_status='completed' AND m.library_state<>'archived'
       AND COALESCE(r.action,'') NOT IN ('mastered','dismissed')
       AND (r.snooze_until IS NULL OR r.snooze_until<=?)
       ORDER BY m.seq DESC LIMIT 300`,
      tenantId,
      now(),
    );
    const today = Date.now();
    return rows.map((row) => {
      const item = this.mapMessage(row);
      const ageDays = Math.max(0, Math.floor((today - new Date(item.receivedAt).getTime()) / 86_400_000));
      const unread = !item.readAt;
      const lastReviewed = rowOptional(row, "review_updated_at");
      const sinceReview = lastReviewed
        ? Math.max(0, Math.floor((today - new Date(String(lastReviewed)).getTime()) / 86_400_000))
        : ageDays;
      const priority = (unread ? 30 : 0) + (item.favorite ? 24 : 0) + Math.min(ageDays, 45) + Math.min(sinceReview, 30);
      const reason = unread
        ? ageDays >= 7 ? `收藏 ${ageDays} 天后还没有读过` : "这篇内容还没有读过"
        : item.favorite ? "你曾标记为重点，适合再次回顾"
          : ageDays >= 30 ? `距离上次收藏已有 ${ageDays} 天` : "根据收藏时间为你重新唤醒";
      return { ...item, reason, priority };
    }).sort((left, right) => right.priority - left.priority || right.seq - left.seq).slice(0, Math.max(1, Math.min(limit, 30)));
  }

  setMessageReview(messageId: string, action: "reviewed" | "snoozed" | "mastered" | "dismissed", snoozeUntil?: string): void {
    const tenantId = this.requireOwnerId();
    if (!this.getMessage(messageId)) throw new Error("消息不存在");
    this.run(
      `INSERT INTO message_reviews(tenant_id,message_id,action,snooze_until,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(tenant_id,message_id) DO UPDATE SET action=excluded.action,snooze_until=excluded.snooze_until,updated_at=excluded.updated_at`,
      tenantId,
      messageId,
      action,
      snoozeUntil || null,
      now(),
    );
    if (action === "reviewed") this.updateResourceState(messageId, { read: true });
  }

  enqueueBackgroundJob(input: {
    type: BackgroundJobType;
    resourceId?: string;
    title?: string;
    message?: string;
    maxAttempts?: number;
    metadata?: Record<string, unknown>;
  }): BackgroundJob {
    const tenantId = this.requireOwnerId();
    const resourceId = (input.resourceId || "").slice(0, 240);
    if (resourceId) {
      const existing = this.maybeOne(
        `SELECT * FROM background_jobs WHERE tenant_id=? AND type=? AND resource_id=?
         AND status IN ('queued','running','retrying') ORDER BY created_at DESC LIMIT 1`,
        tenantId,
        input.type,
        resourceId,
      );
      if (existing) return this.mapBackgroundJob(existing);
    }
    const id = crypto.randomUUID();
    const timestamp = now();
    this.run(
      `INSERT INTO background_jobs(
        id,tenant_id,type,resource_id,title,status,phase,progress,message,attempts,max_attempts,
        metadata_json,created_at,updated_at
       ) VALUES(?,?,?,?,?,'queued','queued',0,?,0,?,?,?,?)`,
      id,
      tenantId,
      input.type,
      resourceId,
      (input.title || "后台任务").trim().slice(0, 160),
      (input.message || "任务已进入队列").trim().slice(0, 500),
      Math.max(1, Math.min(10, Math.floor(input.maxAttempts || 3))),
      JSON.stringify(input.metadata || {}),
      timestamp,
      timestamp,
    );
    return this.getBackgroundJob(id)!;
  }

  getBackgroundJob(jobId: string): BackgroundJob | undefined {
    const row = this.maybeOne(
      "SELECT * FROM background_jobs WHERE id=? AND tenant_id=?",
      jobId,
      this.requireOwnerId(),
    );
    return row ? this.mapBackgroundJob(row) : undefined;
  }

  activeBackgroundJob(type: BackgroundJobType, resourceId: string): BackgroundJob | undefined {
    const row = this.maybeOne(
      `SELECT * FROM background_jobs WHERE tenant_id=? AND type=? AND resource_id=?
       AND status IN ('queued','running','retrying') ORDER BY created_at DESC LIMIT 1`,
      this.requireOwnerId(),
      type,
      resourceId,
    );
    return row ? this.mapBackgroundJob(row) : undefined;
  }

  latestBackgroundJob(type: BackgroundJobType, resourceId: string): BackgroundJob | undefined {
    const row = this.maybeOne(
      `SELECT * FROM background_jobs WHERE tenant_id=? AND type=? AND resource_id=?
       ORDER BY created_at DESC LIMIT 1`,
      this.requireOwnerId(),
      type,
      resourceId,
    );
    return row ? this.mapBackgroundJob(row) : undefined;
  }

  startBackgroundJob(jobId: string, phase = "starting", message = "正在开始处理"): BackgroundJob | undefined {
    const tenantId = this.requireOwnerId();
    this.run(
      `UPDATE background_jobs SET status='running',phase=?,progress=MAX(progress,5),message=?,
       attempts=attempts+1,started_at=COALESCE(started_at,?),updated_at=?,error=NULL
       WHERE id=? AND tenant_id=? AND status IN ('queued','retrying','running')`,
      phase.slice(0, 80),
      message.slice(0, 500),
      now(),
      now(),
      jobId,
      tenantId,
    );
    return this.getBackgroundJob(jobId);
  }

  updateBackgroundJob(
    jobId: string,
    input: {
      status?: Extract<BackgroundJobStatus, "running" | "retrying">;
      phase?: string;
      progress?: number;
      message?: string;
      error?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): BackgroundJob | undefined {
    const current = this.getBackgroundJob(jobId);
    if (!current || ["completed", "failed", "cancelled"].includes(current.status)) return current;
    const metadata = input.metadata ? { ...current.metadata, ...input.metadata } : current.metadata;
    this.run(
      `UPDATE background_jobs SET status=?,phase=?,progress=?,message=?,error=?,metadata_json=?,updated_at=?
       WHERE id=? AND tenant_id=?`,
      input.status || current.status,
      (input.phase ?? current.phase).slice(0, 80),
      Math.max(0, Math.min(99, Math.floor(input.progress ?? current.progress))),
      (input.message ?? current.message).slice(0, 500),
      input.error === undefined ? current.error || null : input.error?.slice(0, 1000) || null,
      JSON.stringify(metadata),
      now(),
      jobId,
      this.requireOwnerId(),
    );
    return this.getBackgroundJob(jobId);
  }

  finishBackgroundJob(
    jobId: string,
    input: { message?: string; metadata?: Record<string, unknown> } = {},
  ): BackgroundJob | undefined {
    const current = this.getBackgroundJob(jobId);
    if (!current) return undefined;
    const timestamp = now();
    this.run(
      `UPDATE background_jobs SET status='completed',phase='completed',progress=100,message=?,error=NULL,
       metadata_json=?,updated_at=?,completed_at=? WHERE id=? AND tenant_id=?`,
      (input.message || "任务已完成").slice(0, 500),
      JSON.stringify({ ...current.metadata, ...(input.metadata || {}) }),
      timestamp,
      timestamp,
      jobId,
      this.requireOwnerId(),
    );
    return this.getBackgroundJob(jobId);
  }

  failBackgroundJob(jobId: string, error: string, message = "任务处理失败"): BackgroundJob | undefined {
    const timestamp = now();
    this.run(
      `UPDATE background_jobs SET status='failed',phase='failed',message=?,error=?,updated_at=?,completed_at=?
       WHERE id=? AND tenant_id=?`,
      message.slice(0, 500),
      error.slice(0, 1000),
      timestamp,
      timestamp,
      jobId,
      this.requireOwnerId(),
    );
    return this.getBackgroundJob(jobId);
  }

  cancelBackgroundJob(jobId: string): BackgroundJob | undefined {
    const timestamp = now();
    this.run(
      `UPDATE background_jobs SET status='cancelled',phase='cancelled',message='任务已取消',updated_at=?,completed_at=?
       WHERE id=? AND tenant_id=? AND status='queued'`,
      timestamp,
      timestamp,
      jobId,
      this.requireOwnerId(),
    );
    return this.getBackgroundJob(jobId);
  }

  listBackgroundJobs(options: {
    limit?: number;
    offset?: number;
    status?: BackgroundJobStatus;
    statuses?: BackgroundJobStatus[];
    type?: BackgroundJobType;
  } = {}): BackgroundJob[] {
    const where = ["tenant_id=?"];
    const values: SqlValue[] = [this.requireOwnerId()];
    const statuses = Array.from(new Set(options.statuses || [])).filter(Boolean);
    if (statuses.length) {
      where.push(`status IN (${statuses.map(() => "?").join(",")})`);
      values.push(...statuses);
    } else if (options.status) { where.push("status=?"); values.push(options.status); }
    if (options.type) { where.push("type=?"); values.push(options.type); }
    values.push(Math.max(1, Math.min(200, Math.floor(options.limit || 50))));
    values.push(Math.max(0, Math.floor(options.offset || 0)));
    return this.all(
      `SELECT * FROM background_jobs WHERE ${where.join(" AND ")}
       ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'retrying' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,
       updated_at DESC LIMIT ? OFFSET ?`,
      ...values,
    ).map((row) => this.mapBackgroundJob(row));
  }

  countBackgroundJobs(options: {
    status?: BackgroundJobStatus;
    statuses?: BackgroundJobStatus[];
    type?: BackgroundJobType;
  } = {}): number {
    const where = ["tenant_id=?"];
    const values: SqlValue[] = [this.requireOwnerId()];
    const statuses = Array.from(new Set(options.statuses || [])).filter(Boolean);
    if (statuses.length) {
      where.push(`status IN (${statuses.map(() => "?").join(",")})`);
      values.push(...statuses);
    } else if (options.status) { where.push("status=?"); values.push(options.status); }
    if (options.type) { where.push("type=?"); values.push(options.type); }
    return rowNumber(this.one(`SELECT COUNT(*) AS total FROM background_jobs WHERE ${where.join(" AND ")}`, ...values), "total");
  }

  backgroundJobOverview(limit = 30): BackgroundJobOverview {
    const tenantId = this.requireOwnerId();
    const stats = this.one(
      `SELECT
       SUM(CASE WHEN status IN ('queued','running','retrying') THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
       SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
       SUM(CASE WHEN status='retrying' THEN 1 ELSE 0 END) AS retrying,
       SUM(CASE WHEN status='failed' AND updated_at>=datetime('now','-7 day') THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status='completed' AND completed_at>=datetime('now','start of day') THEN 1 ELSE 0 END) AS completed_today
       FROM background_jobs WHERE tenant_id=?`,
      tenantId,
    );
    return {
      active: rowNumber(stats, "active"),
      queued: rowNumber(stats, "queued"),
      running: rowNumber(stats, "running"),
      retrying: rowNumber(stats, "retrying"),
      failed: rowNumber(stats, "failed"),
      completedToday: rowNumber(stats, "completed_today"),
      jobs: this.listBackgroundJobs({ limit }),
    };
  }

  searchIndexHealth(): SearchIndexHealth {
    const tenantId = this.requireOwnerId();
    const completedMessages = rowNumber(this.one(
      "SELECT COUNT(*) AS count FROM messages WHERE tenant_id=? AND agent_status='completed'",
      tenantId,
    ), "count");
    const indexedMessages = rowNumber(this.one(
      "SELECT COUNT(DISTINCT message_id) AS count FROM knowledge_chunks WHERE tenant_id=?",
      tenantId,
    ), "count");
    const indexedChunks = rowNumber(this.one(
      "SELECT COUNT(*) AS count FROM knowledge_chunks WHERE tenant_id=?",
      tenantId,
    ), "count");
    return {
      completedMessages,
      indexedMessages,
      indexedChunks,
      missingMessages: Math.max(0, completedMessages - indexedMessages),
      coverage: completedMessages ? Math.round(indexedMessages / completedMessages * 1000) / 10 : 100,
      engine: this.ftsEnabled ? "fts5" : "scan",
    };
  }

  rebuildTenantSearchIndex(onProgress?: (completed: number, total: number) => void): SearchIndexHealth {
    const tenantId = this.requireOwnerId();
    const messageIds = this.all("SELECT id FROM messages WHERE tenant_id=? ORDER BY seq", tenantId)
      .map((row) => rowString(row, "id"));
    this.transaction(() => {
      this.run("DELETE FROM message_search WHERE tenant_id=?", tenantId);
      this.run("DELETE FROM knowledge_chunks WHERE tenant_id=?", tenantId);
      if (this.ftsEnabled) {
        this.run("DELETE FROM message_search_fts WHERE tenant_id=?", tenantId);
        this.run("DELETE FROM knowledge_chunks_fts WHERE tenant_id=?", tenantId);
      }
      messageIds.forEach((messageId, index) => {
        this.upsertSearchIndex(messageId);
        onProgress?.(index + 1, messageIds.length);
      });
    });
    return this.searchIndexHealth();
  }

  qualityOverview(): QualityOverview {
    const rows = this.all(
      `SELECT m.*,(SELECT COUNT(*) FROM attachments a WHERE a.message_id=m.id) AS attachment_count,
       (SELECT COUNT(*) FROM attachments a WHERE a.message_id=m.id AND a.mime_type LIKE 'image/%') AS image_count,
       (SELECT COUNT(*) FROM knowledge_chunks k WHERE k.message_id=m.id) AS chunk_count,
       0 AS archived FROM messages m WHERE m.tenant_id=? ORDER BY m.seq DESC`,
      this.requireOwnerId(),
    );
    let processing = 0; let failed = 0; let fallback = 0; let missingSummary = 0;
    let missingCover = 0; let missingBody = 0; let brokenAssets = 0; let unindexed = 0; let warnings = 0;
    let duplicateMessages = 0; let duplicateReceipts = 0;
    const issues: QualityIssue[] = [];
    for (const row of rows) {
      const item = this.mapMessage(row);
      const integrity = this.contentIntegrityFromRow(row);
      const itemIssues: QualityIssue["issues"] = [];
      if (["pending", "queued", "processing"].includes(item.agentStatus)) processing += 1;
      if (item.agentStatus === "failed") { failed += 1; itemIssues.push("failed"); }
      if (item.agentStatus === "fallback") { fallback += 1; itemIssues.push("fallback"); }
      if (item.agentStatus === "completed" && !item.summary.trim()) { missingSummary += 1; itemIssues.push("missing_summary"); }
      if (item.agentStatus === "completed" && ["wechat_article", "web_article"].includes(item.contentFormat) && rowNumber(row, "image_count") === 0) {
        missingCover += 1; itemIssues.push("missing_cover");
      }
      if (integrity.issues.includes("missing_body")) { missingBody += 1; itemIssues.push("missing_body"); }
      if (integrity.issues.includes("broken_asset")) { brokenAssets += 1; itemIssues.push("broken_asset"); }
      if (item.agentStatus === "completed" && rowNumber(row, "chunk_count") === 0) { unindexed += 1; itemIssues.push("unindexed"); }
      if (safeJson<string[]>(rowString(row, "warnings_json"), []).length) { warnings += 1; itemIssues.push("warning"); }
      if (item.duplicateCount > 0) {
        duplicateMessages += 1;
        duplicateReceipts += item.duplicateCount;
      }
      if (itemIssues.length) issues.push({ ...item, issues: itemIssues });
    }
    const healthy = rows.filter((row) => rowString(row, "agent_status") === "completed"
      && !issues.some((item) => item.id === rowString(row, "id"))).length;
    return {
      total: rows.length,
      healthy,
      processing,
      failed,
      fallback,
      missingSummary,
      missingCover,
      missingBody,
      brokenAssets,
      duplicateMessages,
      duplicateReceipts,
      unindexed,
      warnings,
      issues: issues.slice(0, 100),
    };
  }

  exportPersonalData(): Record<string, unknown> {
    const tenantId = this.requireOwnerId();
    const ownerRow = this.maybeOne("SELECT * FROM users WHERE id=?", tenantId);
    const owner = ownerRow ? mapOwner(ownerRow) : undefined;
    return {
      format: "knowledge-relay-personal-export",
      version: 1,
      exportedAt: now(),
      owner: owner ? { username: owner.username, displayName: owner.displayName } : undefined,
      messages: this.all("SELECT * FROM messages WHERE tenant_id=? ORDER BY seq", tenantId),
      annotations: this.all("SELECT * FROM message_annotations WHERE tenant_id=? ORDER BY created_at", tenantId),
      collections: this.all("SELECT * FROM smart_collections WHERE tenant_id=? ORDER BY created_at", tenantId),
      conversations: this.all("SELECT * FROM knowledge_conversations WHERE tenant_id=? ORDER BY created_at", tenantId),
      chatMessages: this.all("SELECT * FROM knowledge_chat_messages WHERE tenant_id=? ORDER BY created_at", tenantId),
      note: "附件二进制文件需配合服务器完整备份恢复。",
    };
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
    if (this.ftsEnabled) {
      this.run("DELETE FROM message_search_fts WHERE message_id=?", messageId);
      this.run("DELETE FROM knowledge_chunks_fts WHERE message_id=?", messageId);
    }
    this.run("DELETE FROM message_search WHERE message_id=?", messageId);
    this.run("DELETE FROM background_jobs WHERE tenant_id=? AND resource_id=?", ownerId, messageId);
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

  private mapFeedSource(row: SqlRow): FeedSource {
    return {
      id: rowString(row, "id"),
      tenantId: rowString(row, "tenant_id"),
      name: rowString(row, "name"),
      feedUrl: rowString(row, "feed_url"),
      enabled: Boolean(rowNumber(row, "enabled")),
      intervalMinutes: Math.max(15, rowNumber(row, "interval_minutes") || 60),
      lastCheckedAt: rowOptional(row, "last_checked_at"),
      lastSuccessAt: rowOptional(row, "last_success_at"),
      lastItemAt: rowOptional(row, "last_item_at"),
      lastError: rowOptional(row, "last_error"),
      nextCheckAt: rowString(row, "next_check_at"),
      createdAt: rowString(row, "created_at"),
      updatedAt: rowString(row, "updated_at"),
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
      duplicateCount: rowNumber(row, "duplicate_count"),
      lastDuplicateAt: rowOptional(row, "last_duplicate_at"),
    };
  }

  private mapContentRevision(row: SqlRow, currentRevision: number): ContentRevision {
    const snapshot = safeJson<Record<string, unknown>>(rowString(row, "snapshot_json"), {});
    const processing = snapshot.processing && typeof snapshot.processing === "object"
      ? snapshot.processing as Record<string, unknown>
      : {};
    return {
      revision: rowNumber(row, "revision"),
      createdAt: rowString(row, "created_at"),
      title: typeof snapshot.title === "string" ? snapshot.title : "未命名版本",
      summary: typeof snapshot.summary === "string" ? snapshot.summary : "",
      status: typeof processing.status === "string" ? processing.status : "unknown",
      current: rowNumber(row, "revision") === currentRevision,
    };
  }

  private contentIntegrityFromRow(row: SqlRow): ContentIntegrity {
    const markdown = rowString(row, "note_markdown");
    const content = stripNoteEnvelope(markdown);
    const bodyCharacters = content
      .replace(/```[\s\S]*?```/g, " code ")
      .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
      .replace(/[\[\]#>*_`|~-]/g, " ")
      .replace(/\s+/g, " ")
      .trim().length;
    const imageMatches = [...content.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
      .map((match) => match[1] || "")
      .filter(Boolean);
    const attachments = this.all(
      "SELECT id,file_name,mime_type,sha256 FROM attachments WHERE message_id=?",
      rowString(row, "id"),
    );
    const attachmentIds = new Set(attachments.map((item) => rowString(item, "id")));
    const imageHashes = new Set(attachments
      .filter((item) => rowString(item, "mime_type").startsWith("image/"))
      .map((item) => rowString(item, "sha256").toLowerCase()));
    const imageNames = new Set(attachments
      .filter((item) => rowString(item, "mime_type").startsWith("image/"))
      .map((item) => rowString(item, "file_name")));
    const missingImageReferences = imageMatches.filter((reference) => {
      if (/^(https?:|data:|blob:)/i.test(reference)) return false;
      const attachmentId = reference.match(/\/api\/attachments\/([^/?#]+)/)?.[1];
      if (attachmentId) return !attachmentIds.has(attachmentId);
      const hash = reference.match(/^attachment:\/\/([a-f0-9]{64})/i)?.[1];
      if (hash) return !imageHashes.has(hash.toLowerCase());
      let decoded = reference;
      try { decoded = decodeURIComponent(reference); } catch { /* retain malformed reference */ }
      const name = decoded.split(/[\\/]/).at(-1)?.split(/[?#]/)[0] || "";
      return Boolean(name) && !imageNames.has(name);
    });
    const completed = rowString(row, "agent_status") === "completed";
    const format = contentFormatFromRow(row);
    const issues: ContentIntegrity["issues"] = [];
    if (completed && ["wechat_article", "web_article", "document"].includes(format) && bodyCharacters < 120) issues.push("missing_body");
    if (missingImageReferences.length) issues.push("broken_asset");
    if (completed && !rowString(row, "summary").trim()) issues.push("missing_summary");
    if (completed && ["wechat_article", "web_article"].includes(format) && !imageHashes.size) issues.push("missing_cover");
    if (completed && !this.maybeOne("SELECT 1 AS ok FROM knowledge_chunks WHERE message_id=? LIMIT 1", rowString(row, "id"))) issues.push("unindexed");
    return {
      score: Math.max(0, 100 - issues.length * 20),
      bodyCharacters,
      imageReferences: imageMatches.length,
      localImages: imageHashes.size,
      missingImageReferences: [...new Set(missingImageReferences)].slice(0, 20),
      issues,
    };
  }

  private mapBackgroundJob(row: SqlRow): BackgroundJob {
    const allowedTypes = new Set<BackgroundJobType>([
      "ingestion", "reprocess", "diagram", "index", "sync", "source_check",
    ]);
    const allowedStatuses = new Set<BackgroundJobStatus>([
      "queued", "running", "retrying", "completed", "failed", "cancelled",
    ]);
    const type = rowString(row, "type") as BackgroundJobType;
    const status = rowString(row, "status") as BackgroundJobStatus;
    return {
      id: rowString(row, "id"),
      type: allowedTypes.has(type) ? type : "ingestion",
      resourceId: rowString(row, "resource_id"),
      title: rowString(row, "title"),
      status: allowedStatuses.has(status) ? status : "failed",
      phase: rowString(row, "phase"),
      progress: Math.max(0, Math.min(100, rowNumber(row, "progress"))),
      message: rowString(row, "message"),
      attempts: rowNumber(row, "attempts"),
      maxAttempts: rowNumber(row, "max_attempts"),
      error: rowOptional(row, "error"),
      metadata: safeJson<Record<string, unknown>>(rowString(row, "metadata_json"), {}),
      createdAt: rowString(row, "created_at"),
      startedAt: rowOptional(row, "started_at"),
      updatedAt: rowString(row, "updated_at"),
      completedAt: rowOptional(row, "completed_at"),
    };
  }

  private knowledgeConversationScopeType(value: string): KnowledgeConversation["scopeType"] {
    return ["message", "domain", "collection"].includes(value)
      ? value as KnowledgeConversation["scopeType"]
      : "library";
  }

  private upsertSearchIndex(messageId: string): void {
    const row = this.maybeOne("SELECT * FROM messages WHERE id=?", messageId);
    if (!row) return;
    const indexedFields = [
      rowString(row, "note_title"),
      rowString(row, "summary"),
      `${rowString(row, "text")}\n${rowString(row, "note_markdown")}`,
      safeJson<string[]>(rowString(row, "tags_json"), []).join(" "),
      safeJson<string[]>(rowString(row, "domains_json"), []).join(" "),
      safeJson<string[]>(rowString(row, "knowledge_points_json"), []).join(" "),
      safeJson<string[]>(rowString(row, "tools_json"), []).join(" "),
    ].map(indexedSearchText);
    const allText = indexedSearchText([
      rowString(row, "note_title"), rowString(row, "summary"), rowString(row, "text"),
      rowString(row, "note_markdown"), rowString(row, "tags_json"), rowString(row, "domains_json"),
      rowString(row, "knowledge_points_json"), rowString(row, "tools_json"),
    ].join("\n"));
    this.run(
      `INSERT INTO message_search(message_id,tenant_id,title,summary,body,tags,domains,knowledge_points,tools,all_text)
       VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET
       tenant_id=excluded.tenant_id,title=excluded.title,summary=excluded.summary,body=excluded.body,
       tags=excluded.tags,domains=excluded.domains,knowledge_points=excluded.knowledge_points,
       tools=excluded.tools,all_text=excluded.all_text`,
      messageId,
      rowString(row, "tenant_id"),
      ...indexedFields,
      allText,
    );
    if (this.ftsEnabled) {
      this.run("DELETE FROM message_search_fts WHERE message_id=?", messageId);
      this.run(
        `INSERT INTO message_search_fts(message_id,tenant_id,title,summary,body,metadata,all_text)
         VALUES(?,?,?,?,?,?,?)`,
        messageId,
        rowString(row, "tenant_id"),
        indexedFields[0]!,
        indexedFields[1]!,
        indexedFields[2]!,
        indexedSearchText(indexedFields.slice(3).join(" ")),
        allText,
      );
    }
    this.run("DELETE FROM knowledge_chunks WHERE message_id=?", messageId);
    if (this.ftsEnabled) this.run("DELETE FROM knowledge_chunks_fts WHERE message_id=?", messageId);
    if (rowString(row, "agent_status") !== "completed") return;
    const title = rowString(row, "note_title");
    const summary = rowString(row, "summary");
    const keyPoints = safeJson<string[]>(rowString(row, "key_points_json"), []);
    const chunks = knowledgeContentChunks(
      title,
      summary,
      keyPoints,
      rowString(row, "note_markdown"),
      rowString(row, "details_markdown"),
    );
    chunks.forEach((chunk, ordinal) => {
      const indexed = indexedSearchText(`${title}\n${chunk.heading}\n${chunk.content}`);
      this.run(
        `INSERT INTO knowledge_chunks(id,message_id,tenant_id,ordinal,heading,content,indexed_text)
         VALUES(?,?,?,?,?,?,?)`,
        `${messageId}:${ordinal}`,
        messageId,
        rowString(row, "tenant_id"),
        ordinal,
        chunk.heading,
        chunk.content,
        indexed,
      );
      if (this.ftsEnabled) {
        this.run(
          `INSERT INTO knowledge_chunks_fts(message_id,tenant_id,ordinal,heading,content,indexed_text)
           VALUES(?,?,?,?,?,?)`,
          messageId,
          rowString(row, "tenant_id"),
          ordinal,
          indexedSearchText(chunk.heading),
          indexedSearchText(chunk.content),
          indexed,
        );
      }
    });
  }

  private rebuildSearchIndexIfNeeded(): void {
    const version = `5:${this.ftsEnabled ? "fts5" : "scan"}`;
    const current = this.maybeOne("SELECT value FROM metadata WHERE key='message_search_version'");
    if (current && rowString(current, "value") === version) return;
    this.transaction(() => {
      this.run("DELETE FROM message_search");
      this.run("DELETE FROM knowledge_chunks");
      if (this.ftsEnabled) {
        this.run("DELETE FROM message_search_fts");
        this.run("DELETE FROM knowledge_chunks_fts");
      }
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

  private prepare(sql: string): Database.Statement {
    return this.database.prepare(sql);
  }

  private run(sql: string, ...parameters: SqlValue[]): Database.RunResult {
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

function normalizeFeedUrl(value: string): string {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("订阅地址只支持 HTTP 或 HTTPS");
  if (url.username || url.password) throw new Error("订阅地址不能包含账号凭据");
  if (url.port && !((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443"))) {
    throw new Error("订阅地址端口不受支持");
  }
  if (!url.hostname || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw new Error("订阅地址不可访问");
  }
  url.hash = "";
  return url.toString();
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
