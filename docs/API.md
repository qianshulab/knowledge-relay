# 知流同步协议 1.1

协议面向一个已经绑定 Obsidian 连接的设备令牌。服务端保存权威事件流、批次和游标；插件保存远程 ID 到本地笔记的索引。这个设计比让客户端自行提交任意 collectionId/cursor 更适合个人版，也避免伪造其他集合位置。

所有请求使用：

```http
Authorization: Bearer obsidian_xxx
```

管理页面使用 HttpOnly 登录会话，不使用 Obsidian 设备令牌。与收件浏览和检索相关的接口如下。

## 管理端收件分页

```http
GET /api/messages?limit=20&before=123
```

`limit` 范围为 1–50，默认 20；`before` 是上一页最后一条消息的 `seq`。响应中的 `pagination.nextBefore` 只能在 `hasMore=true` 时用于下一页：

```json
{
  "messages": [],
  "pagination": { "limit": 20, "hasMore": true, "nextBefore": 103 }
}
```

## 知识聚合与只读检索

```http
GET /api/knowledge/facets
POST /api/inbox/query
Content-Type: application/json

{
  "question": "我之前收藏过哪些移动安全工具？",
  "filters": { "domain": "网络安全" }
}
```

`filters` 可使用 `category`、`domain`、`knowledgePoint` 和 `tool`。响应固定包含 `mode=indexed_inbox_search`、`scope=inbox_only` 与 `readOnly=true`。该接口只查询本地收件索引，不调用 Nanobot，不联网，也没有命令、写入或删除能力。

## 拉取稳定批次

```http
GET /api/sync/pull?limit=50
```

`limit` 范围为 1–100，并受服务端批次上限约束。响应示例：

```json
{
  "schemaVersion": "1.1",
  "collectionId": "token-bound-target-id",
  "syncId": "batch-uuid",
  "batchId": "batch-uuid",
  "fromCursor": 12,
  "nextCursor": 18,
  "hasMore": false,
  "serverTime": "2026-08-13T06:00:00.000Z",
  "folder": "Inbox/微信",
  "items": [{
    "id": "bot-id:message-id",
    "version": "sha256-of-materialized-content",
    "revision": 2,
    "title": "笔记标题",
    "summary": "一句话说明",
    "contentMarkdown": "原始内容",
    "reason": "保留价值",
    "suggestedAction": "research",
    "source": { "type": "web", "name": "mp.weixin.qq.com", "url": "https://..." },
    "tags": ["微信收件"],
    "sensitivity": "internal",
    "deleted": false,
    "processing": {
      "processor": "nanobot",
      "status": "enriched",
      "pipelineVersion": "knowledge-relay-inbox-v1",
      "processedAt": "2026-08-13T06:00:00.000Z",
      "confidence": "medium",
      "warnings": []
    },
    "attachments": [{
      "id": "attachment-uuid",
      "fileName": "article.md",
      "mimeType": "text/markdown",
      "size": 1200,
      "sha256": "..."
    }]
  }]
}
```

`id` 是永久远程身份；`version` 是服务端根据物化内容、处理状态和附件校验和生成的确定性哈希。相同 ID、相同 version 必须视为幂等无变化；相同 ID、新 version 更新既有笔记的托管区块。

原始消息通常先以 `processing.status=pending` 发布。Nanobot 完成或降级后，服务端发布同一 ID 的 `enriched` 或 `fallback` 新版本。没有新数据时不创建批次，并省略 `batchId`/`syncId`；未确认批次会原样重放。

## 下载附件

```http
GET /api/sync/attachments/:attachmentId
```

附件只能由拥有该消息的有效设备令牌读取。插件必须核对响应的 SHA-256；任一附件失败时不确认该批。

## 确认批次

```http
POST /api/sync/ack
Content-Type: application/json

{
  "schemaVersion": "1.1",
  "syncId": "batch-uuid",
  "batchId": "batch-uuid",
  "results": [{
    "id": "bot-id:message-id",
    "version": "...",
    "result": "created",
    "localReference": "random-installation-local-id"
  }]
}
```

服务端以令牌绑定的 target 校验批次，原子推进游标。重复确认同一批次返回相同 cursor，不产生副作用。`results` 用于客户端诊断兼容；服务端不接受 Vault 路径、正文或本地操作指令。

## 重置游标

```http
POST /api/sync/reset
Content-Type: application/json

{"schemaVersion":"1.1"}
```

仅重置当前令牌绑定连接的服务端游标，并删除未确认批次。插件保留本地远程 ID 索引，因此历史重放不会创建副本。插件 UI 对此操作要求两次确认。

## 兼容性

- 插件 1.3 接受协议 1.0 和 1.1，并能读取旧字段 `messageId`、`markdown`、`receivedAt`。
- 服务端继续返回旧字段，便于旧插件过渡。
- 旧笔记可通过 `知流消息ID` 重新索引；没有托管标记的笔记不会被自动覆盖。
