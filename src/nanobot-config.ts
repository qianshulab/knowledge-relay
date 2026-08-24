import { promises as fs } from "node:fs";
import path from "node:path";

import type { AppConfig } from "./config.js";

type JsonObject = Record<string, unknown>;

const UNCONFIGURED_PROVIDER_KEY = "__KNOWLEDGE_RELAY_PROVIDER_NOT_CONFIGURED__";

export type NanobotProviderDefinition = {
  id: string;
  configKey: string;
  name: string;
  defaultModel: string;
  defaultBaseUrl?: string;
  auth: "api_key" | "local" | "oauth";
};

export type NanobotModelOption = {
  id: string;
  label?: string;
  description?: string;
  ownedBy?: string;
  contextWindow?: number;
};

export const NANOBOT_PROVIDERS: NanobotProviderDefinition[] = [
  { id: "deepseek", configKey: "deepseek", name: "DeepSeek", defaultModel: "deepseek-chat", defaultBaseUrl: "https://api.deepseek.com", auth: "api_key" },
  { id: "openai", configKey: "openai", name: "OpenAI", defaultModel: "gpt-5.4", defaultBaseUrl: "https://api.openai.com/v1", auth: "api_key" },
  { id: "openai_codex", configKey: "openaiCodex", name: "OpenAI Codex（OAuth）", defaultModel: "openai-codex/gpt-5.6-sol", auth: "oauth" },
  { id: "anthropic", configKey: "anthropic", name: "Anthropic", defaultModel: "claude-sonnet-4-5", defaultBaseUrl: "https://api.anthropic.com", auth: "api_key" },
  { id: "openrouter", configKey: "openrouter", name: "OpenRouter", defaultModel: "openai/gpt-5.4", defaultBaseUrl: "https://openrouter.ai/api/v1", auth: "api_key" },
  { id: "gemini", configKey: "gemini", name: "Google Gemini", defaultModel: "gemini-2.5-pro", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", auth: "api_key" },
  { id: "dashscope", configKey: "dashscope", name: "阿里云百炼", defaultModel: "qwen-max", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", auth: "api_key" },
  { id: "kimi_coding", configKey: "kimiCoding", name: "Kimi Code（会员 API）", defaultModel: "kimi-for-coding", defaultBaseUrl: "https://api.kimi.com/coding/v1", auth: "api_key" },
  { id: "moonshot", configKey: "moonshot", name: "Moonshot 开放平台", defaultModel: "kimi-k2.5", defaultBaseUrl: "https://api.moonshot.ai/v1", auth: "api_key" },
  { id: "zhipu", configKey: "zhipu", name: "智谱 AI", defaultModel: "glm-4.5", defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4", auth: "api_key" },
  { id: "siliconflow", configKey: "siliconflow", name: "硅基流动", defaultModel: "deepseek-ai/DeepSeek-V3", defaultBaseUrl: "https://api.siliconflow.cn/v1", auth: "api_key" },
  { id: "groq", configKey: "groq", name: "Groq", defaultModel: "openai/gpt-oss-120b", defaultBaseUrl: "https://api.groq.com/openai/v1", auth: "api_key" },
  { id: "qianfan", configKey: "qianfan", name: "百度千帆", defaultModel: "ernie-4.5", defaultBaseUrl: "https://qianfan.baidubce.com/v2", auth: "api_key" },
  { id: "custom", configKey: "custom", name: "自定义 OpenAI 兼容接口", defaultModel: "", auth: "api_key" },
  { id: "ollama", configKey: "ollama", name: "Ollama（本地）", defaultModel: "llama3.2", defaultBaseUrl: "http://localhost:11434/v1", auth: "local" },
  { id: "vllm", configKey: "vllm", name: "vLLM（本地）", defaultModel: "", auth: "local" },
];

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function providerDefinition(id: string): NanobotProviderDefinition {
  const provider = NANOBOT_PROVIDERS.find((item) => item.id === id);
  if (!provider) throw new Error("不支持这个 Nanobot 模型提供者");
  return provider;
}

function configuredSecret(value: unknown): boolean {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim() !== UNCONFIGURED_PROVIDER_KEY
    && !/^\$\{[A-Z0-9_]+\}$/.test(value.trim());
}

function validateProviderBaseUrl(provider: NanobotProviderDefinition, value: string): string {
  const candidate = value.trim() || provider.defaultBaseUrl || "";
  if (!candidate) throw new Error("这个模型提供者需要填写 API 地址");
  const url = new URL(candidate);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("模型 API 地址必须是有效的 HTTP/HTTPS 地址且不能包含账号密码");
  }
  if (url.protocol === "http:" && provider.auth !== "local") {
    throw new Error("在线模型提供者必须使用 HTTPS");
  }
  if (provider.id === "kimi_coding"
    && (url.hostname !== "api.kimi.com" || !url.pathname.startsWith("/coding"))) {
    throw new Error("Kimi Code 请使用 https://api.kimi.com/coding/v1；其他 OpenAI 兼容网关请选择自定义接口");
  }
  if (provider.id === "moonshot" && url.hostname === "api.kimi.com") {
    throw new Error("Kimi Code 与 Moonshot 开放平台的账号体系不通用，请选择“Kimi Code（会员 API）”");
  }
  return url.toString();
}

function validatedCatalogUrl(config: AppConfig): URL {
  const url = new URL(config.nanobot.catalogUrl || "http://127.0.0.1:8901/");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Nanobot 模型目录地址无效");
  }
  if (!["127.0.0.1", "localhost", "::1", "nanobot"].includes(url.hostname)) {
    throw new Error("模型目录只能由本机 Nanobot 或 Docker 内部 nanobot 服务提供");
  }
  return url;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim().slice(0, maximum);
  return result || undefined;
}

async function readConfig(config: AppConfig): Promise<JsonObject> {
  return JSON.parse(await fs.readFile(config.nanobot.configPath, "utf8")) as JsonObject;
}

async function writeConfig(config: AppConfig, value: JsonObject): Promise<void> {
  const filePath = config.nanobot.configPath;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

export async function getNanobotProviderSettings(config: AppConfig): Promise<{
  active: { provider: string; model: string; apiBase: string; apiKeyConfigured: boolean; auth: string };
  providers: Array<Omit<NanobotProviderDefinition, "configKey">>;
  autoReload: boolean;
  oauthSupported: boolean;
}> {
  const raw = await readConfig(config);
  const defaults = record(record(raw.agents).defaults);
  const activeId = typeof defaults.provider === "string" && defaults.provider !== "auto"
    ? defaults.provider
    : "deepseek";
  const definition = NANOBOT_PROVIDERS.find((item) => item.id === activeId) || NANOBOT_PROVIDERS[0]!;
  const providerConfig = record(record(raw.providers)[definition.configKey]);
  return {
    active: {
      provider: definition.id,
      model: typeof defaults.model === "string" ? defaults.model : definition.defaultModel,
      apiBase: typeof providerConfig.apiBase === "string"
        ? providerConfig.apiBase
        : definition.defaultBaseUrl || "",
      apiKeyConfigured: definition.auth === "oauth"
        ? false
        : definition.auth === "local" || configuredSecret(providerConfig.apiKey),
      auth: definition.auth,
    },
    providers: NANOBOT_PROVIDERS.map(({ configKey: _configKey, ...item }) => item),
    autoReload: config.nanobot.autoReload,
    oauthSupported: config.nanobot.managed,
  };
}

export async function saveNanobotProviderSettings(
  config: AppConfig,
  input: { provider: string; model: string; apiBase: string; apiKey?: string; clearApiKey?: boolean },
): Promise<void> {
  const definition = providerDefinition(input.provider.trim());
  if (definition.auth === "oauth") throw new Error("OAuth 提供者请使用单独的授权按钮");
  const model = input.model.trim().slice(0, 200);
  if (!model) throw new Error("模型名称不能为空");
  const raw = await readConfig(config);
  const agents = record(raw.agents);
  const defaults = record(agents.defaults);
  const providers = record(raw.providers);
  const providerConfig = record(providers[definition.configKey]);
  const apiBase = validateProviderBaseUrl(definition, input.apiBase);
  const nextKey = input.clearApiKey ? null : input.apiKey?.trim() || providerConfig.apiKey || null;
  if (definition.auth === "api_key" && !configuredSecret(nextKey)) {
    throw new Error("这个模型提供者需要 API Key");
  }
  if (definition.id === "moonshot" && typeof nextKey === "string" && nextKey.startsWith("sk-kimi-")) {
    throw new Error("sk-kimi- 密钥属于 Kimi Code，请选择“Kimi Code（会员 API）”");
  }
  defaults.provider = definition.id;
  defaults.modelPreset = null;
  defaults.model = model;
  agents.defaults = defaults;
  raw.agents = agents;
  providerConfig.apiBase = apiBase;
  providerConfig.apiKey = nextKey;
  providers[definition.configKey] = providerConfig;
  raw.providers = providers;
  await writeConfig(config, raw);
}

export async function getNanobotProviderModels(
  config: AppConfig,
  providerId: string,
): Promise<{
  provider: string;
  status: "available" | "not_configured" | "unsupported" | "missing_api_base" | "error";
  models: NanobotModelOption[];
  modelCount: number;
  message?: string;
  fetchedAt: number;
}> {
  const provider = providerDefinition(providerId.trim());
  const url = new URL("models", validatedCatalogUrl(config));
  url.searchParams.set("provider", provider.id);
  const response = await fetch(url, {
    headers: config.nanobot.apiKey ? { Authorization: `Bearer ${config.nanobot.apiKey}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(response.status === 401
      ? "Nanobot 模型目录认证失败"
      : `Nanobot 模型目录暂时不可用（HTTP ${response.status}）`);
  }
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("Nanobot 模型目录返回了无效数据");
  }
  const allowedStatus = new Set(["available", "not_configured", "unsupported", "missing_api_base", "error"]);
  const status = typeof value.status === "string" && allowedStatus.has(value.status)
    ? value.status as "available" | "not_configured" | "unsupported" | "missing_api_base" | "error"
    : "error";
  const models = Array.isArray(value.models)
    ? value.models.slice(0, 500).flatMap((item): NanobotModelOption[] => {
      const row = record(item);
      const id = boundedText(row.id, 200);
      if (!id) return [];
      const contextWindow = typeof row.context_window === "number" && Number.isFinite(row.context_window)
        ? Math.max(0, Math.floor(row.context_window))
        : undefined;
      return [{
        id,
        ...(boundedText(row.label, 200) ? { label: boundedText(row.label, 200) } : {}),
        ...(boundedText(row.description, 500) ? { description: boundedText(row.description, 500) } : {}),
        ...(boundedText(row.owned_by, 100) ? { ownedBy: boundedText(row.owned_by, 100) } : {}),
        ...(contextWindow ? { contextWindow } : {}),
      }];
    })
    : [];
  return {
    provider: provider.id,
    status,
    models,
    modelCount: models.length,
    ...(boundedText(value.message, 300) ? { message: boundedText(value.message, 300) } : {}),
    fetchedAt: typeof value.fetched_at === "number" ? value.fetched_at : Date.now() / 1_000,
  };
}

export async function activateNanobotOAuthProvider(
  config: AppConfig,
  provider: "openai_codex",
  model: string,
): Promise<void> {
  providerDefinition(provider);
  const selectedModel = model.trim().slice(0, 200) || "openai-codex/gpt-5.6-sol";
  const raw = await readConfig(config);
  const agents = record(raw.agents);
  const defaults = record(agents.defaults);
  defaults.provider = provider;
  defaults.modelPreset = null;
  defaults.model = selectedModel;
  agents.defaults = defaults;
  raw.agents = agents;
  await writeConfig(config, raw);
}
