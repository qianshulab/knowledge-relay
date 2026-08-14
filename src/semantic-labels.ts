function normalizedLabel(value: unknown): string {
  return typeof value === "string"
    ? value
      .normalize("NFKC")
      .replace(/^#+/, "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
    : "";
}

/**
 * Knowledge points are reusable concept names, not miniature summaries.
 * Older model responses sometimes stored `concept: explanation`; keep the
 * searchable concept while removing the explanatory clause for presentation
 * and future notes.
 */
export function compactKnowledgePoint(value: unknown): string {
  let label = normalizedLabel(value);
  if (!label) return "";

  const separator = label.search(/[:：]/u);
  if (separator >= 2) label = label.slice(0, separator).trim();
  else {
    const sentenceEnd = label.search(/[。；;]/u);
    if (sentenceEnd >= 2) label = label.slice(0, sentenceEnd).trim();
  }

  const explanatory = label.match(/^(.{2,40}?)(?:用于|通过|采用|支持|实现|完成|负责|可以|能够|将).{4,}$/u);
  if (explanatory?.[1]) label = explanatory[1].trim();

  return Array.from(label.replace(/[,，。；;:：]+$/u, "")).slice(0, 32).join("").trim();
}
