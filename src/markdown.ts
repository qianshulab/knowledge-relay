type TableRow = {
  cells: string[];
  hasOuterPipes: boolean;
};

function inlineCodeLine(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("`") || !trimmed.endsWith("`")) return undefined;
  const leading = trimmed.match(/^`+/)?.[0].length || 0;
  const trailing = trimmed.match(/`+$/)?.[0].length || 0;
  const count = Math.min(leading, trailing);
  if (!count || count >= 3 || trimmed.length <= count * 2) return undefined;
  return trimmed.slice(count, -count).trimEnd();
}

function normalizeLanguage(value: string): string {
  const language = value.trim().toLowerCase().replace(/^language-/, "");
  const aliases: Record<string, string> = {
    cjs: "javascript",
    js: "javascript",
    mjs: "javascript",
    py: "python",
    sh: "bash",
    shell: "bash",
    ts: "typescript",
    yml: "yaml",
  };
  return aliases[language] || language.replace(/[^a-z0-9_+#.-]/g, "");
}

function codeLanguage(lines: string[]): string {
  const value = lines.join("\n").trim();
  if (/^(?:http|events|mail|stream)\s*\{|\b(?:upstream|proxy_pass|server_name|location\s+[/~=^*])\b/m.test(value)) {
    return "nginx";
  }
  if (/^\s*(?:interface|type|enum|namespace)\s+\w+|:\s*(?:string|number|boolean|unknown|never)(?:\[\])?[;,)]/m.test(value)) {
    return "typescript";
  }
  if (/\b(?:const|let|var|function|async|await|return|new\s+\w+|Interceptor|Module\.|console\.)\b|=>/.test(value)) {
    return "javascript";
  }
  if (/^(?:from\s+\S+\s+import|import\s+\S+|def\s+\w+\s*\(|class\s+\w+.*:|\s*@\w+)/m.test(value)) {
    return "python";
  }
  if (/^(?:#!.*\b(?:ba|z|k)?sh\b|\s*\$\s+|\s*(?:curl|docker|git|npm|pnpm|yarn|bun|kubectl|helm|chmod|mkdir|cd)\s+)/m.test(value)) {
    return "bash";
  }
  if (/\b(?:SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE)\b/i.test(value)) {
    return "sql";
  }
  if (/^\s*(?:<!DOCTYPE\s+html|<\/?(?:html|head|body|main|section|div|script|style|template|svg)\b)/im.test(value)) {
    return "html";
  }
  if (/^\s*(?:[#.][\w-]+|[a-z][\w-]*(?:\s+[.#][\w-]+)?)\s*\{[\s\S]*\b(?:color|display|margin|padding|font|background)[-\w]*\s*:/im.test(value)) {
    return "css";
  }
  if (/^\s*(?:FROM|RUN|COPY|ADD|WORKDIR|ENTRYPOINT|CMD|ARG|ENV|EXPOSE)\b/im.test(value)) {
    return "dockerfile";
  }
  if (/^\s*[{[]/.test(value) && /[}\]]\s*$/.test(value)) {
    try {
      JSON.parse(value);
      return "json";
    } catch {
      // A partial object can still be valid source in another language.
    }
  }
  const nonEmpty = lines.filter((line) => line.trim());
  if (nonEmpty.length >= 2 && nonEmpty.filter((line) => /^\s*[\w.-]+\s*:\s*\S/.test(line)).length >= Math.ceil(nonEmpty.length * 0.6)) {
    return "yaml";
  }
  if (nonEmpty.length >= 2 && nonEmpty.filter((line) => /^\s*[\w.-]+\s*=\s*\S/.test(line)).length >= Math.ceil(nonEmpty.length * 0.6)) {
    return "toml";
  }
  if (/^\s*(?:package\s+\w+|import\s+[\w.]+;|public\s+(?:class|static)|System\.out\.)/m.test(value)) {
    return "java";
  }
  if (/^\s*(?:#include\s*[<"]|(?:int|void|char|size_t)\s+\w+\s*\()/m.test(value)) {
    return "c";
  }
  return "text";
}

function technicalLineScore(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  let score = 0;
  if (/^(?:const|let|var|function|class|interface|type|def|from|import|return|if|else|for|while|try|catch|finally|async|await)\b/.test(trimmed)) score += 3;
  if (/^(?:http|server|upstream|location|events)\s*\{|^(?:proxy_pass|server_name|listen)\b/.test(trimmed)) score += 3;
  if (/^(?:[$#]\s+|curl\s+|docker\s+|git\s+|npm\s+|pnpm\s+|yarn\s+|kubectl\s+)/.test(trimmed)) score += 3;
  if (/^(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i.test(trimmed)) score += 3;
  if (/^<\/?[A-Za-z][^>]*>$/.test(trimmed)) score += 3;
  if (/^\s*[\w.-]+\s*[:=]\s*(?:["'[{]|\w|\d)/.test(value)) score += 2;
  if (/[{};]$/.test(trimmed) || /^(?:[{}]|\);?|\],?)$/.test(trimmed)) score += 2;
  if (/=>|===|!==|&&|\|\||\+\+|--|\?\?|\?\./.test(trimmed)) score += 2;
  if (/\b(?:console\.|Module\.|Interceptor\.|this\.|process\.|require\(|print\(|printf\(|echo\s+)/.test(trimmed)) score += 2;
  if (/^\s{2,}\S/.test(value)) score += 1;
  if (/^(?:\/\/|\/\*|\*|#(?!\s))/u.test(trimmed)) score += 1;
  return score;
}

function looksLikeTechnicalCode(lines: string[]): boolean {
  const nonEmpty = lines.filter((line) => line.trim());
  if (nonEmpty.length < 3) return false;
  const joined = nonEmpty.join("\n");
  const score = nonEmpty.reduce((total, line) => total + technicalLineScore(line), 0);
  const structuralLines = nonEmpty.filter((line) => technicalLineScore(line) >= 2).length;
  const hanCharacters = joined.match(/[\u3400-\u9fff]/g)?.length || 0;
  const visibleCharacters = joined.replace(/\s/g, "").length || 1;
  const mostlyChinese = hanCharacters / visibleCharacters > 0.45;
  if (mostlyChinese && structuralLines < 2) return false;
  return structuralLines >= 2 && score >= Math.max(6, nonEmpty.length);
}

function unescapeFenceLine(value: string): string {
  const indent = value.match(/^\s*/)?.[0] || "";
  const remainder = value.slice(indent.length);
  let cursor = 0;
  let count = 0;
  while (remainder.slice(cursor, cursor + 2) === "\\`") {
    count += 1;
    cursor += 2;
  }
  if (count < 3) return value;
  return `${indent}${"`".repeat(count)}${remainder.slice(cursor).replace(/\\`/g, "`")}`;
}

function fenceMarker(value: string): { marker: string; info: string } | undefined {
  const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(value);
  if (!match) return undefined;
  return { marker: match[1]!, info: match[2]!.trim() };
}

/**
 * Some compatible models wrap every source line in inline backticks instead
 * of returning one fenced block. Only structurally convincing runs are
 * repaired so lists of ordinary Chinese terms remain ordinary prose.
 */
export function normalizeLooseCodeBlocks(value: string): string {
  const lines = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(unescapeFenceLine);
  const output: string[] = [];
  let index = 0;
  let insideFence = false;
  let openMarker = "";
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = fenceMarker(line);
    if (fence) {
      if (!insideFence) {
        insideFence = true;
        openMarker = fence.marker;
      } else if (fence.marker[0] === openMarker[0] && fence.marker.length >= openMarker.length && !fence.info) {
        insideFence = false;
        openMarker = "";
      }
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
    const raw: string[] = [];
    let cursor = index;
    while (cursor < lines.length) {
      const candidate = inlineCodeLine(lines[cursor]!);
      if (candidate !== undefined) {
        collected.push(candidate);
        raw.push(lines[cursor]!);
        cursor += 1;
        continue;
      }
      if (!lines[cursor]!.trim() && inlineCodeLine(lines[cursor + 1] || "") !== undefined) {
        raw.push(lines[cursor]!);
        cursor += 1;
        continue;
      }
      break;
    }
    if (!looksLikeTechnicalCode(collected)) {
      output.push(...raw);
      index = cursor;
      continue;
    }
    output.push(`\`\`\`${codeLanguage(collected)}`, ...collected, "```", "");
    index = cursor;
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function splitTableCells(value: string): string[] {
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  let insideCode = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === "`") {
      insideCode = !insideCode;
      current += character;
      continue;
    }
    if (character === "|" && !insideCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function parseTableRow(value: string): TableRow | undefined {
  const trimmed = value.trim();
  if (!trimmed || /^(?:>|[-*+]\s|\d+[.)、）]\s)/.test(trimmed) || !trimmed.includes("|")) return undefined;
  const startsWithPipe = trimmed.startsWith("|");
  const endsWithPipe = trimmed.endsWith("|") && !trimmed.endsWith("\\|");
  const cells = splitTableCells(trimmed);
  if (startsWithPipe && cells[0] === "") cells.shift();
  if (endsWithPipe && cells.at(-1) === "") cells.pop();
  if (cells.length < 2 || cells.some((cell) => cell.length > 240) || cells.every((cell) => !cell)) return undefined;
  return { cells, hasOuterPipes: startsWithPipe && endsWithPipe };
}

function isDividerCell(value: string): boolean {
  return /^:?-{3,}:?$/.test(value.replace(/\s/g, ""));
}

function isDividerRow(row: TableRow): boolean {
  return row.cells.every(isDividerCell);
}

function normalizedDividerCell(value: string): string {
  const compact = value.replace(/\s/g, "");
  if (compact.startsWith(":") && compact.endsWith(":")) return ":---:";
  if (compact.startsWith(":")) return ":---";
  if (compact.endsWith(":")) return "---:";
  return "---";
}

function renderTableRow(row: TableRow): string {
  return `| ${row.cells.join(" | ")} |`;
}

function normalizeReliableTables(lines: string[]): string[] {
  const output: string[] = [];
  let index = 0;
  let insideFence = false;
  while (index < lines.length) {
    const fence = fenceMarker(lines[index]!);
    if (fence) {
      insideFence = !insideFence;
      output.push(lines[index]!);
      index += 1;
      continue;
    }
    const first = insideFence ? undefined : parseTableRow(lines[index]!);
    if (!first) {
      output.push(lines[index]!);
      index += 1;
      continue;
    }

    const rows: TableRow[] = [first];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const direct = parseTableRow(lines[cursor]!);
      if (direct) {
        rows.push(direct);
        cursor += 1;
        continue;
      }
      if (!lines[cursor]!.trim() && parseTableRow(lines[cursor + 1] || "")) {
        cursor += 1;
        continue;
      }
      break;
    }
    const columns = first.cells.length;
    const dividerIndexes = rows
      .map((row, rowIndex) => isDividerRow(row) ? rowIndex : -1)
      .filter((rowIndex) => rowIndex >= 0);
    const consistent = rows.every((row) => row.cells.length === columns);
    const reliableShape = rows.every((row) => row.hasOuterPipes) || columns >= 3;
    const dividerPositionValid = dividerIndexes.length === 0 || (dividerIndexes.length === 1 && dividerIndexes[0] === 1);
    const contentRows = rows.filter((row) => !isDividerRow(row));
    if (!consistent || !reliableShape || !dividerPositionValid || contentRows.length < 2) {
      output.push(...lines.slice(index, cursor));
      index = cursor;
      continue;
    }

    output.push(renderTableRow(rows[0]!));
    if (dividerIndexes[0] === 1) {
      output.push(renderTableRow({
        cells: rows[1]!.cells.map(normalizedDividerCell),
        hasOuterPipes: true,
      }));
      output.push(...rows.slice(2).map(renderTableRow));
    } else {
      output.push(renderTableRow({
        cells: Array.from({ length: columns }, () => "---"),
        hasOuterPipes: true,
      }));
      output.push(...rows.slice(1).map(renderTableRow));
    }
    index = cursor;
  }
  return output;
}

function normalizeHeading(value: string, previousLevel: number | undefined): { line: string; level: number } | undefined {
  const match = /^\s*(#{1,})(?:\s*)(.*?)\s*$/.exec(value);
  if (!match || !match[2]) return undefined;
  const text = match[2]!.trim().replace(/\s+#+\s*$/, "").trim();
  if (!text) return undefined;
  if (/^(?:include|define|ifn?def|endif|pragma)\b/.test(text)) return undefined;
  let level = Math.min(6, match[1]!.length);
  if (previousLevel && level > previousLevel + 1) level = previousLevel + 1;
  return { line: `${"#".repeat(level)} ${text}`, level };
}

function normalizeListMarker(value: string): string {
  return value
    .replace(/^(\s*)[•●◦▪·]\s+/, "$1- ")
    .replace(/^(\s*)(\d{1,3})[、）)]\s*/, "$1$2. ")
    .replace(/^(\s*)\*\s+/, "$1- ");
}

function isListLine(value: string): boolean {
  return /^\s*(?:[-+]\s+|\d+\.\s+)/.test(value);
}

function normalizeOutsideFences(lines: string[]): string[] {
  const output: string[] = [];
  let insideFence = false;
  let previousHeadingLevel: number | undefined;
  for (const value of lines) {
    const fence = fenceMarker(value);
    if (fence) {
      insideFence = !insideFence;
      output.push(value.trimEnd());
      continue;
    }
    if (insideFence) {
      output.push(value);
      continue;
    }
    const heading = normalizeHeading(value, previousHeadingLevel);
    if (heading) {
      previousHeadingLevel = heading.level;
      output.push(heading.line);
      continue;
    }
    output.push(normalizeListMarker(value).trimEnd());
  }
  return output;
}

function ensureBlockSpacing(lines: string[]): string[] {
  const output: string[] = [];
  const pushBlank = () => {
    if (output.length && output.at(-1)?.trim()) output.push("");
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = fenceMarker(line);
    if (fence) {
      pushBlank();
      output.push(line);
      index += 1;
      while (index < lines.length) {
        output.push(lines[index]!);
        const closing = fenceMarker(lines[index]!);
        index += 1;
        if (closing && !closing.info) break;
      }
      if (lines[index]?.trim()) output.push("");
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      pushBlank();
      output.push(line);
      if (lines[index + 1]?.trim()) output.push("");
      index += 1;
      continue;
    }
    const table = parseTableRow(line);
    if (table && (isDividerRow(table) || parseTableRow(lines[index + 1] || "") || parseTableRow(lines[index - 1] || ""))) {
      pushBlank();
      while (index < lines.length && parseTableRow(lines[index]!)) {
        output.push(lines[index]!);
        index += 1;
      }
      if (lines[index]?.trim()) output.push("");
      continue;
    }
    if (isListLine(line) && output.at(-1)?.trim() && !isListLine(output.at(-1)!)) output.push("");
    output.push(line);
    if (isListLine(line)) {
      const next = lines[index + 1] || "";
      if (next.trim() && !isListLine(next) && !/^\s{2,}\S/.test(next)) output.push("");
    }
    index += 1;
  }
  return output;
}

function canonicalizeFences(lines: string[]): string[] {
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const opening = fenceMarker(lines[index]!);
    if (!opening) {
      output.push(lines[index]!);
      index += 1;
      continue;
    }
    const content: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const closing = fenceMarker(lines[cursor]!);
      if (closing && closing.marker[0] === opening.marker[0] && closing.marker.length >= opening.marker.length && !closing.info) break;
      content.push(lines[cursor]!);
      cursor += 1;
    }
    const explicitLanguage = normalizeLanguage(opening.info.split(/\s+/)[0] || "");
    const language = explicitLanguage || codeLanguage(content);
    output.push(`\`\`\`${language}`, ...content, "```");
    index = cursor < lines.length ? cursor + 1 : cursor;
  }
  return output;
}

function safeLinkLabel(value: string, fallback: string): string {
  const label = value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[\[\]\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return label || fallback;
}

/**
 * A cached image failure used to be represented as a Markdown link. When the
 * source image was itself wrapped by a link this produced invalid nested-link
 * Markdown, for example `[[图片未保存：logo](image) 产品](page)`. Repair that
 * exact legacy shape at read time so already stored articles render cleanly.
 */
function normalizeNestedImageFallbacks(value: string): string {
  return value.replace(
    /\[\[图片未保存：([^\]\r\n]{0,500})\]\((https?:\/\/[^)\s]{1,4000})\)([^\]\r\n]{0,500})\]\((https?:\/\/[^)\s]{1,4000})\)/gi,
    (_full, alt: string, imageUrl: string, caption: string, destinationUrl: string) => {
      const label = safeLinkLabel(caption, safeLinkLabel(alt, "相关资料"));
      if (/(?:logo|icon|图标|徽标)/i.test(alt) && caption.trim()) return `[${label}](${destinationUrl})`;
      return `[${label}](${destinationUrl})（[图片未保存](${imageUrl})）`;
    },
  );
}

/**
 * Web card layouts commonly arrive as an image followed by a short linked
 * product name. Markdown cannot preserve the original flex/grid styling, so
 * join only unmistakable logo/icon pairs into one semantic linked-media item.
 */
function normalizeLinkedLogoPairs(value: string): string {
  return value.replace(
    /(^|\n)([ \t]*)!\[([^\]\r\n]*(?:logo|icon|图标|徽标)[^\]\r\n]*)\]\(([^)\r\n]+)\)(?:[ \t]*|[ \t]*\n(?:[ \t]*\n)?[ \t]*)\[([^\]\r\n]{1,80})\]\(([^)\r\n]+)\)/gi,
    (_full, prefix: string, indent: string, alt: string, imageUrl: string, label: string, destinationUrl: string) => (
      `${prefix}${indent}[![${alt}](${imageUrl}) ${safeLinkLabel(label, safeLinkLabel(alt, "相关资料"))}](${destinationUrl})`
    ),
  );
}

/**
 * Reader-safe normalization for Markdown produced by different models and
 * importers. It repairs common structural omissions without rewriting prose.
 */
export function normalizeReadingMarkdown(value: string): string {
  const source = normalizeLinkedLogoPairs(normalizeNestedImageFallbacks(value))
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/\r\n?/g, "\n");
  if (!source.trim()) return "";
  const looseCode = normalizeLooseCodeBlocks(source);
  const escapedFences = looseCode.split("\n").map(unescapeFenceLine);
  const canonicalFences = canonicalizeFences(escapedFences);
  const structured = normalizeOutsideFences(canonicalFences);
  const tables = normalizeReliableTables(structured);
  return ensureBlockSpacing(tables).join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
