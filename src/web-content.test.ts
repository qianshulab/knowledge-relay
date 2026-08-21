import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AppConfig } from "./config.js";
import { persistExtractedMarkdown, persistGeneratedVisualization } from "./web-content.js";

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

  it("不同租户的派生文档写入不同目录", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-derived-tenants-"));
    const config = { dataDir } as AppConfig;
    const content = {
      url: "https://example.com/article",
      title: "共享标题",
      markdown: "# 共享标题\n",
      sourceType: "web" as const,
    };
    try {
      const first = await persistExtractedMarkdown(config, "same-message", content, "tenant-a");
      const second = await persistExtractedMarkdown(config, "same-message", content, "tenant-b");
      expect(first.path).not.toBe(second.path);
      expect(first.path).toContain(`${path.sep}derived${path.sep}tenants${path.sep}`);
      await expect(fs.readFile(first.path, "utf8")).resolves.toBe(content.markdown);
      await expect(fs.readFile(second.path, "utf8")).resolves.toBe(content.markdown);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("校验并保存可由 Obsidian 继续编辑的 Canvas", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-canvas-"));
    const config = { dataDir } as AppConfig;
    const content = JSON.stringify({
      nodes: [
        { id: "root", type: "text", text: "主题", x: 0, y: 0, width: 240, height: 100 },
        { id: "child", type: "text", text: "子主题", x: 360, y: 0, width: 240, height: 100 },
      ],
      edges: [{ id: "edge-1", fromNode: "root", toNode: "child" }],
    });
    try {
      const attachment = await persistGeneratedVisualization(config, "canvas-message", {
        url: "",
        title: "知识结构",
        content,
        fileName: "knowledge.canvas",
        mimeType: "application/json",
        sourceType: "visualization",
      }, "tenant-canvas");
      expect(attachment.fileName).toMatch(/^知识结构-[a-f0-9]{8}\.canvas$/);
      expect(attachment.mimeType).toBe("application/json");
      await expect(fs.readFile(attachment.path, "utf8")).resolves.toBe(content);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("拒绝引用不存在节点的 Canvas 与伪造 Excalidraw", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-invalid-visual-"));
    const config = { dataDir } as AppConfig;
    try {
      await expect(persistGeneratedVisualization(config, "invalid-canvas", {
        url: "",
        title: "坏画布",
        content: JSON.stringify({
          nodes: [{ id: "root", type: "text", text: "主题", x: 0, y: 0, width: 240, height: 100 }],
          edges: [{ id: "edge-1", fromNode: "root", toNode: "missing" }],
        }),
        fileName: "bad.canvas",
        mimeType: "application/json",
        sourceType: "visualization",
      })).rejects.toThrow("不存在的节点");
      await expect(persistGeneratedVisualization(config, "invalid-excalidraw", {
        url: "",
        title: "坏图表",
        content: JSON.stringify({ elements: [] }),
        fileName: "bad.excalidraw",
        mimeType: "application/json",
        sourceType: "visualization",
      })).rejects.toThrow("结构无效");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
