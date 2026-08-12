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
        content: "整理最终版。",
        tasks: ["提交报告"],
      },
      message,
    );
    expect(note.tags).toContain("微信收件");
    expect(note.markdown).toContain("- [ ] 提交报告");
    expect(note.markdown).toContain('sender_id: "user-1"');
  });
});
