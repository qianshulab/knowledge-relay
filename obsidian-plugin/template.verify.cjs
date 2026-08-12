const assert = require("node:assert/strict");
const test = require("node:test");

const { applyCaptureTemplate, extractOriginalContent } = require("./template.cjs");

const template = `---
类型: 捕获
状态: 待处理
创建日期: "{{date}}"
来源: ""
tags: [状态/待处理]
---

# {{title}}

## 一句话说明


## 原始内容 / 链接


## 为什么值得保留


## 下一步

- [ ] 删除：没有持续价值
`;

const item = {
  messageId: "bot:message-1",
  revision: 2,
  title: "值得收藏的文章",
  receivedAt: "2026-08-13T01:02:03.000Z",
  markdown: `---
title: "旧标题"
message_id: "bot:message-1"
---

# 旧标题

https://example.com/article

这是一段原始内容。

## 附件

- report.pdf
`,
};

test("提取服务器笔记正文但排除旧 frontmatter 和附件清单", () => {
  const content = extractOriginalContent(item.markdown);
  assert.match(content, /https:\/\/example\.com/);
  assert.doesNotMatch(content, /message_id/);
  assert.doesNotMatch(content, /report\.pdf/);
});

test("基于快速捕获模板生成笔记并保留同步身份", () => {
  const output = applyCaptureTemplate(template, item, ["- [[Inbox/附件/report.pdf|report.pdf]]"]);
  assert.match(output, /创建日期: "2026-08-13"/);
  assert.match(output, /# 值得收藏的文章/);
  assert.match(output, /## 一句话说明\n\n这是一段原始内容。/);
  assert.match(output, /## 原始内容 \/ 链接[\s\S]*这是一段原始内容/);
  assert.match(output, /知流消息ID: "bot:message-1"/);
  assert.match(output, /知流修订: 2/);
  assert.match(output, /来源: "https:\/\/example\.com\/article"/);
  assert.match(output, /\[\[Inbox\/附件\/report\.pdf\|report\.pdf\]\]/);
});
