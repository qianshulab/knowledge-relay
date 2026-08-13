import type { PublicInboundMessage } from "./messages.js";
import type { ProcessedNote } from "./storage/database.js";

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

export function defaultNote(message: PublicInboundMessage): ProcessedNote {
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
  const title = cleanTitle(firstLine) || (message.attachments.length ? "微信附件" : "微信收件");
  const tags = ["微信收件", category].filter((item, index, values) => values.indexOf(item) === index);
  const attachments = message.attachments.map((item) => ({
    fileName: item.fileName,
    kind: item.kind,
    transcript: item.transcript,
  }));
  const body = message.text.trim() || "（这条消息仅包含附件）";
  const attachmentBlock = attachments.flatMap((item) => [
    `- ${item.fileName}`,
    ...(item.transcript ? [`  - 转写：${item.transcript}`] : []),
  ]);
  return {
    title,
    category,
    tags,
    markdown: [
      "---",
      `title: ${yaml(title)}`,
      'source: "wechat-ilink"',
      `message_id: ${yaml(message.id)}`,
      `sender_id: ${yaml(message.senderId)}`,
      `received_at: ${yaml(message.receivedAt)}`,
      ...(message.sentAt ? [`sent_at: ${yaml(message.sentAt)}`] : []),
      `category: ${yaml(category)}`,
      "tags:",
      ...tags.map((tag) => `  - ${yaml(tag)}`),
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
  message: PublicInboundMessage,
): ProcessedNote {
  if (!value || typeof value !== "object") throw new Error("Nanobot 返回值不是 JSON 对象");
  const object = value as Record<string, unknown>;
  const allowedFields = new Set([
    "title",
    "category",
    "tags",
    "summary",
    "reason",
    "suggestedAction",
    "sensitivity",
    "confidence",
    "warnings",
    "reply",
    "derived_files",
  ]);
  const unexpected = Object.keys(object).filter((key) => !allowedFields.has(key));
  if (unexpected.length) throw new Error(`Nanobot 返回了不允许的字段：${unexpected.slice(0, 3).join("、")}`);
  const fallback = defaultNote(message);
  const title =
    typeof object.title === "string" && object.title.trim()
      ? cleanTitle(object.title)
      : fallback.title;
  const category =
    typeof object.category === "string" && object.category.trim()
      ? object.category.trim().slice(0, 40)
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
  const reason =
    typeof object.reason === "string" ? object.reason.replace(/[\r\n]+/g, " ").trim().slice(0, 300) : "";
  const actions = new Set(["none", "knowledge", "research", "project", "resource", "practice", "delete"]);
  const suggestedAction = typeof object.suggestedAction === "string" && actions.has(object.suggestedAction)
    ? object.suggestedAction
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
  const sensitivity = typeof object.sensitivity === "string" && sensitivityValues.has(object.sensitivity)
    ? object.sensitivity
    : "internal";
  const sensitivityLabel: Record<string, string> = {
    public: "公开",
    internal: "内部",
    confidential: "机密",
    restricted: "严格受限",
  };
  const confidenceValues = new Set(["high", "medium", "low"]);
  const confidence = typeof object.confidence === "string" && confidenceValues.has(object.confidence)
    ? object.confidence
    : "low";
  const confidenceLabel: Record<string, string> = { high: "高", medium: "中", low: "低" };
  const warnings = Array.isArray(object.warnings)
    ? object.warnings
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.replace(/[\r\n]+/g, " ").trim().slice(0, 300))
        .filter(Boolean)
        .slice(0, 10)
    : [];
  const attachmentBlock = message.attachments.flatMap((attachment) => [
    `- ${attachment.fileName}`,
    ...(attachment.transcript ? [`  - 转写：${attachment.transcript}`] : []),
  ]);
  return {
    title,
    category,
    tags: Array.from(new Set(["微信收件", ...tags])),
    markdown: [
      "---",
      `title: ${yaml(title)}`,
      'source: "wechat-ilink"',
      `message_id: ${yaml(message.id)}`,
      `sender_id: ${yaml(message.senderId)}`,
      `received_at: ${yaml(message.receivedAt)}`,
      ...(message.sentAt ? [`sent_at: ${yaml(message.sentAt)}`] : []),
      `category: ${yaml(category)}`,
      "tags:",
      ...Array.from(new Set(["微信收件", ...tags])).map((tag) => `  - ${yaml(tag)}`),
      "---",
      "",
      `# ${title}`,
      ...(summary ? ["", `> ${summary.replace(/\n/g, " ")}`] : []),
      "",
      content,
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
