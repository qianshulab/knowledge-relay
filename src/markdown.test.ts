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
});
