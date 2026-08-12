import { afterEach, describe, expect, it, vi } from "vitest";

import { IlinkApiError, IlinkClient } from "./client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IlinkClient", () => {
  it("按官方协议获取二维码且登录请求不携带 Bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ qrcode: "secret-key", qrcode_img_content: "qr-content" }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new IlinkClient({
      apiBaseUrl: "https://ilinkai.weixin.qq.com",
      botAgent: "WechatInbox/0.1.0",
    });

    const result = await client.fetchQrCode(["existing-token"]);

    expect(result.qrcode).toBe("secret-key");
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toContain("ilink/bot/get_bot_qrcode?bot_type=3");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect((init.headers as Record<string, string>)["iLink-App-Id"]).toBe("bot");
    const body = JSON.parse(String(init.body));
    expect(body.local_token_list).toEqual(["existing-token"]);
    expect(body.base_info.bot_agent).toBe("WechatInbox/0.1.0");
  });

  it("回复文本时带回收件消息的 context_token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ret: 0 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new IlinkClient({
      apiBaseUrl: "https://example.weixin.qq.com/base/",
      token: "bot-token",
      botAgent: "WechatInbox/0.1.0",
    });

    await client.sendText("user-1", "context-1", "处理完成");

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.weixin.qq.com/base/ilink/bot/sendmessage");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer bot-token");
    const body = JSON.parse(String(init.body));
    expect(body.msg.to_user_id).toBe("user-1");
    expect(body.msg.context_token).toBe("context-1");
    expect(body.msg.item_list[0].text_item.text).toBe("处理完成");
  });

  it("把 -14 响应识别为登录凭据失效", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ret: -14, errmsg: "stale token" }), { status: 200 }),
      ),
    );
    const client = new IlinkClient({
      apiBaseUrl: "https://ilinkai.weixin.qq.com",
      token: "expired-token",
      botAgent: "WechatInbox/0.1.0",
    });

    await expect(client.getUpdates("", 100)).rejects.toMatchObject({
      name: "IlinkApiError",
      ret: -14,
    } satisfies Partial<IlinkApiError>);
  });
});
