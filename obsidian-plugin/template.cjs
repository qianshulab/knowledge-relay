const MANAGED_START = "<!-- knowledge-relay:managed:start -->";
const MANAGED_END = "<!-- knowledge-relay:managed:end -->";

function formatLocalDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "").slice(0, 10);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLocalTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join("");
}

function yamlString(value) {
  return JSON.stringify(String(value == null ? "" : value).replace(/[\r\n]+/g, " "));
}

function stripFrontmatter(markdown) {
  return String(markdown || "").replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");
}

function extractOriginalContent(markdown) {
  const lines = stripFrontmatter(markdown).split(/\r?\n/);
  while (!lines[0] || /^#\s+/.test(lines[0])) lines.shift();
  const attachmentHeading = lines.findIndex((line) => /^##\s+附件\s*$/.test(line.trim()));
  const content = (attachmentHeading >= 0 ? lines.slice(0, attachmentHeading) : lines)
    .join("\n")
    .trim();
  return content || "（这条消息仅包含附件）";
}

function summarize(content, title) {
  const lines = String(content || "")
    .split(/\r?\n/)
    .map((item) => item.replace(/^\s*(?:>|[-*+]\s+|#+\s*)/, "").trim())
    .filter((item) => item && !/^\[!/.test(item));
  const line = lines.find((item) => !/^https?:\/\/\S+$/i.test(item)) || lines[0];
  return (line || title || "微信收件").replace(/\s+/g, " ").slice(0, 500);
}

function firstUrl(content) {
  return String(content || "").match(/https?:\/\/[^\s)>\]]+/i)?.[0] || "";
}

function sanitizeMarkdown(value, maximumLength = 220000) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/<(script|style|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|svg|math)\b[^>]*\/?>/gi, "")
    .replace(/<\/?a\b[^>]*>/gi, "")
    .replace(/<(?:img|audio|video|source|track|link|meta|form|input|button)\b[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\]\(\s*(?:javascript|data\s*:\s*text\/html|file|obsidian)\s*:/gi, "](已移除不安全链接:")
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/gi, "[外部图片：$1]($2)")
    .replace(/!\[\[([^\]]+)\]\]/g, "[已移除外部嵌入：$1]")
    .replace(/\u0000/g, "")
    .slice(0, maximumLength)
    .trim();
}

function sourceTypeLabel(value) {
  return ({ web: "网页", rss: "RSS", api: "API", email: "邮件", manual: "手工录入", cti: "威胁情报", paper: "论文" }[value] || "其他");
}

function actionLabel(value) {
  return ({ none: "暂无建议", knowledge: "知识卡片", research: "研究课题", project: "项目", resource: "学习资源", practice: "安全实践", delete: "建议删除" }[value] || "暂无建议");
}

function processingLabel(value) {
  return ({ pending: "待处理", enriched: "已增强", fallback: "已降级", failed: "处理失败", completed: "已增强" }[value] || "待处理");
}

function confidenceLabel(value) {
  return ({ high: "高", medium: "中", low: "低" }[value] || "低");
}

function sensitivityLabel(value) {
  return ({ public: "公开", internal: "内部", confidential: "机密", restricted: "严格受限" }[value] || "内部");
}

function normalizeItem(item) {
  const id = String(item.id || item.messageId || "");
  const markdown = sanitizeMarkdown(item.contentMarkdown || extractOriginalContent(item.markdown));
  const sourceUrl = String(item.source && item.source.url || firstUrl(markdown));
  return {
    id,
    version: String(item.version || item.revision || "1"),
    revision: Number(item.revision || 1),
    title: String(item.title || "微信收件").replace(/[\r\n]+/g, " ").trim().slice(0, 120),
    createdAt: item.createdAt || item.receivedAt,
    updatedAt: item.updatedAt || item.receivedAt || item.createdAt,
    summary: String(item.summary || summarize(markdown, item.title)).replace(/[\r\n]+/g, " ").slice(0, 500),
    contentMarkdown: markdown.slice(0, 220000),
    reason: String(item.reason || "").replace(/[\r\n]+/g, " ").slice(0, 300),
    suggestedAction: String(item.suggestedAction || "none"),
    source: {
      type: String(item.source && item.source.type || (sourceUrl ? "web" : "manual")),
      name: String(item.source && item.source.name || (sourceUrl ? "网页来源" : "微信 iLink")).replace(/[\r\n]+/g, " ").slice(0, 200),
      url: sourceUrl,
    },
    tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string").slice(0, 10) : [],
    sensitivity: String(item.sensitivity || "internal"),
    deleted: item.deleted === true,
    processing: item.processing && typeof item.processing === "object" ? item.processing : {
      status: item.agentStatus || "fallback",
      confidence: "low",
      warnings: [],
    },
    attachments: Array.isArray(item.attachments)
      ? item.attachments.filter((attachment) => attachment && typeof attachment === "object").map((attachment) => ({
          id: String(attachment.id || "").slice(0, 500),
          fileName: String(attachment.fileName || "附件").replace(/[\r\n|]+/g, " ").slice(0, 200),
          mimeType: String(attachment.mimeType || "application/octet-stream").replace(/[\r\n]+/g, "").slice(0, 100),
          size: Number(attachment.size || 0),
          sha256: String(attachment.sha256 || "").toLowerCase(),
        })).slice(0, 50)
      : [],
  };
}

function buildManagedBlock(item, attachmentLinks = []) {
  const value = normalizeItem(item);
  const sourceLines = [
    `- **来源：** ${value.source.name || "微信 iLink"}`,
    `- **来源类型：** ${sourceTypeLabel(value.source.type)}`,
    ...(value.source.url ? [`- **原始链接：** ${value.source.url}`] : []),
  ];
  const warnings = Array.isArray(value.processing.warnings)
    ? value.processing.warnings.filter((warning) => typeof warning === "string").slice(0, 10)
    : [];
  return [
    MANAGED_START,
    "",
    "> [!todo] 知流同步捕获",
    "> 请判断这条内容是否值得进一步提炼；知流只更新本托管区块。",
    "",
    "## 一句话说明",
    "",
    value.summary || "（尚未生成摘要）",
    "",
    "## 原始内容 / 链接",
    "",
    ...sourceLines,
    "",
    "### 同步内容",
    "",
    value.contentMarkdown || "（这条消息仅包含附件）",
    ...(attachmentLinks.length ? ["", "### 同步附件", "", ...attachmentLinks] : []),
    "",
    "## 为什么值得保留",
    "",
    value.reason || "（等待你判断）",
    "",
    "> [!info] AI 整理建议",
    `> 建议方向：${actionLabel(value.suggestedAction)}`,
    `> 处理状态：${processingLabel(value.processing.status)}`,
    `> 置信度：${confidenceLabel(value.processing.confidence)}`,
    "> 此建议仅供参考，不会自动移动或处理笔记。",
    ...(warnings.length ? ["", "> [!warning] 数据质量提醒", ...warnings.map((warning) => `> ${String(warning).replace(/[\r\n]+/g, " ")}`)] : []),
    "",
    MANAGED_END,
  ].join("\n");
}

function removeManagedTemplateSections(template) {
  const headings = ["一句话说明", "原始内容 / 链接", "为什么值得保留", "同步附件"];
  let result = String(template || "");
  for (const heading of headings) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`^##\\s+${escaped}[ \\t]*\\r?\\n[\\s\\S]*?(?=^##\\s+|\\s*$)`, "m"), "");
  }
  return result;
}

