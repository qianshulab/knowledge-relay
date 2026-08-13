import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.js";
import {
  getNanobotProviderModels,
  getNanobotProviderSettings,
  saveNanobotProviderSettings,
} from "./nanobot-config.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((item) => fs.rm(item, { recursive: true, force: true })));
});

async function fixture(): Promise<AppConfig> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nanobot-config-test-"));
  directories.push(directory);
  const configPath = path.join(directory, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    agents: { defaults: { provider: "deepseek", model: "deepseek-chat", modelPreset: null } },
    providers: {
      deepseek: { apiKey: "${DEEPSEEK_API_KEY}", apiBase: "https://api.deepseek.com" },
      openai: { apiKey: null, apiBase: null },
    },
  }));
  return {
    host: "127.0.0.1",
    port: 8787,
    dataDir: directory,
    sessionDays: 30,
    ilink: { apiBaseUrl: "https://example.com", cdnBaseUrl: "https://example.com", appId: "bot", botAgent: "test", longPollMs: 1_000, maxMediaBytes: 1_000, allowFrom: [] },
    webhook: { timeoutMs: 1_000 },
    nanobot: { baseUrl: "http://127.0.0.1:8900/v1/", model: "", configPath, workspace: path.join(directory, "workspace"), managed: true, autoReload: true, timeoutMs: 30_000 },
    sync: { batchSize: 100 },
    autoAck: false,
    autoAckText: "ok",
    logLevel: "error",
  };
}

describe("Nanobot provider configuration", () => {
  it("只返回密钥是否存在，不返回密钥内容", async () => {
    const config = await fixture();
    const settings = await getNanobotProviderSettings(config);
    expect(settings.active).toMatchObject({ provider: "deepseek", model: "deepseek-chat", apiKeyConfigured: true });
    expect(JSON.stringify(settings)).not.toContain("DEEPSEEK_API_KEY");
    expect(settings.providers.some((item) => item.id === "openai_codex" && item.auth === "oauth")).toBe(true);
  });

  it("切换提供者时写入 Nanobot 配置并保留旧提供者密钥", async () => {
    const config = await fixture();
    await saveNanobotProviderSettings(config, {
      provider: "openai",
      model: "gpt-5.4-mini",
      apiBase: "https://api.openai.com/v1",
      apiKey: "test-key-not-real",
    });
    const raw = JSON.parse(await fs.readFile(config.nanobot.configPath, "utf8"));
    expect(raw.agents.defaults).toMatchObject({ provider: "openai", model: "gpt-5.4-mini", modelPreset: null });
    expect(raw.providers.openai.apiKey).toBe("test-key-not-real");
    expect(raw.providers.deepseek.apiKey).toBe("${DEEPSEEK_API_KEY}");
  });

  it("拒绝在线提供者使用明文 HTTP", async () => {
    const config = await fixture();
    await expect(saveNanobotProviderSettings(config, {
      provider: "openai",
      model: "gpt-test",
      apiBase: "http://example.com/v1",
      apiKey: "test-key-not-real",
    })).rejects.toThrow("必须使用 HTTPS");
  });

  it("通过 Nanobot 内部目录读取实时模型且不接触提供者密钥", async () => {
    const config = await fixture();
    config.nanobot.apiKey = "runtime-token";
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:8901/models?provider=deepseek");
      expect(init?.headers).toEqual({ Authorization: "Bearer runtime-token" });
      return new Response(JSON.stringify({
        provider: "deepseek",
        status: "available",
        models: [
          { id: "deepseek-chat", owned_by: "DeepSeek", context_window: 128_000 },
          { id: "deepseek-reasoner", label: "Reasoner" },
        ],
        model_count: 2,
        fetched_at: 123,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getNanobotProviderModels(config, "deepseek");
    expect(result).toMatchObject({
      provider: "deepseek",
      status: "available",
      modelCount: 2,
      models: [
        { id: "deepseek-chat", ownedBy: "DeepSeek", contextWindow: 128_000 },
        { id: "deepseek-reasoner", label: "Reasoner" },
      ],
    });
  });
});
