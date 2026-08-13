import { describe, expect, it } from "vitest";

import { inferCaptureType, stableCaptureId, wechatCaptureSource } from "./capture.js";

describe("channel-neutral captures", () => {
  it("separates the transport channel from the content source", () => {
    expect(wechatCaptureSource(
      "message-1",
      "wechat-account-1",
      "https://mp.weixin.qq.com/s/example",
    )).toMatchObject({
      channel: "wechat",
      type: "wechat_article",
      externalId: "message-1",
      connectionId: "wechat-account-1",
      name: "微信公众号",
    });
  });

  it("creates stable cross-channel identities and capture types", () => {
    const source = {
      channel: "api" as const,
      type: "api" as const,
      externalId: "request-1",
      connectionId: "personal-api",
      name: "API 投稿",
    };
    expect(stableCaptureId(source)).toBe(stableCaptureId(source));
    expect(stableCaptureId(source)).toMatch(/^api:[a-f0-9]{32}$/);
    expect(inferCaptureType("https://example.com", [])).toBe("link");
    expect(inferCaptureType("图片说明", [{
      kind: "image",
      fileName: "image.png",
      path: "/tmp/image.png",
      size: 1,
      mimeType: "image/png",
    }])).toBe("mixed");
  });
});
