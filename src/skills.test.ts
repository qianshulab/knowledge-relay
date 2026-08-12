import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppDatabase } from "./storage/database.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((item) => fs.rm(item, { recursive: true, force: true })));
});

async function ownerDatabase(): Promise<{ database: AppDatabase }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ilink-skills-test-"));
  directories.push(directory);
  const database = await AppDatabase.open(directory);
  database.createOwner({
    displayName: "First",
    password: "test-password",
  });
  return { database };
}

describe("Skills management", () => {
  it("默认展示并启用系统内置 Skills", async () => {
    const { database } = await ownerDatabase();
    const skills = database.listSkills();
    expect(skills.map((skill) => skill.slug)).toEqual(
      expect.arrayContaining([
        "inbox-router",
        "obsidian-note-builder",
        "wechat-article-ingest",
        "document-to-markdown",
        "wechat-article-extractor",
        "fetch-skill",
      ]),
    );
    expect(skills.every((skill) => skill.builtin && skill.enabled)).toBe(true);
    expect(skills.filter((skill) => skill.kind === "adapter")).toHaveLength(2);
    database.close();
  });

  it("允许修改或停用内置 Skill，并可恢复默认", async () => {
    const { database } = await ownerDatabase();
    const original = database.listSkills().find((skill) => skill.slug === "inbox-router")!;
    const changed = database.updateSkill(original.id, {
      name: original.name,
      description: original.description,
      content: "只保存明确任务。",
      enabled: false,
    });
    expect(changed.customized).toBe(true);
    expect(changed.enabled).toBe(false);
    expect(database.deleteOrResetSkill(changed.id)).toBe("reset");
    const restored = database.listSkills().find((skill) => skill.slug === "inbox-router")!;
    expect(restored.customized).toBe(false);
    expect(restored.enabled).toBe(true);
    expect(restored.content).toBe(original.content);
    database.close();
  });

  it("个人自定义 Skill 可以创建和删除", async () => {
    const { database } = await ownerDatabase();
    const skill = database.createSkill({
      slug: "receipt-parser",
      name: "票据整理",
      description: "提取票据内容",
      content: "提取商户、金额和日期。",
      enabled: true,
    });
    expect(database.listSkills().some((item) => item.id === skill.id)).toBe(true);
    expect(database.deleteOrResetSkill(skill.id)).toBe("deleted");
    expect(database.listSkills().some((item) => item.id === skill.id)).toBe(false);
    database.close();
  });
});
