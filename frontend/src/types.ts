export type Owner = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "member";
  createdAt: string;
  disabled: boolean;
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
  attachments: Attachment[];
};

export type Dashboard = {
  messages: number;
  pending: number;
  queued: number;
  activeProcessing: number;
  organized: number;
  fallback: number;
  pendingSync: number;
  agentEnabled: boolean;
  accounts: BotAccount[];
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
