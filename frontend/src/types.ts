export type Owner = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "member";
  createdAt: string;
  disabled: boolean;
};

export type Invitation = {
  id: string;
  expiresAt: string;
  createdAt: string;
  consumed: boolean;
  revoked: boolean;
  consumedBy?: {
    username: string;
    displayName: string;
  };
};

export type CreatedInvitation = {
  id: string;
  token: string;
  expiresAt: string;
};

export type FeedSource = {
  id: string;
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
  messages?: KnowledgeChatMessage[];
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

export type MessageItem = {
  seq: number;
  id: string;
  receivedAt: string;
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

export type Attachment = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  kind: string;
  transcript?: string;
  previewable: boolean;
};

export type MessageDetail = MessageItem & {
  contentMarkdown: string;
  detailsMarkdown: string;
  reason: string;
  suggestedAction: string;
  sensitivity: string;
  confidence: string;
  warnings: string[];
  source: { type: string; name: string; url: string };
  captureType: string;
  integrity: {
    score: number;
    bodyCharacters: number;
    imageReferences: number;
    localImages: number;
    missingImageReferences: string[];
    issues: Array<"missing_body" | "broken_asset" | "missing_summary" | "missing_cover" | "unindexed">;
  };
  attachments: Attachment[];
};

export type ContentRevision = {
  revision: number;
  createdAt: string;
  title: string;
  summary: string;
  status: string;
  current: boolean;
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

export type SmartCollectionRules = {
  favorite?: boolean;
  unread?: boolean;
  format?: ContentFormat;
  domain?: string;
  knowledgePoint?: string;
  tool?: string;
  query?: string;
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

export type ReviewSuggestion = MessageItem & {
  reason: string;
  priority: number;
};

export type QualityIssue = MessageItem & {
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

export type BackgroundJobResponse = {
  overview: BackgroundJobOverview;
  jobs: BackgroundJob[];
  searchIndex: SearchIndexHealth;
};

export type Dashboard = {
  messages: number;
  pending: number;
  queued: number;
  activeProcessing: number;
  organized: number;
  fallback: number;
  pendingSync: number;
  diagramProcessing: number;
  diagramJobs: Array<{
    messageId: string;
    title: string;
    phase: "analyzing" | "saving";
    message: string;
    startedAt: string;
    updatedAt: string;
  }>;
  jobs: BackgroundJobOverview;
  searchIndex: SearchIndexHealth;
  agentEnabled: boolean;
  accounts: BotAccount[];
  wechatAssistant: {
    available: boolean;
    bound: boolean;
    displayName?: string;
    lastMessageAt?: string;
    error?: string;
  };
  syncTargets: SyncTarget[];
  [key: string]: unknown;
};

export type BotAccount = {
  id: string;
  botId: string;
  ownerUserId: string;
  connectedAt: string;
  state: string;
  lastPollAt?: string;
  lastMessageAt?: string;
  lastError?: string;
};

export type Facet = { name: string; count: number };
export type KnowledgeFacets = {
  total: number;
  enriched: number;
  facetTotals: { categories: number; domains: number; knowledgePoints: number; tools: number };
  categories: Facet[];
  domains: Facet[];
  knowledgePoints: Facet[];
  tools: Facet[];
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
export type KnowledgeMapEdge = { source: string; target: string; label?: string; kind?: string };
export type KnowledgeMap = {
  scope: "library" | "resource";
  diagramType: string;
  diagramLabel: string;
  selectionReason: string;
  generatedAt: string;
  truncated: boolean;
  nodes: KnowledgeMapNode[];
  edges: KnowledgeMapEdge[];
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
  token?: string;
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

export type ApiToken = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  revoked: boolean;
  token?: string;
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

export type WechatMcpBinding = {
  id: string;
  tenantId?: string;
  username?: string;
  userDisplayName?: string;
  account?: string;
  wechatDisplayName: string;
  boundAt: string;
  lastMessageAt?: string;
};

export type WechatMcpUserBindingStatus = {
  tenantId: string;
  username: string;
  userDisplayName: string;
  role: "admin" | "member";
  disabled: boolean;
  binding?: WechatMcpBinding;
};

export type WechatMcpUserState = {
  available: boolean;
  source?: Pick<WechatMcpSource, "displayName" | "qrConfigured" | "lastPollAt" | "lastError">;
  binding?: WechatMcpBinding;
};

export type WechatMcpAdminState = {
  source?: WechatMcpSource;
  bindings: WechatMcpBinding[];
  users: WechatMcpUserBindingStatus[];
};

export type WechatMcpCheck = {
  ok: boolean;
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  toolCount: number;
  accountCount: number;
  accounts: string[];
};

export type AgentSettings = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  instructions: string;
  autoReply: boolean;
  notifyOnFailure: boolean;
};

export type ProviderDefinition = {
  id: string;
  name: string;
  defaultModel: string;
  defaultBaseUrl: string;
  auth: "api_key" | "optional_key" | "oauth" | "local";
};

export type ProviderSettings = {
  active: { provider: string; model: string; apiBase: string; apiKeyConfigured: boolean; auth: "api_key" | "optional_key" | "oauth" | "local" };
  providers: ProviderDefinition[];
  autoReload?: boolean;
  oauthSupported?: boolean;
};

export type ProviderModelOption = {
  id: string;
  label?: string;
  description?: string;
  ownedBy?: string;
  contextWindow?: number;
};

export type ProviderModelCatalog = {
  provider: string;
  status: "available" | "not_configured" | "unsupported" | "missing_api_base" | "error";
  models: ProviderModelOption[];
  modelCount: number;
  message?: string;
  fetchedAt: number;
};

export type ModelConnectionResult = {
  ok: boolean;
  stage: "runtime" | "model" | "complete";
  elapsedMs: number;
  runtimeMs?: number;
  modelMs?: number;
  provider: string;
  model: string;
  error?: string;
};

export type PluginRelease = {
  available: boolean;
  downloadUrl?: string;
  version?: string;
  minAppVersion?: string;
  size?: number;
  sha256?: string;
  publishedAt?: string;
  source?: "uploaded" | "bundled";
};
