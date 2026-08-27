import type { CaptureInput } from "./capture.js";
import { normalizeLooseCodeBlocks } from "./markdown.js";
import type { PublicInboundMessage } from "./messages.js";
import { compactKnowledgePoint } from "./semantic-labels.js";
import type { ProcessedNote } from "./storage/database.js";

type NoteInput = CaptureInput | PublicInboundMessage;

function isCaptureInput(message: NoteInput): message is CaptureInput {
  return "source" in message && "captureType" in message;
}

function sourceMetadata(message: NoteInput): {
  sourceType: string;
  sourceName: string;
  sourceUrl?: string;
  actorId: string;
} {
  if (isCaptureInput(message)) {
    return {
      sourceType: message.source.type,
      sourceName: message.source.name,
      sourceUrl: message.source.url,
      actorId: message.actorId,
    };
  }
  return { sourceType: "wechat", sourceName: "微信 iLink", actorId: message.senderId };
}

function yaml(value: string): string {
  return JSON.stringify(value);
}

function cleanTitle(value: string): string {
  return value
    .replace(/^https?:\/\/\S+$/i, "网页收藏")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function firstUsefulLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || ""
  );
}

function cleanList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.normalize("NFKC").replace(/^#+/, "").replace(/[\r\n]+/g, " ").trim().slice(0, 80))
    .filter(Boolean)
    .filter((item, index, values) => values.indexOf(item) === index)
    .slice(0, limit);
}

function yamlList(name: string, values: string[]): string[] {
  return values.length ? [`${name}:`, ...values.map((value) => `  - ${yaml(value)}`)] : [`${name}: []`];
}

export function defaultNote(message: NoteInput): ProcessedNote {
  const firstLine = firstUsefulLine(message.text);
  const hasUrl = /https?:\/\/\S+/i.test(message.text);
  const hasFile = message.attachments.some((item) => item.kind === "file");
  const hasImage = message.attachments.some((item) => item.kind === "image");
  const hasVoice = message.attachments.some((item) => item.kind === "voice");
  const category = hasUrl
    ? "reference"
    : hasFile
      ? "document"
      : hasImage
        ? "image"
        : hasVoice
          ? "voice"
          : /^\s*(todo|待办|任务|提醒)[:：\s]/i.test(message.text)
            ? "task"
            : "inbox";
  const source = sourceMetadata(message);
  const title = cleanTitle(firstLine) || (message.attachments.length ? "收件附件" : "知识收件");
  const sourceTag = source.sourceType.startsWith("wechat") ? "微信收件" : `${source.sourceName}收件`;
  const tags = [sourceTag, category].filter((item, index, values) => values.indexOf(item) === index);
  const attachments = message.attachments.map((item) => ({
    fileName: item.fileName,
    kind: item.kind,
    transcript: item.transcript,
  }));
  const body = message.text.trim() || "（这条消息仅包含附件）";
  const summary = body.replace(/[\r\n]+/g, " ").trim().slice(0, 500);
  const attachmentBlock = attachments.flatMap((item) => [
    `- ${item.fileName}`,
    ...(item.transcript ? [`  - 转写：${item.transcript}`] : []),
  ]);
  return {
    title,
    category,
    tags,
    summary,
    keyPoints: [],
    knowledgePoints: [],
    domains: [],
    tools: [],
    detailsMarkdown: "",
    reason: "",
    suggestedAction: "none",
    sensitivity: "internal",
    confidence: "low",
    warnings: [],
    markdown: [
      "---",
      `title: ${yaml(title)}`,
      `source: ${yaml(source.sourceType)}`,
      `source_name: ${yaml(source.sourceName)}`,
      ...(source.sourceUrl ? [`source_url: ${yaml(source.sourceUrl)}`] : []),
      `message_id: ${yaml(message.id)}`,
      `sender_id: ${yaml(source.actorId)}`,
      `received_at: ${yaml(message.receivedAt)}`,
      ...(message.sentAt ? [`sent_at: ${yaml(message.sentAt)}`] : []),
      `category: ${yaml(category)}`,
      "tags:",
      ...tags.map((tag) => `  - ${yaml(tag)}`),
      ...yamlList("knowledge_points", []),
      ...yamlList("domains", []),
      ...yamlList("tools", []),
      "---",
      "",
      `# ${title}`,
      "",
      body,
      ...(attachmentBlock.length ? ["", "## 附件", "", ...attachmentBlock] : []),
      "",
    ].join("\n"),
  };
}

