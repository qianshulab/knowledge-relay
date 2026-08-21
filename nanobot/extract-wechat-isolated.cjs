#!/usr/bin/env node

const path = require("node:path");

function markdownFromHtml(html, skillRoot) {
  const cheerio = require(path.join(skillRoot, "node_modules", "cheerio"));
  const $ = cheerio.load(`<main>${String(html || "")}</main>`, null, false);
  $("script,style,noscript,iframe,object,embed,svg,canvas,form,button").remove();
  const render = (node) => {
    if (!node) return "";
    if (node.type === "text") return String(node.data || "").replace(/\u00a0/g, " ");
    if (node.type !== "tag") return "";
    const tag = String(node.name || "").toLowerCase();
    const inner = (node.children || []).map(render).join("");
    if (tag === "br") return "\n";
    if (/^h[1-6]$/.test(tag)) return inner.trim()
      ? `\n\n${"#".repeat(Number(tag[1]))} ${inner.trim()}\n\n`
      : "";
    if (tag === "p" || tag === "section" || tag === "article") return `\n\n${inner.trim()}\n\n`;
    if (tag === "div") return `\n${inner.trim()}\n`;
    if (tag === "li") return inner.trim() ? `\n- ${inner.trim()}` : "";
    if (tag === "ul" || tag === "ol") return `\n${inner.trim()}\n`;
    if (tag === "blockquote") {
      return `\n\n${inner.trim().split(/\n+/).map((line) => `> ${line.trim()}`).join("\n")}\n\n`;
    }
    if (tag === "pre") return `\n\n\`\`\`\n${$(node).text().trim()}\n\`\`\`\n\n`;
    if (tag === "code") return `\`${inner.trim().replace(/`/g, "\\`")}\``;
    if (tag === "strong" || tag === "b") return inner.trim() ? `**${inner.trim()}**` : "";
    if (tag === "em" || tag === "i") return inner.trim() ? `*${inner.trim()}*` : "";
    if (tag === "a") {
      const href = String($(node).attr("href") || "").trim();
      const label = inner.trim() || href;
      return /^https?:\/\//i.test(href) ? `[${label}](${href})` : label;
    }
    if (tag === "img") {
      const rawSource = String($(node).attr("data-src") || $(node).attr("src") || "").trim();
      const source = rawSource.startsWith("//") ? `https:${rawSource}` : rawSource;
      const label = String($(node).attr("alt") || "图片").replace(/[\[\]]/g, "").trim() || "图片";
      return /^https?:\/\//i.test(source) ? `![${label}](${source})` : "";
    }
    if (tag === "hr") return "\n\n---\n\n";
    return inner;
  };
  return render($("main")[0])
    .replace(/^#\s*$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 500_000);
}

async function main() {
  const url = process.argv[2];
  if (!url) throw new Error("Missing WeChat URL");
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Error("WeChat article exceeds 5MB");
    chunks.push(chunk);
  }
  const skillRoot = path.resolve(process.cwd(), "skills", "wechat-article-extractor");
  const { extract } = require(path.join(skillRoot, "scripts", "extract.js"));
  const result = await extract(Buffer.concat(chunks).toString("utf8"), { url });
  if (process.argv.includes("--markdown") && result?.done && result.data) {
    result.data.msg_markdown = markdownFromHtml(result.data.msg_content, skillRoot);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result?.done) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { markdownFromHtml };
