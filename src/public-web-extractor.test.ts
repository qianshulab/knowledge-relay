import { describe, expect, it } from "vitest";

import { extractWebContentFromHtml } from "./public-web-extractor.js";

describe("public web article extraction", () => {
  it("preserves Kanxue article images in their original body positions", () => {
    const html = `<!doctype html>
      <html><head>
        <meta property="og:title" content="看雪文章标题">
        <meta name="author" content="研究员">
      </head><body>
        <nav>站点导航</nav>
        <section class="message message_md_type">
          <h2>第一部分</h2>
          <p>${"正文内容".repeat(60)}</p>
          <img data-src="upload/attach/202607/example.png" alt="检测结果">
          <h2>第二部分</h2>
          <p>${"后续分析".repeat(30)}</p>
          <img src="/upload/attach/202607/second.jpg">
          <p>回复或点赞可查看完整内容</p>
        </section>
        <aside>相关文章</aside>
      </body></html>`;

    const result = extractWebContentFromHtml(html, "https://bbs.kanxue.com/thread-292208.htm");

    expect(result).toMatchObject({
      title: "看雪文章标题",
      author: "研究员",
      sourceType: "web",
    });
    expect(result?.markdown).toContain("第一部分");
    expect(result?.markdown).toContain("![检测结果](https://bbs.kanxue.com/upload/attach/202607/example.png)");
    expect(result?.markdown).toContain("![正文图片 2](https://bbs.kanxue.com/upload/attach/202607/second.jpg)");
    expect(result?.markdown).toContain("回复或点赞可查看完整内容");
    expect(result?.markdown.indexOf("第一部分")).toBeLessThan(result?.markdown.indexOf("检测结果") || 0);
    expect(result?.markdown.indexOf("检测结果")).toBeLessThan(result?.markdown.indexOf("第二部分") || 0);
    expect(result?.markdown).not.toContain("站点导航");
    expect(result?.markdown).not.toContain("相关文章");
  });

  it("does not mistake a navigation-only page for an article", () => {
    expect(extractWebContentFromHtml(
      "<html><body><main><a href='/a'>短链接</a></main></body></html>",
      "https://example.org/",
    )).toBeUndefined();
  });
});
