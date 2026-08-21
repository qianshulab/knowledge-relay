import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AppConfig } from "./config.js";
import {
  assertSafeImageDimensions,
  imageDimensions,
  isPublicImageAddress,
  localizeMarkdownImages,
  pinnedImageLookup,
  sniffImageType,
  validateRemoteImageUrl,
} from "./web-assets.js";

const require = createRequire(import.meta.url);

describe("article image security", () => {
  it("按当前 Node 网络栈要求返回锁定地址列表", async () => {
    const lookup = pinnedImageLookup([
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]) as unknown as (
      hostname: string,
      options: { all: true },
      callback: (error: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: 4 | 6 }>) => void,
    ) => void;
    const addresses = await new Promise<Array<{ address: string; family: 4 | 6 }>>((resolve, reject) => {
      lookup("cdn.example", { all: true }, (error, values) => error ? reject(error) : resolve(values));
    });
    expect(addresses).toEqual([
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  it("拒绝私网、环回、链路本地和 IPv4 映射地址", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.8",
      "172.16.1.2",
      "192.168.1.2",
      "169.254.169.254",
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:127.0.0.1",
    ]) expect(isPublicImageAddress(address), address).toBe(false);
    expect(isPublicImageAddress("1.1.1.1")).toBe(true);
    expect(isPublicImageAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("只接受不带凭据的标准网页图片 URL", () => {
    expect(validateRemoteImageUrl("https://mmbiz.qpic.cn/example.jpg").hostname).toBe("mmbiz.qpic.cn");
    expect(() => validateRemoteImageUrl("file:///etc/passwd")).toThrow();
    expect(() => validateRemoteImageUrl("https://user:secret@example.com/image.png")).toThrow();
    expect(() => validateRemoteImageUrl("http://localhost/image.png")).toThrow();
    expect(() => validateRemoteImageUrl("https://example.com:8443/image.png")).toThrow();
  });

  it("根据文件魔数识别安全的栅格图片并拒绝伪装 HTML/SVG", () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0x00]))?.mimeType).toBe("image/jpeg");
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.mimeType).toBe("image/png");
    expect(sniffImageType(Buffer.from("GIF89a......"))?.mimeType).toBe("image/gif");
    expect(sniffImageType(Buffer.from("<svg onload=alert(1)></svg>"))).toBeUndefined();
    expect(sniffImageType(Buffer.from("<html>not an image</html>"))).toBeUndefined();
  });

  it("拒绝可能造成浏览器解码压力的超大像素图片", () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(20_000, 16);
    png.writeUInt32BE(20_000, 20);
    expect(imageDimensions(png, "image/png")).toEqual({ width: 20_000, height: 20_000 });
    expect(() => assertSafeImageDimensions(png, "image/png")).toThrow("像素尺寸");
  });

  it("没有远程图片时不触发网络并保持 Markdown 原样", async () => {
    await expect(localizeMarkdownImages({} as never, "# 标题\n\n正文", "tenant-a"))
      .resolves.toEqual({ markdown: "# 标题\n\n正文", images: [], warnings: [] });
  });

  it("把正文图片按内容哈希本地化并在单张失败时保留整篇", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-images-"));
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    try {
      const source = "正文前\n\n![架构图](https://cdn.example/ok.png)\n\n![失效图](https://cdn.example/fail.png)\n\n正文后";
      const result = await localizeMarkdownImages(
        { dataDir } as AppConfig,
        source,
        "tenant-a",
        async (url) => {
          if (url.pathname.includes("fail")) throw new Error("offline");
          return png;
        },
      );
      expect(result.images).toHaveLength(1);
      expect(result.images[0]?.mimeType).toBe("image/png");
      expect(result.markdown).toMatch(/!\[架构图\]\(attachment:\/\/[a-f0-9]{64}\)/);
      expect(result.markdown).toContain("[图片未保存：失效图](https://cdn.example/fail.png)");
      expect(result.markdown).toMatch(/^正文前[\s\S]*正文后$/);
      expect(result.warnings).toEqual(["1 张文章图片未能缓存（网络连接失败），正文已保留并提供原始图片链接。"]);
      await expect(fs.readFile(result.images[0]!.path)).resolves.toEqual(png);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("WeChat image Markdown", () => {
  it("保留正文图片语义和文章封面", () => {
    const skillRoot = path.join(process.cwd(), "data", "nanobot", "workspace", "skills", "wechat-article-extractor");
    const { markdownFromHtml } = require("../nanobot/extract-wechat-isolated.cjs") as {
      markdownFromHtml: (html: string, root: string) => string;
    };
    const { articleMarkdown } = require("../nanobot/run-wechat-extractor.cjs") as {
      articleMarkdown: (data: Record<string, string>, url: string) => string;
    };
    const body = markdownFromHtml('<p>正文</p><img data-src="//mmbiz.qpic.cn/body.jpg" alt="流程图">', skillRoot);
    expect(body).toContain("![流程图](https://mmbiz.qpic.cn/body.jpg)");
    const article = articleMarkdown({
      msg_title: "测试文章",
      msg_cover: "//mmbiz.qpic.cn/cover.jpg",
      msg_markdown: body,
    }, "https://mp.weixin.qq.com/s/example");
    expect(article).toContain("![测试文章封面](https://mmbiz.qpic.cn/cover.jpg)");
    expect(article.indexOf("封面")).toBeLessThan(article.indexOf("流程图"));
  });
});
