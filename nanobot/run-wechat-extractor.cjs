#!/usr/bin/env node

const path = require("node:path");
const { spawn } = require("node:child_process");

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

function runIsolatedExtractor(html, url) {
  const skillRoot = path.resolve(process.cwd(), "skills", "wechat-article-extractor");
  const childScript = path.resolve(process.cwd(), "nanobot-bin", "extract-wechat-isolated.cjs");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--permission", `--allow-fs-read=${skillRoot}`, childScript, url],
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

async function main() {
  const value = process.argv[2];
  if (!value) throw new Error("Usage: run-wechat-extractor.cjs <mp.weixin.qq.com URL>");
  const url = new URL(value);
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error("Only public WeChat article URLs are allowed");
  }
  const { html, finalUrl } = await fetchWechatHtml(url);
  process.stdout.write(await runIsolatedExtractor(html, finalUrl));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
