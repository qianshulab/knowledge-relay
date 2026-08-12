---
name: obsidian-note-builder
description: 把微信文字、网页摘要、附件结果整理为简洁的 Obsidian Markdown，保留任务、来源和可检索结构。
---

# Obsidian 笔记生成

- 正文优先使用短段落和有意义的小标题，不为了格式而增加空洞章节。
- 任务使用 `- [ ]`；引用使用 `>`；代码使用带语言标识的围栏。
- 保留原始 URL，不生成不存在的双链，不猜测 Vault 中已有笔记名称。
- 日期采用 `YYYY-MM-DD`；不确定的日期保留原话并说明不确定，不擅自换算。
- 摘要应能让用户不打开原文就判断是否值得进一步阅读，但不得虚构未读取内容。
- 已有调用方提供的 frontmatter、message_id、sender_id 和 received_at 不得删除或改写。
