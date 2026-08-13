#!/usr/bin/env node

const path = require("node:path");

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
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result?.done) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
