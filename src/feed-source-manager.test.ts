import { describe, expect, it } from "vitest";

import { parseFeed } from "./feed-source-manager.js";

describe("parseFeed", () => {
  it("解析 RSS 条目并清理 HTML 摘要", () => {
    const items = parseFeed(`<?xml version="1.0"?>
      <rss version="2.0"><channel><title>安全博客</title><item>
        <guid>post-1</guid><title>第一篇文章</title>
        <link>https://example.com/posts/1</link>
        <description><![CDATA[<p>正文 <strong>摘要</strong></p>]]></description>
        <pubDate>Sat, 30 Aug 2026 08:00:00 GMT</pubDate>
      </item></channel></rss>`, "https://example.com/feed.xml");
    expect(items).toEqual([expect.objectContaining({
      externalId: "post-1",
      title: "第一篇文章",
      url: "https://example.com/posts/1",
      excerpt: "正文 摘要",
      publishedAt: "2026-08-30T08:00:00.000Z",
    })]);
  });

  it("解析 Atom 相对链接并按 ID 去重", () => {
    const items = parseFeed(`<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry><id>tag:example,1</id><title>更新</title><link rel="alternate" href="/updates/1"/><summary>更新说明</summary></entry>
        <entry><id>tag:example,1</id><title>更新副本</title><link href="/updates/1"/></entry>
      </feed>`, "https://example.com/atom.xml");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ externalId: "tag:example,1", url: "https://example.com/updates/1" });
  });
});
