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
});
