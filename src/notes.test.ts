import { describe, expect, it } from "vitest";

import { defaultNote, normalizeAgentNote } from "./notes.js";

const message = {
  id: "bot-1:1",
  senderId: "user-1",
  botId: "bot-1",
  receivedAt: "2026-08-13T00:00:00.000Z",
  text: "待办：明天提交报告",
  attachments: [],
};

describe("note generation", () => {
  it("内置规则生成带稳定来源字段的 Obsidian Markdown", () => {
    const note = defaultNote(message);
    expect(note.category).toBe("task");
    expect(note.markdown).toContain('message_id: "bot-1:1"');
    expect(note.markdown).toContain("# 待办：明天提交报告");
  });

  it("清洗 Agent 返回并保留原始身份元数据", () => {
    const note = normalizeAgentNote(
      {
        title: "提交报告",
        category: "task",
        tags: ["工作"],
        summary: "这是一条包含明确交付时间的任务。",
        knowledge_points: ["时间管理", "交付节点"],
        domains: ["项目管理"],
        tools: ["Obsidian"],
        reason: "需要按时完成并保留上下文。",
        suggestedAction: "project",
        sensitivity: "internal",
        confidence: "medium",
        warnings: [],
      },
      message,
    );
    expect(note.tags).toContain("微信收件");
    expect(note.knowledgePoints).toEqual(["时间管理", "交付节点"]);
    expect(note.domains).toEqual(["项目管理"]);
    expect(note.tools).toEqual(["Obsidian"]);
    expect(note.markdown).toContain("knowledge_points:");
    expect(note.markdown).toContain('  - "Obsidian"');
    expect(note.markdown).toContain("待办：明天提交报告");
    expect(note.markdown).toContain("建议方向：项目");
    expect(note.markdown).toContain("为什么值得保留");
    expect(note.markdown).toContain('sender_id: "user-1"');
  });

  it("拒绝 Agent 越权返回路径或可执行字段", () => {
    expect(() => normalizeAgentNote({ title: "越权", path: "/tmp/output" }, message))
      .toThrow("不允许的字段");
  });

  it("拒绝模型自造分类并回退到确定性分类", () => {
    const note = normalizeAgentNote({ title: "报告", category: "urgent-secret", tags: [] }, message);
    expect(note.category).toBe("task");
    expect(note.markdown).toContain('category: "task"');
  });

  it("不把定义和摘要整句当作知识点", () => {
    const note = normalizeAgentNote({
      title: "红队框架",
      category: "reference",
      knowledge_points: [
        "Agentic Red Teaming（自主红队）：由 AI 智能体自动执行攻击链各阶段。",
        "Neo4j 知识图谱用于攻击面建模并支持自然语言查询",
      ],
    }, message);

    expect(note.knowledgePoints).toEqual([
      "Agentic Red Teaming(自主红队)",
      "Neo4j 知识图谱",
    ]);
  });

  it("把模型逐行返回的行内代码恢复为 fenced Markdown 代码块", () => {
    const note = normalizeAgentNote({
      title: "Frida 脚本",
      category: "reference",
      details_markdown: [
        "## 示例",
        "",
        "`function hookDlopen() {`",
        "",
        "`  const name = \"android_dlopen_ext\";`",
        "",
        "`  console.log(name);`",
        "",
        "`}`",
      ].join("\n"),
    }, message);

    expect(note.detailsMarkdown).toContain("```javascript\nfunction hookDlopen() {");
    expect(note.detailsMarkdown).toContain("console.log(name);\n}\n```");
    expect(note.markdown).toContain("```javascript");
  });

  it("在写入笔记前统一整理模型生成的标题、列表和可靠表格", () => {
    const note = normalizeAgentNote({
      title: "兼容性说明",
      category: "reference",
      details_markdown: [
        "###支持情况",
        "平台 | 状态 | 安装方式",
        "",
        "Claude Code | 原生 | 插件市场",
        "",
        "Cursor | 支持 | 自动发现",
        "• 支持后续更新",
      ].join("\n"),
    }, message);

    expect(note.detailsMarkdown).toContain("### 支持情况");
    expect(note.detailsMarkdown).toContain("| --- | --- | --- |");
    expect(note.detailsMarkdown).toContain("- 支持后续更新");
    expect(note.markdown).toContain("| Claude Code | 原生 | 插件市场 |");
  });

  it("保存原始正文时也修复被拆散的配置代码，但不重写中文说明", () => {
    const sourceMessage = {
      ...message,
      text: [
        "配置说明保持原意。",
        "",
        "`server {`",
        "",
        "`  listen 8080;`",
        "",
        "`  location / {`",
        "",
        "`    proxy_pass http://backend;`",
        "",
        "`  }`",
        "",
        "`}`",
      ].join("\n"),
    };
    const note = defaultNote(sourceMessage);

    expect(note.markdown).toContain("配置说明保持原意。");
    expect(note.markdown).toContain("```nginx\nserver {\n  listen 8080;");
  });
});
