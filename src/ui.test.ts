import { describe, expect, it } from "vitest";

import { adminPage } from "./ui.js";

describe("adminPage", () => {
  it("内联管理脚本可以被浏览器正常解析", () => {
    const script = adminPage.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script || "")).not.toThrow();
  });

  it("个人版不再暴露注册或用户管理，并给手动刷新明确反馈", () => {
    expect(adminPage).not.toContain('data-auth="register"');
    expect(adminPage).not.toContain('data-page="users"');
    expect(adminPage).not.toContain("/api/admin/");
    expect(adminPage).toContain("刷新中…");
    expect(adminPage).toContain("收件箱已刷新，当前没有新消息。");
    expect(adminPage).toContain("history.pushState");
    expect(adminPage).toContain("pageFromLocation");
    expect(adminPage).toContain("/downloads/knowledge-relay-obsidian.zip");
    expect(adminPage).toContain("可执行适配器");
  });
});
