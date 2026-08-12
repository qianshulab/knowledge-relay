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
        .map((item) => item.trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 12)
    : fallback.tags;
  const content =
    typeof object.content === "string" && object.content.trim()
      ? object.content.trim()
      : message.text.trim() || "（这条消息仅包含附件）";
  const summary =
    typeof object.summary === "string" && object.summary.trim()
      ? object.summary.trim()
      : undefined;
  const tasks = Array.isArray(object.tasks)
    ? object.tasks.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
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
      ...(tasks.length ? ["", "## 待办", "", ...tasks.map((task) => `- [ ] ${task}`)] : []),
      ...(attachmentBlock.length ? ["", "## 附件", "", ...attachmentBlock] : []),
      "",
    ].join("\n"),
  };
}
