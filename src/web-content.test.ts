import { afterEach, describe, expect, it, vi } from "vitest";

import { extractUrls, isAllowedWebAddress, resolvePublicUrl } from "./web-content.js";

afterEach(() => vi.restoreAllMocks());

describe("safe web content adapter", () => {
  it("只提取 HTTP/HTTPS URL 并去重", () => {
    expect(extractUrls("看 https://example.com/a 和 https://example.com/a，再看 http://news.example/x。"))
      .toEqual(["https://example.com/a", "http://news.example/x"]);
  });

  it.each([
    "file:///etc/passwd",
    "http://user:pass@example.com/",
    "http://example.com:8080/",
  ])("拒绝高风险 URL：%s", async (url) => {
    await expect(resolvePublicUrl(url)).rejects.toThrow();
  });

  it("拒绝解析到本机、私网和链路本地的域名", async () => {
    for (const url of ["http://127.0.0.1/", "http://10.0.0.1/", "http://169.254.169.254/"]) {
      await expect(resolvePublicUrl(url)).rejects.toThrow("内网或保留地址");
    }
  });

  it("只有显式开启时才允许代理的 198.18/15 Fake-IP", async () => {
    expect(isAllowedWebAddress("198.18.3.136")).toBe(false);
    expect(isAllowedWebAddress("198.18.3.136", true)).toBe(true);
    expect(isAllowedWebAddress("198.19.255.255", true)).toBe(true);
    expect(isAllowedWebAddress("10.0.0.1", true)).toBe(false);
  });
});
