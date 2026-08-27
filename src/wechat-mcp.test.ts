import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AppDatabase } from "./storage/database.js";
import { WechatMcpClient } from "./wechat-mcp-client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

describe("微信助手 MCP 收件", () => {
  it("按 MCP 初始化、工具发现和结构化结果完成连接检查", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string; params?: { name?: string } };
      const result = request.method === "initialize"
        ? { protocolVersion: "2025-06-18", serverInfo: { name: "wechat-data-analysis-mcp", version: "1.0.0" } }
        : request.method === "tools/list"
          ? { tools: [
            { name: "wechat.core.list_accounts" },
            { name: "wechat.chat.list_sessions" },
            { name: "wechat.chat.get_messages" },
          ] }
          : request.params?.name === "wechat.core.list_accounts"
            ? { structuredContent: { accounts: [{ account: "primary" }] } }
            : { structuredContent: {} };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new WechatMcpClient("https://wechat.example.test/mcp", "secret-token").check();

    expect(result).toMatchObject({ ok: true, serverName: "wechat-data-analysis-mcp", toolCount: 3, accounts: ["primary"] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("加密保存系统凭据，并用一次性绑定码把微信联系人路由到指定用户", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-wechat-mcp-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    const owner = database.createOwner({ displayName: "Owner", password: "test-password" });
    const member = database.createUser({ username: "member", displayName: "Member", password: "member-password" });

    const source = database.saveWechatMcpSource({
      endpoint: "https://wechat.example.test/mcp",
      authorization: "Bearer encrypted-secret",
      displayName: "知流助手",
      account: "primary",
      pollIntervalSeconds: 8,
      enabled: true,
    });
    expect(source.authorizationConfigured).toBe(true);
    expect(JSON.stringify(source)).not.toContain("encrypted-secret");
    expect(database.getWechatMcpSourceSecret()?.authorization).toBe("Bearer encrypted-secret");

    const code = database.forTenant(member.id).createWechatMcpBindingCode();
    const binding = database.consumeWechatMcpBindingCode({
      code: code.code,
      sourceId: "default",
      account: "primary",
      wechatUsername: "wx-contact",
      wechatDisplayName: "微信用户",
    });

    expect(binding).toMatchObject({ tenantId: member.id, wechatDisplayName: "微信用户" });
    expect(database.forTenant(member.id).getWechatMcpBindingForTenant()).toMatchObject({ tenantId: member.id });
    expect(database.forTenant(owner.id).getWechatMcpBindingForTenant()).toBeUndefined();
    expect(database.consumeWechatMcpBindingCode({
      code: code.code,
      sourceId: "default",
      account: "primary",
      wechatUsername: "another-contact",
      wechatDisplayName: "其他用户",
    })).toBeUndefined();

    database.close();
  });
});
