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
    .join(":");
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
  return (line || title || "微信收件").replace(/\s+/g, " ").slice(0, 180);
}

function firstUrl(content) {
  return String(content || "").match(/https?:\/\/[^\s)>\]]+/i)?.[0];
}

function insertAfterHeading(markdown, heading, value) {
  if (!value) return markdown;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`(^##\\s+${escaped}[ \\t]*$)`, "m");
  if (!expression.test(markdown)) return `${markdown.trimEnd()}\n\n## ${heading}\n\n${value}\n`;
  return markdown.replace(
    new RegExp(`(^##\\s+${escaped}[ \\t]*$)\\r?\\n(?:[ \\t]*\\r?\\n)*`, "m"),
    `$1\n\n${value}\n\n`,
  );
}

function ensureSyncMetadata(markdown, item) {
  const metadata = [
    `知流消息ID: ${JSON.stringify(String(item.messageId || ""))}`,
    `知流修订: ${Number(item.revision || 1)}`,
  ];
  if (/^---\s*\r?\n/.test(markdown)) {
    return markdown.replace(/\r?\n---\s*(?:\r?\n|$)/, `\n${metadata.join("\n")}\n---\n\n`);
  }
  return `---\n${metadata.join("\n")}\n---\n\n${markdown}`;
}

function applyCaptureTemplate(template, item, attachmentLinks = []) {
  const original = extractOriginalContent(item.markdown);
  const summary = summarize(original, item.title);
  const attachments = attachmentLinks.join("\n");
  const source = firstUrl(original) || "微信 iLink";
  const hadContentPlaceholder = /{{\s*content\s*}}/i.test(template);
  const hadSummaryPlaceholder = /{{\s*summary\s*}}/i.test(template);
  const hadAttachmentsPlaceholder = /{{\s*attachments\s*}}/i.test(template);
  const values = {
    date: formatLocalDate(item.receivedAt),
    time: formatLocalTime(item.receivedAt),
    datetime: `${formatLocalDate(item.receivedAt)} ${formatLocalTime(item.receivedAt)}`.trim(),
    title: String(item.title || "微信收件").replace(/[\r\n]+/g, " ").trim(),
    content: original,
    summary,
    message_id: String(item.messageId || ""),
    revision: String(item.revision || 1),
    source,
    attachments,
  };
  let result = String(template || "").replace(
    /{{\s*(date|time|datetime|title|content|summary|message_id|revision|source|attachments)\s*}}/gi,
    (_match, key) => values[String(key).toLowerCase()] || "",
  );
  if (/^来源:\s*""\s*$/m.test(result)) {
    result = result.replace(/^来源:\s*""\s*$/m, `来源: ${JSON.stringify(source)}`);
  }
  if (!hadSummaryPlaceholder) result = insertAfterHeading(result, "一句话说明", summary);
  if (!hadContentPlaceholder) {
    result = insertAfterHeading(
      result,
      "原始内容 / 链接",
      [original, attachments].filter(Boolean).join("\n\n"),
    );
  } else if (!hadAttachmentsPlaceholder && attachments) {
    result = insertAfterHeading(result, "同步附件", attachments);
  }
  return `${ensureSyncMetadata(result, item).trimEnd()}\n`;
}

module.exports = {
  applyCaptureTemplate,
  extractOriginalContent,
  formatLocalDate,
  summarize,
};
