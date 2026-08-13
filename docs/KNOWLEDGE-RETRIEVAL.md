# 收件知识检索设计

## 目标

提供一个只能查找收件内容的助手，避免把通用 Agent、外部工具或写操作暴露到检索入口。

## 当前链路

1. 消息到达后立即保存原文与附件。
2. Nanobot 可用时提取标题、摘要、分类、领域、知识点和工具。
3. 知流将原文、整理笔记与结构化字段写入可跨平台运行的 SQLite 中英文词项索引。
4. 查询时只读取本地索引，按时间和结构化字段过滤并返回消息引用。
5. 查询接口不持有 Nanobot 客户端，不具备联网、命令、写入或删除能力。

## 为什么不持续训练模型

个人收件箱的新增内容应被“索引”，而不是用于持续训练底层模型。训练会带来难以回滚的隐私、成本和遗忘问题；索引可以重建、删除、审计并随原消息更新。

## 演进路线

当前版本采用零额外服务的 SQLite 全文索引与 AI 结构化元数据，适合个人单机部署。数据量进一步增长后，可在不改变只读边界的前提下加入本地向量嵌入，并采用：

- 关键词/稀疏检索召回精确名称；
- 向量检索召回语义相近内容；
- 元数据过滤限定时间、领域、工具和分类；
- 只对少量候选进行重排；
- 最终回答必须引用真实收件消息。

参考实现思路：

- [OpenAI Vector Stores](https://platform.openai.com/docs/api-reference/vector-stores-files)：文件在入库后分块、嵌入和索引，并支持 attributes 过滤。
- [Qdrant Hybrid Queries](https://qdrant.tech/documentation/search/hybrid-queries/)：组合 dense、sparse 与多阶段查询。
- [Qdrant Hybrid Search with Reranking](https://qdrant.tech/documentation/tutorials-basics/reranking-hybrid-search/)：先低成本召回，再对少量候选重排。
- [AnythingLLM](https://docs.anythingllm.com/)：以 workspace 隔离文档和检索上下文的本地知识库产品形态。
