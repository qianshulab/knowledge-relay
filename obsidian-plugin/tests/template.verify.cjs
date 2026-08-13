const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MANAGED_START,
  MANAGED_END,
  applyCaptureTemplate,
  extractOriginalContent,
  extractRemoteId,
  normalizeItem,
  sanitizeMarkdown,
  updateManagedNote,
} = require("../src/template.cjs");

const template = `---
类型: 捕获
状态: 待处理
创建日期: "{{date}}"
来源: ""
tags:
  - 状态/待处理
敏感级别: 内部
---

# {{title}}

## 一句话说明


## 原始内容 / 链接


## 为什么值得保留


## 下一步

- [ ] 删除：没有持续价值
- [ ] 转为知识卡片

## 临时备注

我的手工备注
`;

const item = {
  id: "bot:message-1",
  messageId: "bot:message-1",
  revision: 2,
  version: "version-2",
  title: "值得收藏的文章",
  receivedAt: "2026-08-13T01:02:03.000Z",
  createdAt: "2026-08-13T01:02:03.000Z",
  updatedAt: "2026-08-13T02:02:03.000Z",
  summary: "这是一句话摘要。",
  contentMarkdown: "https://example.com/article\n\n这是一段经过清洗的原始内容。",
  reason: "可以作为后续研究资料。",
  suggestedAction: "research",
  source: { type: "web", name: "Example", url: "https://example.com/article" },
  tags: ["来源/一手"],
  sensitivity: "internal",
  processing: { status: "enriched", confidence: "medium", warnings: [] },
  attachments: [],
};

test("提取旧服务器笔记正文但排除 frontmatter 和附件清单", () => {
  const content = extractOriginalContent(`---\nmessage_id: old\n---\n\n# 标题\n\n正文\n\n## 附件\n\n- report.pdf\n`);
  assert.match(content, /正文/);
  assert.doesNotMatch(content, /message_id/);
  assert.doesNotMatch(content, /report\.pdf/);
});

test("基于快速捕获模板创建带稳定身份和托管区块的笔记", () => {
  const output = applyCaptureTemplate(template, item, ["- [[收件箱/附件/report.pdf|report.pdf]]"]);
  assert.match(output, /创建日期: "2026-08-13"/);
  assert.match(output, /远程ID: "bot:message-1"/);
  assert.match(output, /远程版本: "version-2"/);
  assert.match(output, new RegExp(MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(output, new RegExp(MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(output, /## 一句话说明\n\n这是一句话摘要/);
  assert.match(output, /为什么值得保留[\s\S]*后续研究资料/);
  assert.match(output, /建议方向：研究课题/);
  assert.match(output, /\[\[收件箱\/附件\/report\.pdf\|report\.pdf\]\]/);
  assert.equal(extractRemoteId(output), "bot:message-1");
});

test("同 ID 新版本只更新托管区块和允许的同步元数据", () => {
  const created = applyCaptureTemplate(template, item);
  const userEdited = created
    .replace("状态: 待处理", "状态: 正在处理")
    .replace("  - 状态/待处理", "  - 用户/自定义")
    .replace("我的手工备注", "用户已经写下的重要备注")
    .replace("- [ ] 转为知识卡片", "- [x] 转为知识卡片");
  const next = {
    ...item,
    version: "version-3",
    revision: 3,
    updatedAt: "2026-08-14T02:02:03.000Z",
    summary: "更新后的一句话摘要。",
    reason: "更新后的保留理由。",
  };
  const result = updateManagedNote(userEdited, next);
  assert.equal(result.updated, true);
  assert.equal(result.conflict, false);
  assert.match(result.content, /远程版本: "version-3"/);
  assert.match(result.content, /更新日期: 2026-08-14/);
  assert.match(result.content, /更新后的一句话摘要/);
  assert.match(result.content, /状态: 正在处理/);
  assert.match(result.content, /用户\/自定义/);
  assert.match(result.content, /用户已经写下的重要备注/);
  assert.match(result.content, /- \[x\] 转为知识卡片/);
});

test("没有托管标记的既有笔记进入冲突而不是整篇覆盖", () => {
  const result = updateManagedNote("# 用户自己的笔记\n\n不要覆盖", item);
  assert.equal(result.updated, false);
  assert.equal(result.conflict, true);
  assert.match(result.content, /不要覆盖/);
});

test("服务端路径、命令和脚本字段不会进入渲染数据", () => {
  const value = normalizeItem({ ...item, path: "/tmp/evil", command: "rm -rf", script: "alert(1)" });
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /\/tmp\/evil|rm -rf|alert\(1\)/);
});

test("外部 Markdown 不会执行脚本、深链或自动加载远程图片", () => {
  const input = `<script>alert(1)</script>\n<img src=https://tracker.example/pixel.png onerror=alert(2)>\n[点击](javascript:alert(3))\n![跟踪像素](https://tracker.example/pixel.png)\n![[私有笔记]]`;
  const output = sanitizeMarkdown(input);
  assert.doesNotMatch(output, /<script|onerror=|\]\(javascript:|!\[跟踪像素|!\[\[/i);
  assert.match(output, /外部图片/);
  assert.match(output, /已移除外部嵌入/);
});

test("同步项保留并规范化附件和删除语义", () => {
  const value = normalizeItem({
    ...item,
    deleted: true,
    attachments: [{ id: "file-1", fileName: "report\n|evil.md", mimeType: "text/markdown", size: 12, sha256: "A".repeat(64) }],
  });
  assert.equal(value.deleted, true);
  assert.deepEqual(value.attachments, [{
    id: "file-1",
    fileName: "report evil.md",
    mimeType: "text/markdown",
    size: 12,
    sha256: "a".repeat(64),
  }]);
});
