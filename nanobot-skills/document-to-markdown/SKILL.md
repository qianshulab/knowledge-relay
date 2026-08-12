---
name: document-to-markdown
description: 将 PDF、Word、Excel、PowerPoint 或扫描文档的已提取内容整理为可读、可搜索的 Markdown 笔记。
---

# 文档转 Markdown

- 优先保留标题层级、列表、表格、脚注、代码、公式语义和页码引用。
- 扫描件或 OCR 结果不确定时标记 `[OCR 待核对]`，不要自行修补数字、姓名或金额。
- 表格较小时输出 Markdown 表格；过宽或复杂表格使用分节列表并保留原始附件引用。
- 输出包括：文档信息、简要摘要、核心内容、待办/决策、原始附件。
- 不将“适合 LLM 阅读的提取结果”描述成与原文件排版完全一致。
