#!/usr/bin/env node

const path = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const ALLOWED_HOSTS = new Set(["mp.weixin.qq.com", "weixin.sogou.com"]);
const MAX_HTML_BYTES = 5 * 1024 * 1024;

async function fetchWechatHtml(initialUrl) {
  let current = initialUrl;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (current.protocol !== "https:" || !ALLOWED_HOSTS.has(current.hostname)) {
      throw new Error("Only public WeChat article URLs are allowed");
    }
    const response = await fetch(current, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.5",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("Too many or invalid WeChat redirects");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`WeChat returned HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_HTML_BYTES) throw new Error("WeChat article exceeds 5MB");
    const html = await response.text();
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error("WeChat article exceeds 5MB");
    return { html, finalUrl: current.toString() };
  }
  throw new Error("Unable to fetch WeChat article");
}

function runIsolatedExtractor(html, url, includeMarkdown) {
  const skillRoot = path.resolve(process.cwd(), "skills", "wechat-article-extractor");
  const childScript = path.resolve(process.cwd(), "nanobot-bin", "extract-wechat-isolated.cjs");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--permission", `--allow-fs-read=${skillRoot}`, childScript, url, ...(includeMarkdown ? ["--markdown"] : [])],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin", NODE_NO_WARNINGS: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 10 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Isolated extractor failed (${signal || code}): ${stderr.trim()}`));
    });
    child.stdin.end(html);
  });
}

function safeArtifactPath(value) {
  if (!value || path.isAbsolute(value) || path.extname(value).toLowerCase() !== ".md") {
    throw new Error("Markdown output must be a relative .md path under artifacts/");
  }
  const workspace = process.cwd();
  const artifacts = path.resolve(workspace, "artifacts");
  const output = path.resolve(workspace, value);
  if (!output.startsWith(`${artifacts}${path.sep}`)) {
    throw new Error("Markdown output must stay under artifacts/");
  }
  fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const realArtifacts = fs.realpathSync(artifacts);
  const realParent = fs.realpathSync(path.dirname(output));
  if (realParent !== realArtifacts && !realParent.startsWith(`${realArtifacts}${path.sep}`)) {
    throw new Error("Markdown output parent escapes artifacts/");
  }
  return output;
}

function metadataLine(label, value) {
  return value ? `- ${label}：${String(value).replace(/[\r\n]+/g, " ").trim()}` : "";
}

function articleMarkdown(data, sourceUrl) {
  const title = String(data.msg_title || "微信公众号文章").replace(/[\r\n]+/g, " ").trim();
  const rawCover = String(data.msg_cover || data.msg_cover_url || "").trim();
  const cover = rawCover.startsWith("//") ? `https:${rawCover}` : rawCover;
  const metadata = [
    metadataLine("作者", data.msg_author),
    metadataLine("公众号", data.account_name),
    metadataLine("发布时间", data.msg_publish_time_str),
    metadataLine("原文", data.msg_link || sourceUrl),
  ].filter(Boolean);
  return [
    `# ${title}`,
    "",
    ...metadata,
    "",
    "---",
    "",
    ...(/^https?:\/\//i.test(cover) ? [`![${title}封面](${cover})`, ""] : []),
    String(data.msg_markdown || "").trim(),
    "",
  ].join("\n").trim().slice(0, 500_000) + "\n";
}

async function main() {
  const args = process.argv.slice(2);
  const value = args[0];
  const outputIndex = args.indexOf("--markdown-output");
  const outputValue = outputIndex >= 0 ? args[outputIndex + 1] : "";
  if (!value) throw new Error("Usage: run-wechat-extractor.cjs <mp.weixin.qq.com URL> [--markdown-output artifacts/<run-id>/article.md]");
  if (outputIndex >= 0 && !outputValue) throw new Error("--markdown-output requires a path");
  const url = new URL(value);
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error("Only public WeChat article URLs are allowed");
  }
  const { html, finalUrl } = await fetchWechatHtml(url);
  const raw = await runIsolatedExtractor(html, finalUrl, Boolean(outputValue));
  if (!outputValue) {
    process.stdout.write(raw);
    return;
  }
  const result = JSON.parse(raw);
  if (!result?.done || !result.data?.msg_markdown) {
    throw new Error(result?.msg || "WeChat article did not produce Markdown");
  }
  const output = safeArtifactPath(outputValue);
  const markdown = articleMarkdown(result.data, finalUrl);
  fs.writeFileSync(output, markdown, { encoding: "utf8", mode: 0o600 });
  const { msg_content: _html, msg_markdown: _markdown, ...metadata } = result.data;
  process.stdout.write(`${JSON.stringify({
    code: result.code,
    done: result.done,
    data: metadata,
    artifact: {
      path: path.relative(process.cwd(), output),
      characters: markdown.length,
      format: "text/markdown",
    },
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { articleMarkdown };