export function normalizeAgentNote(
  value: unknown,
  message: NoteInput,
): ProcessedNote {
  if (!value || typeof value !== "object") throw new Error("Nanobot 返回值不是 JSON 对象");
  const object = value as Record<string, unknown>;
  const allowedFields = new Set([
    "title",
    "category",
    "tags",
    "summary",
    "key_points",
    "knowledge_points",
    "domains",
    "tools",
    "reason",
    "suggestedAction",
    "sensitivity",
    "confidence",
    "warnings",
    "details_markdown",
    "reply",
    "derived_files",
  ]);
  const unexpected = Object.keys(object).filter((key) => !allowedFields.has(key));
  if (unexpected.length) throw new Error(`Nanobot 返回了不允许的字段：${unexpected.slice(0, 3).join("、")}`);
  const fallback = defaultNote(message);
  const source = sourceMetadata(message);
  const sourceTag = source.sourceType.startsWith("wechat") ? "微信收件" : `${source.sourceName}收件`;
  const title =
    typeof object.title === "string" && object.title.trim()
      ? cleanTitle(object.title)
      : fallback.title;
  const categories = new Set(["inbox", "task", "reference", "idea", "document", "image", "voice", "video"]);
  const category =
    typeof object.category === "string" && categories.has(object.category.trim())
      ? object.category.trim()
      : fallback.category;
  const tags = Array.isArray(object.tags)
    ? object.tags
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.replace(/^#+/, "").trim().slice(0, 80))
        .filter(Boolean)
        .filter((item, index, values) => values.indexOf(item) === index)
        .slice(0, 10)
    : fallback.tags;
  const content = message.text.trim() || "（这条消息仅包含附件）";
  const summary =
    typeof object.summary === "string" && object.summary.trim()
      ? object.summary.replace(/[\r\n]+/g, " ").trim().slice(0, 500)
      : undefined;
  const keyPoints = cleanList(object.key_points, 8);
  const knowledgePoints = cleanList(object.knowledge_points, 8)
    .map(compactKnowledgePoint)
    .filter(Boolean)
    .filter((item, index, values) => values.indexOf(item) === index)
    .slice(0, 8);
  const domains = cleanList(object.domains, 4);
  const tools = cleanList(object.tools, 8);
  const reason =
    typeof object.reason === "string" ? object.reason.replace(/[\r\n]+/g, " ").trim().slice(0, 300) : "";
  const actions = new Set(["none", "knowledge", "research", "project", "resource", "practice", "delete"]);
  const suggestedAction: NonNullable<ProcessedNote["suggestedAction"]> = typeof object.suggestedAction === "string" && actions.has(object.suggestedAction)
    ? object.suggestedAction as NonNullable<ProcessedNote["suggestedAction"]>
    : "none";
  const actionLabel: Record<string, string> = {
    none: "暂无建议",
    knowledge: "知识卡片",
    research: "研究课题",
    project: "项目",
    resource: "学习资源",
    practice: "安全实践",
    delete: "建议删除",
  };
  const sensitivityValues = new Set(["public", "internal", "confidential", "restricted"]);
  const sensitivity: NonNullable<ProcessedNote["sensitivity"]> = typeof object.sensitivity === "string" && sensitivityValues.has(object.sensitivity)
    ? object.sensitivity as NonNullable<ProcessedNote["sensitivity"]>
    : "internal";
  const sensitivityLabel: Record<string, string> = {
    public: "公开",
    internal: "内部",
    confidential: "机密",
    restricted: "严格受限",
  };
  const confidenceValues = new Set(["high", "medium", "low"]);
  const confidence: NonNullable<ProcessedNote["confidence"]> = typeof object.confidence === "string" && confidenceValues.has(object.confidence)
    ? object.confidence as NonNullable<ProcessedNote["confidence"]>
    : "low";
  const confidenceLabel: Record<string, string> = { high: "高", medium: "中", low: "低" };
  const warnings = Array.isArray(object.warnings)
    ? object.warnings
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.replace(/[\r\n]+/g, " ").trim().slice(0, 300))
        .filter(Boolean)
        .slice(0, 10)
    : [];
  const detailsMarkdown = typeof object.details_markdown === "string"
    ? normalizeLooseCodeBlocks(object.details_markdown).slice(0, 100_000)
    : "";
  const attachmentBlock = message.attachments.flatMap((attachment) => [
    `- ${attachment.fileName}`,
    ...(attachment.transcript ? [`  - 转写：${attachment.transcript}`] : []),
  ]);
  return {
    title,
    category,
    tags: Array.from(new Set([sourceTag, ...tags])),
    summary: summary || fallback.summary || "",
    keyPoints,
    knowledgePoints,
    domains,
    tools,
    detailsMarkdown,
    reason,
    suggestedAction,
    sensitivity,
    confidence,
    warnings,
    markdown: [
      "---",
      `title: ${yaml(title)}`,
      `source: ${yaml(source.sourceType)}`,
      `source_name: ${yaml(source.sourceName)}`,
      ...(source.sourceUrl ? [`source_url: ${yaml(source.sourceUrl)}`] : []),
      `message_id: ${yaml(message.id)}`,
      `sender_id: ${yaml(source.actorId)}`,
      `received_at: ${yaml(message.receivedAt)}`,
      ...(message.sentAt ? [`sent_at: ${yaml(message.sentAt)}`] : []),
      `category: ${yaml(category)}`,
      "tags:",
      ...Array.from(new Set([sourceTag, ...tags])).map((tag) => `  - ${yaml(tag)}`),
      ...yamlList("knowledge_points", knowledgePoints),
      ...yamlList("domains", domains),
      ...yamlList("tools", tools),
      "---",
      "",
      `# ${title}`,
      ...(summary ? ["", `> ${summary.replace(/\n/g, " ")}`] : []),
      "",
      content,
      ...(keyPoints.length ? ["", "## 关键要点", "", ...keyPoints.map((point) => `- ${point}`)] : []),
      ...(detailsMarkdown ? ["", "## 详细整理", "", detailsMarkdown] : []),
      ...(reason ? ["", "## 为什么值得保留", "", reason] : []),
      "",
      "> [!info] Agent 建议",
      `> 建议方向：${actionLabel[suggestedAction]}`,
      `> 置信度：${confidenceLabel[confidence]}`,
      `> 敏感级别：${sensitivityLabel[sensitivity]}`,
      ...(warnings.length
        ? ["", "> [!warning] 数据质量提醒", ...warnings.map((warning) => `> ${warning}`)]
        : []),
      ...(attachmentBlock.length ? ["", "## 附件", "", ...attachmentBlock] : []),
      "",
    ].join("\n"),
  };
}
