function inlineCodeLine(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("`") || !trimmed.endsWith("`")) return undefined;
  const leading = trimmed.match(/^`+/)?.[0].length || 0;
  const trailing = trimmed.match(/`+$/)?.[0].length || 0;
  const count = Math.min(leading, trailing);
  if (!count || count >= 3 || trimmed.length <= count * 2) return undefined;
  return trimmed.slice(count, -count).trimEnd();
}

function language(lines: string[]): string {
  const value = lines.join("\n");
  if (/\b(?:const|let|var|function|Interceptor|Module\.|console\.)\b|=>/.test(value)) return "javascript";
  if (/^(?:from\s+\S+\s+import|import\s+\S+|def\s+\w+\s*\()/m.test(value)) return "python";
  if (/^(?:#!.*\b(?:ba)?sh\b|\$\s+|(?:curl|docker|git|npm|pnpm|yarn)\s+)/m.test(value)) return "bash";
  if (/\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE TABLE)\b/i.test(value)) return "sql";
  return "text";
}

export function normalizeLooseCodeBlocks(value: string): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let index = 0;
  let insideFence = false;
  while (index < lines.length) {
    const line = lines[index]!;
    if (/^\s*```/.test(line)) {
      insideFence = !insideFence;
      output.push(line);
      index += 1;
      continue;
    }
    if (insideFence || inlineCodeLine(line) === undefined) {
      output.push(line);
      index += 1;
      continue;
    }
    const collected: string[] = [];
    let cursor = index;
    while (cursor < lines.length) {
      const candidate = inlineCodeLine(lines[cursor]!);
      if (candidate !== undefined) {
        collected.push(candidate);
        cursor += 1;
        continue;
      }
      if (!lines[cursor]!.trim() && inlineCodeLine(lines[cursor + 1] || "") !== undefined) {
        cursor += 1;
        continue;
      }
      break;
    }
    if (collected.length < 3) {
      output.push(line);
      index += 1;
      continue;
    }
    output.push(`\`\`\`${language(collected)}`, ...collected, "```", "");
    index = cursor;
  }
  return output.join("\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

function looksLikeTableRow(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && (trimmed.match(/\|/g)?.length || 0) >= 3;
}

function isTableDivider(value: string): boolean {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|){1,}\s*:?-{3,}:?\s*\|?\s*$/.test(value);
}

export function normalizeReadingMarkdown(value: string): string {
  const normalized = normalizeLooseCodeBlocks(value.replace(/[\u200b\u200c\u200d\ufeff]/g, ""));
  const lines = normalized.split("\n");
  const output: string[] = [];
  let insideFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*```/.test(line)) insideFence = !insideFence;
    output.push(line);
    if (
      !insideFence
      && looksLikeTableRow(line)
      && looksLikeTableRow(lines[index + 1] || "")
      && !looksLikeTableRow(lines[index - 1] || "")
      && !isTableDivider(lines[index + 1] || "")
      && !isTableDivider(lines[index - 1] || "")
    ) {
      const columns = Math.max(1, (line.match(/\|/g)?.length || 2) - 1);
      output.push(`| ${Array.from({ length: columns }, () => "---").join(" | ")} |`);
    }
  }
  if (insideFence) output.push("```");
  return output.join("\n").replace(/\n{4,}/g, "\n\n\n").trim();
}
