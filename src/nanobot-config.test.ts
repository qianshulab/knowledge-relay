import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.js";
import {
  getNanobotProviderModels,
  getNanobotProviderSettings,
  saveNanobotProviderSettings,
} from "./nanobot-config.js";

const directories: string[] = [];
const execFileAsync = promisify(execFile);

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
    nanobot: { baseUrl: "http://127.0.0.1:8900/v1/", model: "", configPath, workspace: path.join(directory, "workspace"), managed: true, autoReload: true, timeoutMs: 30_000, processTimeoutMs: 900_000 },
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
    expect(settings.active).toMatchObject({ provider: "deepseek", model: "deepseek-chat", apiKeyConfigured: false });
    expect(JSON.stringify(settings)).not.toContain("DEEPSEEK_API_KEY");
    expect(settings.providers.some((item) => item.id === "openai_codex" && item.auth === "oauth")).toBe(true);
    expect(settings.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "kimi_coding",
        name: "Kimi Code（会员 API）",
        defaultModel: "kimi-for-coding",
        defaultBaseUrl: "https://api.kimi.com/coding/v1",
      }),
      expect.objectContaining({ id: "moonshot", name: "Moonshot 开放平台" }),
    ]));
  });

  it("只在 Nanobot 配置中存在真实凭据时显示已配置", async () => {
    const config = await fixture();
    const raw = JSON.parse(await fs.readFile(config.nanobot.configPath, "utf8"));
    raw.providers.deepseek.apiKey = "test-key-not-real";
    await fs.writeFile(config.nanobot.configPath, JSON.stringify(raw));
    const settings = await getNanobotProviderSettings(config);
    expect(settings.active.apiKeyConfigured).toBe(true);
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

  it("允许无密钥或带密钥的本地 OpenAI 兼容接口", async () => {
    const config = await fixture();
    await saveNanobotProviderSettings(config, {
      provider: "custom",
      model: "local-model",
      apiBase: "http://192.168.100.141:8000/v1",
    });
    const raw = JSON.parse(await fs.readFile(config.nanobot.configPath, "utf8"));
    expect(raw.agents.defaults).toMatchObject({ provider: "custom", model: "local-model" });
    expect(raw.providers.custom).toEqual({ apiKey: null, apiBase: "http://192.168.100.141:8000/v1" });
    const settings = await getNanobotProviderSettings(config);
    expect(settings.active).toMatchObject({ provider: "custom", apiKeyConfigured: false, auth: "optional_key" });
  });

  it("将 Kimi Code 保存到 Nanobot 原生 kimi_coding 提供者", async () => {
    const config = await fixture();
    await saveNanobotProviderSettings(config, {
      provider: "kimi_coding",
      model: "kimi-for-coding",
      apiBase: "https://api.kimi.com/coding/v1",
      apiKey: "sk-kimi-test",
    });
    const raw = JSON.parse(await fs.readFile(config.nanobot.configPath, "utf8"));
    expect(raw.agents.defaults).toMatchObject({ provider: "kimi_coding", model: "kimi-for-coding" });
    expect(raw.providers.kimiCoding).toEqual({
      apiKey: "sk-kimi-test",
      apiBase: "https://api.kimi.com/coding/v1",
    });
    expect(raw.providers.moonshot).toBeUndefined();
  });

  it("拒绝把 Kimi Code 凭据误存到 Moonshot 开放平台", async () => {
    const config = await fixture();
    await expect(saveNanobotProviderSettings(config, {
      provider: "moonshot",
      model: "kimi-k2.5",
      apiBase: "https://api.moonshot.ai/v1",
      apiKey: "sk-kimi-test",
    })).rejects.toThrow("属于 Kimi Code");
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

  it("专用 Runtime 停用与收件无关的 Nanobot 通用 Skills", async () => {
    const config = await fixture();
    await execFileAsync(process.execPath, [
      path.resolve("scripts/harden-nanobot-config.mjs"),
      config.nanobot.configPath,
    ], { env: { ...process.env, DEEPSEEK_API_KEY: "" } });
    const raw = JSON.parse(await fs.readFile(config.nanobot.configPath, "utf8"));
    expect(raw.agents.defaults.disabledSkills).toEqual(expect.arrayContaining([
      "clawhub",
      "cron",
      "github",
      "image-generation",
      "skill-creator",
      "summarize",
      "tmux",
      "weather",
    ]));
    expect(raw.agents.defaults.provider).toBe("deepseek");
    expect(raw.providers.deepseek.apiKey).toBe("__KNOWLEDGE_RELAY_PROVIDER_NOT_CONFIGURED__");
  });

  it("启动时把旧版 Moonshot 中的 Kimi Code 配置迁移到原生提供者", async () => {
    const config = await fixture();
    const raw = JSON.parse(await fs.readFile(config.nanobot.configPath, "utf8"));
    raw.agents.defaults.provider = "moonshot";
    raw.agents.defaults.model = "kimi-k2.5";
    raw.providers.moonshot = {
      apiKey: "sk-kimi-legacy",
      apiBase: "https://api.kimi.com/coding/v1",
    };
    await fs.writeFile(config.nanobot.configPath, JSON.stringify(raw));

    await execFileAsync(process.execPath, [
      path.resolve("scripts/harden-nanobot-config.mjs"),
      config.nanobot.configPath,
    ], { env: { ...process.env, DEEPSEEK_API_KEY: "" } });

    const migrated = JSON.parse(await fs.readFile(config.nanobot.configPath, "utf8"));
    expect(migrated.agents.defaults).toMatchObject({
      provider: "kimi_coding",
      model: "kimi-for-coding",
    });
    expect(migrated.providers.kimiCoding).toMatchObject({
      apiKey: "sk-kimi-legacy",
      apiBase: "https://api.kimi.com/coding/v1",
    });
    expect(migrated.providers.moonshot).toEqual({});
  });
});
