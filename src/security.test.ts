import { describe, expect, it } from "vitest";

import { hashPassword, tokenHash, verifyPassword } from "./security.js";

describe("security", () => {
  it("使用带随机盐的密码哈希", () => {
    const first = hashPassword("strong-password");
    const second = hashPassword("strong-password");
    expect(first).not.toBe(second);
    expect(verifyPassword("strong-password", first)).toBe(true);
    expect(verifyPassword("wrong-password", first)).toBe(false);
  });

  it("不会把访问令牌原文作为数据库索引", () => {
    const token = "obsidian_super-secret";
    expect(tokenHash(token)).not.toContain(token);
    expect(tokenHash(token)).toHaveLength(64);
  });
});