function upsertFrontmatter(markdown, fields, createFields) {
  const source = String(markdown || "");
  if (!/^---\s*\r?\n/.test(source)) {
    const lines = Object.entries({ ...createFields, ...fields }).map(([key, value]) => `${key}: ${value}`);
    return `---\n${lines.join("\n")}\n---\n\n${source}`;
  }
  const end = source.indexOf("\n---", 4);
  if (end < 0) return source;
  let header = source.slice(4, end);
  for (const [key, value] of Object.entries(fields)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escaped}:.*$`, "m");
    header = pattern.test(header) ? header.replace(pattern, `${key}: ${value}`) : `${header.trimEnd()}\n${key}: ${value}`;
  }
  for (const [key, value] of Object.entries(createFields || {})) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`^${escaped}:`, "m").test(header)) header = `${header.trimEnd()}\n${key}: ${value}`;
  }
  return `---\n${header.trim()}\n${source.slice(end)}`;
}

function syncMetadata(item, initial) {
  const value = normalizeItem(item);
  const update = {
    更新日期: formatLocalDate(value.updatedAt),
    远程版本: yamlString(value.version),
    同步状态: "已同步",
    Agent处理状态: processingLabel(value.processing.status),
    知流修订: String(value.revision),
  };
  const create = initial ? {
    远程ID: yamlString(value.id),
    知流消息ID: yamlString(value.id),
    创建日期: formatLocalDate(value.createdAt),
    敏感级别: sensitivityLabel(value.sensitivity),
  } : {};
  return { update, create };
}

function applyCaptureTemplate(template, item, attachmentLinks = []) {
  const value = normalizeItem(item);
  const values = {
    date: formatLocalDate(value.createdAt),
    time: formatLocalTime(value.createdAt),
    datetime: `${formatLocalDate(value.createdAt)} ${formatLocalTime(value.createdAt)}`.trim(),
    title: value.title,
    message_id: value.id,
    revision: String(value.revision),
    source: value.source.url || value.source.name,
  };
  let result = removeManagedTemplateSections(template).replace(
    /{{\s*(date|time|datetime|title|message_id|revision|source)\s*}}/gi,
    (_match, key) => values[String(key).toLowerCase()] || "",
  );
  result = result.replace(/{{\s*(content|summary|attachments)\s*}}/gi, "");
  if (/^来源:\s*""\s*$/m.test(result)) result = result.replace(/^来源:\s*""\s*$/m, `来源: ${yamlString(value.source.name)}`);
  const block = buildManagedBlock(item, attachmentLinks);
  const nextHeading = result.match(/^##\s+下一步\s*$/m);
  result = nextHeading
    ? result.replace(/^##\s+下一步\s*$/m, `${block}\n\n## 下一步`)
    : `${result.trimEnd()}\n\n${block}\n\n## 下一步\n\n- [ ] 删除：没有持续价值\n- [ ] 转为知识卡片或研究课题\n\n## 临时备注\n`;
  const metadata = syncMetadata(item, true);
  return `${upsertFrontmatter(result, metadata.update, metadata.create).trimEnd()}\n`;
}

function updateManagedNote(existing, item, attachmentLinks = []) {
  const start = existing.indexOf(MANAGED_START);
  const end = existing.indexOf(MANAGED_END);
  if (start < 0 || end < start) return { updated: false, conflict: true, content: existing };
  const block = buildManagedBlock(item, attachmentLinks);
  const merged = existing.slice(0, start) + block + existing.slice(end + MANAGED_END.length);
  const metadata = syncMetadata(item, false);
  return { updated: true, conflict: false, content: `${upsertFrontmatter(merged, metadata.update, {}).trimEnd()}\n` };
}

function extractRemoteId(markdown) {
  const header = String(markdown || "").match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1] || "";
  const value = header.match(/^(?:远程ID|知流消息ID):\s*(.+)$/m)?.[1]?.trim() || "";
  if (!value) return "";
  try { return JSON.parse(value); } catch { return value.replace(/^['"]|['"]$/g, ""); }
}

module.exports = {
  MANAGED_START,
  MANAGED_END,
  applyCaptureTemplate,
  buildManagedBlock,
  extractOriginalContent,
  extractRemoteId,
  formatLocalDate,
  normalizeItem,
  sanitizeMarkdown,
  summarize,
  updateManagedNote,
};
