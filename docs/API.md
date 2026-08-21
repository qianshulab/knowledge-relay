# 知流同步协议 1.2

协议面向一个已经绑定用户与 Obsidian 连接的设备令牌。服务端保存权威事件流、批次和游标；插件保存远程 ID 到本地笔记的索引。客户端不能自行提交租户、collectionId 或游标，因此无法读取或推进其他用户的连接。

所有请求使用：

```http
Authorization: Bearer obsidian_xxx
X-Knowledge-Relay-Plugin: 1.4.1
X-Knowledge-Relay-Schema: 1.2
```

管理页面使用 HttpOnly 登录会话，不使用 Obsidian 设备令牌。与收件浏览和检索相关的接口如下。

## 管理端收件分页

```http
GET /api/messages?limit=10&before=123&active=1&format=wechat_article&domain=人工智能
```

`limit` 范围为 1–50，默认 10；`before` 是上一页最后一条消息的 `seq`。`active=1` 返回未归档内容，`state=archived` 返回归档内容。`format` 可选 `wechat_article`、`web_article`、`document`、`image`、`audio`、`video`、`mixed`、`text`；`domain` 与 `category` 分别用于动态主题和 AI 用途筛选。响应中的 `pagination.nextBefore` 只能在 `hasMore=true` 时用于下一页：

```json
{
  "messages": [],
  "pagination": { "limit": 10, "total": 38, "hasMore": true, "nextBefore": 103 }
}
```

资源详情支持用户主动管理与重新处理：

```http
POST /api/messages/:id/reprocess
DELETE /api/messages/:id
PATCH /api/messages/:id/library
Content-Type: application/json

{"state":"archived","read":true}

GET /api/messages/:id/diagram
POST /api/messages/:id/diagram
Content-Type: application/json

{"force":false}

GET /api/knowledge/map
```

归档是可恢复状态；`DELETE /api/messages/:id` 是永久删除，会同时清除原始消息、AI 整理、智能图解和关联附件。

资源智能图解采用按需生成：`GET /api/messages/:id/diagram` 只读取已保存结果，不触发模型；首次 `POST` 生成并保存，后续请求复用。仅在显式传入 `force=true` 时重新生成。内容修订变化后缓存自动失效。`GET /api/knowledge/map` 返回当前用户已持久化的高频领域、知识点和工具关系概览，不触发模型。

## API 收件

登录后可通过 `POST /api/me/api-tokens` 创建用户级令牌。令牌明文只在创建响应中出现一次；列表接口只返回名称、时间和状态。撤销使用 `DELETE /api/me/api-tokens/:id`。

外部应用使用该令牌提交 URL 或文本：

```http
POST /api/captures
Authorization: Bearer capture_xxx
Content-Type: application/json

{
  "externalId": "bookmark-2026-001",
  "url": "https://example.com/article",
  "text": "稍后整理",
  "sourceName": "Browser Extension"
}
```

至少提供 `url` 或 `text`。`url` 仅接受 HTTP(S)；`externalId` 在当前令牌的数据域内用于幂等。服务端在原文入库后返回 `202`，整理异步执行；API、微信与后续接入通道共用同一套解析、索引和输出流程。

## 用户管理

管理员使用 `GET /api/admin/users` 查看工作区，使用 `POST /api/admin/invitations` 生成一次性邀请。`PUT /api/admin/users/:id/status` 可停用或恢复成员；停用后该用户的登录会话、API 收件令牌和 Obsidian 同步令牌均不再通过鉴权，微信轮询同时停止，已有数据继续保留。`DELETE /api/admin/users/:id` 必须在请求体提交完全一致的 `confirmation` 用户名；确认后永久删除该成员的数据、附件和 Runtime 工作区，管理员不能删除自己。

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

`filters` 可使用 `category`、`domain`、`knowledgePoint` 和 `tool`。模型可用时，Nanobot 先把问题转换为受限的检索计划，响应为 `mode=nanobot_planned_search` 并在 `interpretation` 返回简短意图；服务端随后只在本地索引执行匹配。模型不可用时响应为 `mode=indexed_inbox_search`。两种模式都固定包含 `scope=inbox_only` 与 `readOnly=true`。

## 拉取稳定批次

```http
GET /api/sync/pull?limit=50
```

`limit` 范围为 1–100，并受服务端批次上限约束。响应示例：

```json
{
  "schemaVersion": "1.2",
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
    "captureType": "link",
    "originalText": "https://...",
    "summary": "一句话说明",
    "keyPoints": ["关键事实一", "关键事实二"],
    "detailsMarkdown": "进一步整理的 Markdown",
    "contentMarkdown": "兼容旧插件的正文",
    "reason": "保留价值",
    "suggestedAction": "research",
    "source": { "type": "web", "name": "mp.weixin.qq.com", "url": "https://..." },
    "tags": ["微信收件"],
    "sensitivity": "internal",
    "deleted": false,
    "processing": {
      "processor": "nanobot",
      "status": "enriched",
      "pipelineVersion": "knowledge-relay-inbox-v2",
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

原始消息入库后会保留 `processing.status=pending` 修订用于恢复与审计，但同步批次只会返回 Nanobot 完成或降级后同一 ID 的 `enriched` / `fallback` 最终修订，避免客户端先用临时标题创建笔记。没有新数据时不创建批次，并省略 `batchId`/`syncId`；未确认批次会原样重放。

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
  "schemaVersion": "1.2",
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

{"schemaVersion":"1.2"}
```

仅重置当前令牌绑定连接的服务端游标，并删除未确认批次。插件保留本地远程 ID 索引，因此历史重放不会创建副本。插件 UI 对此操作要求两次确认。

## 兼容性

- 插件 1.4 优先请求协议 1.2，同时接受 1.0 和 1.1，并能读取旧字段 `messageId`、`markdown`、`receivedAt`。
- 未发送 `X-Knowledge-Relay-Schema: 1.2` 的旧插件继续收到 1.1 版本标识；服务端仍保留旧字段供过渡。
- 旧笔记可通过 `知流消息ID` 重新索引；没有托管标记的笔记不会被自动覆盖。
