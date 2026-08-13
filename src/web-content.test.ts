import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AppConfig } from "./config.js";
import { persistExtractedMarkdown } from "./web-content.js";

describe("derived Markdown persistence", () => {
  it("同一消息中的多个无 URL 文档使用不同文件并保留各自内容", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-derived-"));
    const config = { dataDir } as AppConfig;
    try {
      const first = await persistExtractedMarkdown(config, "bot:document", {
        url: "",
        title: "报告 A",
        markdown: "# 报告 A\n",
        sourceType: "document",
      });
      const second = await persistExtractedMarkdown(config, "bot:document", {
        url: "",
        title: "报告 B",
        markdown: "# 报告 B\n",
        sourceType: "document",
      });
      expect(first.path).not.toBe(second.path);
      await expect(fs.readFile(first.path, "utf8")).resolves.toBe("# 报告 A\n");
      await expect(fs.readFile(second.path, "utf8")).resolves.toBe("# 报告 B\n");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
