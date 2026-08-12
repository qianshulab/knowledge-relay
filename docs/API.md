# 同步 API

所有同步接口使用设备令牌：

```http
Authorization: Bearer obsidian_xxx
```

## 拉取稳定批次

```http
GET /api/sync/pull
```

返回：

```json
{
  "folder": "Inbox/微信",
  "batchId": "uuid",
  "fromCursor": 0,
  "nextCursor": 12,
  "hasMore": false,
  "items": [
    {
      "eventSeq": 12,
      "messageId": "bot-id:message-id",
      "revision": 1,
      "title": "笔记标题",
      "fileName": "笔记标题-ab12cd34.md",
      "markdown": "---\n...",
      "receivedAt": "2026-08-13T00:00:00.000Z",
      "attachments": []
    }
  ]
}
```

没有新数据时不创建批次，并省略 `batchId`。未确认批次会在重复拉取时原样返回。

## 下载附件

```http
GET /api/sync/attachments/:attachmentId
```

插件应对照批次里的 `sha256` 校验响应内容。

## 确认批次

仅在整个批次写入成功后调用：

```http
POST /api/sync/ack
Content-Type: application/json

{"batchId":"uuid"}
```

确认操作会原子推进当前设备的游标。批次不能跨设备确认，也不能确认两次。
