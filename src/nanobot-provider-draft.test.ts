import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotManager } from "./bot-manager.js";
import type { AppConfig } from "./config.js";
import type { AccountLoginManager } from "./ilink/account-login-manager.js";
import { NanobotClient } from "./nanobot.js";

const savedProviderSecret = ["saved", "deepseek", "secret"].join("-");
import { createServer } from "./server.js";
import { AppDatabase } from "./storage/database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ config: AppConfig; configText: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-provider-draft-"));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "nanobot", "config.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const configText = `${JSON.stringify({
    agents: { defaults: { provider: "deepseek", model: "deepseek-chat" } },
    providers: {
      deepseek: { apiKey: savedProviderSecret, apiBase: "https://api.deepseek.com" },
      openai: { apiKey: null, apiBase: "https://api.openai.com/v1" },
      anthropic: { apiKey: null, apiBase: "https://api.anthropic.com" },
    },
  }, null, 2)}\n`;
  await fs.writeFile(configPath, configText);
  return {
    configText,
    config: {
      host: "127.0.0.1",
      port: 8787,
      dataDir: directory,
      sessionDays: 30,
      ilink: { apiBaseUrl: "https://example.com", cdnBaseUrl: "https://example.com", appId: "bot", botAgent: "test", longPollMs: 1_000, maxMediaBytes: 1_024, allowFrom: [] },
      webhook: { timeoutMs: 1_000 },
      nanobot: { baseUrl: "http://127.0.0.1:8900/v1/", model: "", configPath, workspace: path.join(directory, "nanobot", "workspace"), managed: true, autoReload: true, timeoutMs: 1_000, processTimeoutMs: 900_000 },
      sync: { batchSize: 100 },
      autoAck: false,
      autoAckText: "ok",
      logLevel: "error",
    },
  };
}

describe("Nanobot provider draft test", () => {
  it("tests the form draft with a real text completion without changing active configuration", async () => {
    const { config, configText } = await fixture();
    const draftKey = "draft-provider-secret-value";
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(_input)).toBe("https://api.openai.com/v1/chat/completions");
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${draftKey}`);
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-test", stream: false });
      return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new NanobotClient(config).testProviderDraft({
      provider: "openai",
      model: "gpt-test",
      apiBase: "https://api.openai.com/v1",
      apiKey: draftKey,
    });

    expect(result).toMatchObject({
      ok: true,
      stage: "complete",
      provider: "openai",
      model: "gpt-test",
      usedSavedCredential: false,
      capabilities: {
        protocol: "openai-chat-completions",
        endpointReachable: true,
        authentication: true,
        textCompletion: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain(draftKey);
    await expect(fs.readFile(config.nanobot.configPath, "utf8")).resolves.toBe(configText);
  });

  it("can reuse an already saved provider credential without exposing it", async () => {
    const { config, configText } = await fixture();
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${savedProviderSecret}`);
      return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new NanobotClient(config).testProviderDraft({
      provider: "deepseek",
      model: "deepseek-chat",
      apiBase: "https://api.deepseek.com",
    });

    expect(result).toMatchObject({ ok: true, usedSavedCredential: true });
    expect(JSON.stringify(result)).not.toContain(savedProviderSecret);
    await expect(fs.readFile(config.nanobot.configPath, "utf8")).resolves.toBe(configText);
  });

  it("never forwards a saved credential when the draft API address changed", async () => {
    const { config, configText } = await fixture();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await new NanobotClient(config).testProviderDraft({
      provider: "deepseek",
      model: "deepseek-chat",
      apiBase: "https://compatible.example.com/v1",
    });

    expect(result).toMatchObject({
      ok: false,
      stage: "configuration",
      usedSavedCredential: false,
      error: "这个模型提供者需要 API Key",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fs.readFile(config.nanobot.configPath, "utf8")).resolves.toBe(configText);
  });

  it("classifies authentication errors and redacts credentials echoed by a provider", async () => {
    const { config } = await fixture();
    const draftKey = "draft-provider-secret-value";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { message: `invalid bearer ${draftKey}` },
    }), { status: 401 })));

    const result = await new NanobotClient(config).testProviderDraft({
      provider: "openai",
      model: "gpt-test",
      apiBase: "https://api.openai.com/v1",
      apiKey: draftKey,
    });

    expect(result).toMatchObject({
      ok: false,
      stage: "authentication",
      capabilities: { endpointReachable: true, authentication: false, textCompletion: false },
    });
    expect(result.suggestion).toContain("密钥");
    expect(JSON.stringify(result)).not.toContain(draftKey);
  });

  it("uses the Anthropic Messages protocol for Anthropic drafts", async () => {
    const { config } = await fixture();
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(_input)).toBe("https://api.anthropic.com/v1/messages");
      expect(init?.headers).toMatchObject({ "x-api-key": "anthropic-test-key", "anthropic-version": "2023-06-01" });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "连接成功" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new NanobotClient(config).testProviderDraft({
      provider: "anthropic",
      model: "claude-test",
      apiBase: "https://api.anthropic.com",
      apiKey: "anthropic-test-key",
    });

    expect(result).toMatchObject({ ok: true, capabilities: { protocol: "anthropic-messages", textCompletion: true } });
  });

  it("exposes an admin-only non-persistent provider test endpoint", async () => {
    const { config, configText } = await fixture();
    const database = await AppDatabase.open(config.dataDir);
    const owner = database.createOwner({ displayName: "Owner", password: "test-password" });
    const session = database.createSessionFor(owner.id, 30);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "连接成功" } }],
    }), { status: 200 })));
    const app = createServer(config, database, {} as BotManager, {} as AccountLoginManager);

    const response = await app.inject({
      method: "POST",
      url: "/api/nanobot/provider/test",
      headers: { Authorization: `Bearer ${session.token}` },
      payload: {
        provider: "openai",
        model: "gpt-test",
        apiBase: "https://api.openai.com/v1",
        apiKey: "endpoint-draft-secret",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(response.json()).toMatchObject({ ok: true, provider: "openai", model: "gpt-test" });
    expect(response.body).not.toContain("endpoint-draft-secret");
    await expect(fs.readFile(config.nanobot.configPath, "utf8")).resolves.toBe(configText);

    await app.close();
    database.close();
  });
});
