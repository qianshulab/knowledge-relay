import { describe, expect, it } from "vitest";

import { normalizeReadingMarkdown } from "./markdown.js";

describe("reader Markdown normalization", () => {
  it("groups model-produced inline code lines into a fenced block", () => {
    const markdown = [
      "正文",
      "",
      "`const enabled = true;`",
      "",
      "`if (enabled) {`",
      "",
      "`  console.log(enabled);`",
      "",
      "`}`",
    ].join("\n");

    expect(normalizeReadingMarkdown(markdown)).toContain("```javascript\nconst enabled = true;");
  });

  it("adds one missing table divider without altering its body", () => {
    const markdown = "| 平台 | 状态 |\n| Claude Code | 原生 |\n| Cursor | 支持 |";
    const normalized = normalizeReadingMarkdown(markdown);

    expect(normalized).toBe("| 平台 | 状态 |\n| --- | --- |\n| Claude Code | 原生 |\n| Cursor | 支持 |");
  });

  it("closes an unfinished fence so later content cannot leak into code styling", () => {
    expect(normalizeReadingMarkdown("```bash\necho hello")).toBe("```bash\necho hello\n```");
  });

  it("recognizes a line-by-line Nginx configuration and preserves its indentation", () => {
    const markdown = [
      "下面是反向代理配置：",
      "",
      "`http {`",
      "",
      "`  upstream backend {`",
      "",
      "`    server backend.internal.com:8000;`",
      "",
      "`  }`",
      "",
      "`  server {`",
      "",
      "`    location / {`",
      "",
      "`      proxy_pass http://backend;`",
      "",
      "`    }`",
      "",
      "`  }`",
      "",
      "`}`",
    ].join("\n");

    const normalized = normalizeReadingMarkdown(markdown);
    expect(normalized).toContain("```nginx\nhttp {\n  upstream backend {");
    expect(normalized).toContain("      proxy_pass http://backend;\n    }\n  }\n}\n```");
  });

  it("does not turn ordinary long Chinese inline-code paragraphs into a code block", () => {
    const markdown = [
      "`第一部分说明项目为什么需要保存原始资料，方便以后核对上下文。`",
      "",
      "`第二部分说明系统会提取主题与知识点，但不会改变资料表达的事实。`",
      "",
      "`第三部分说明用户仍然可以打开原文，并查看本地保存的附件。`",
    ].join("\n");

    const normalized = normalizeReadingMarkdown(markdown);
    expect(normalized).not.toContain("```");
    expect(normalized).toContain("`第二部分说明系统会提取主题与知识点，但不会改变资料表达的事实。`");
  });

  it("repairs escaped fences and normalizes a known language alias", () => {
    const markdown = [
      "\\`\\`\\`js",
      "const answer = 42;",
      "console.log(answer);",
      "\\`\\`\\`",
    ].join("\n");

    expect(normalizeReadingMarkdown(markdown)).toBe([
      "```javascript",
      "const answer = 42;",
      "console.log(answer);",
      "```",
    ].join("\n"));
  });

  it("repairs a reliable three-column table even when the model inserts blank rows", () => {
    const markdown = [
      "平台 | 状态 | 安装方式",
      "",
      "Claude Code | 原生 | 插件市场",
      "",
      "Cursor | 支持 | 自动发现",
    ].join("\n");

    expect(normalizeReadingMarkdown(markdown)).toBe([
      "| 平台 | 状态 | 安装方式 |",
      "| --- | --- | --- |",
      "| Claude Code | 原生 | 插件市场 |",
      "| Cursor | 支持 | 自动发现 |",
    ].join("\n"));
  });

  it("leaves ambiguous pipe-separated prose unchanged", () => {
    const markdown = "方案 A | 方案 B\n速度优先 | 质量优先";
    expect(normalizeReadingMarkdown(markdown)).toBe(markdown);
  });

  it("normalizes heading jumps, list markers and surrounding blank lines", () => {
    const markdown = [
      "#总览",
      "这是一段说明。",
      "####处理步骤",
      "• 捕获资料",
      "2）生成笔记",
      "完成。",
    ].join("\n");

    expect(normalizeReadingMarkdown(markdown)).toBe([
      "# 总览",
      "",
      "这是一段说明。",
      "",
      "## 处理步骤",
      "",
      "- 捕获资料",
      "2. 生成笔记",
      "",
      "完成。",
    ].join("\n"));
  });

  it("keeps a technical hash that belongs to a heading name", () => {
    expect(normalizeReadingMarkdown("## C# 与 .NET")).toBe("## C# 与 .NET");
  });
});
