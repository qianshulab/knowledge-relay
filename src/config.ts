import path from "node:path";

export type AppConfig = {
  host: string;
  port: number;
  dataDir: string;
  sessionDays: number;
  publicBaseUrl?: string;
  ilink: {
    apiBaseUrl: string;
    cdnBaseUrl: string;
    appId: string;
    botAgent: string;
    longPollMs: number;
    maxMediaBytes: number;
    allowFrom: string[];
  };
  webhook: {
    url?: string;
    secret?: string;
    timeoutMs: number;
  };
  nanobot: {
    baseUrl: string;
    searchBaseUrl?: string;
    catalogUrl?: string;
    apiKey?: string;
    model: string;
    configPath: string;
    workspace: string;
    managed: boolean;
    autoReload: boolean;
    timeoutMs: number;
    processTimeoutMs: number;
  };
  sync: {
    batchSize: number;
  };
  autoAck: boolean;
  autoAckText: string;
  logLevel: "debug" | "info" | "warn" | "error";
};

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} 必须是大于 0 的数字`);
  }
  return value;
}

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} 必须是 true 或 false`);
}

function optionalUrl(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} 只支持 http/https URL`);
  }
  return url.toString();
}

export function loadConfig(): AppConfig {
  const host = process.env.HOST?.trim() || "127.0.0.1";

  const logLevelRaw = process.env.LOG_LEVEL?.trim().toLowerCase() || "info";
  if (!["debug", "info", "warn", "error"].includes(logLevelRaw)) {
    throw new Error("LOG_LEVEL 必须是 debug/info/warn/error");
  }

  const nanobotBaseUrl = new URL(
    process.env.NANOBOT_BASE_URL?.trim() || "http://127.0.0.1:8900/v1/",
  ).toString();
  return {
    host,
    port: numberFromEnv("PORT", 8787),
    dataDir: path.resolve(process.env.DATA_DIR?.trim() || "./data"),
    sessionDays: numberFromEnv("SESSION_DAYS", 30),
    publicBaseUrl: optionalUrl("PUBLIC_BASE_URL"),
    ilink: {
      apiBaseUrl: new URL(
        process.env.ILINK_BASE_URL?.trim() || "https://ilinkai.weixin.qq.com",
      ).toString(),
      cdnBaseUrl: new URL(
        process.env.ILINK_CDN_BASE_URL?.trim() ||
          "https://novac2c.cdn.weixin.qq.com/c2c",
      ).toString(),
      appId: process.env.ILINK_APP_ID?.trim() || "bot",
      botAgent: process.env.ILINK_BOT_AGENT?.trim() || "WechatInbox/0.1.0",
      longPollMs: numberFromEnv("ILINK_LONG_POLL_MS", 35_000),
      maxMediaBytes: numberFromEnv("ILINK_MAX_MEDIA_MB", 100) * 1024 * 1024,
      allowFrom: (process.env.ILINK_ALLOW_FROM || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    },
    webhook: {
      url: optionalUrl("PROCESS_WEBHOOK_URL"),
      secret: process.env.PROCESS_WEBHOOK_SECRET?.trim() || undefined,
      timeoutMs: numberFromEnv("PROCESS_WEBHOOK_TIMEOUT_MS", 30_000),
    },
    nanobot: {
      baseUrl: nanobotBaseUrl,
      searchBaseUrl: new URL(
        process.env.NANOBOT_SEARCH_BASE_URL?.trim() || "http://127.0.0.1:8902/v1/",
      ).toString(),
      catalogUrl: new URL(
        process.env.NANOBOT_CATALOG_URL?.trim() || "http://127.0.0.1:8901/",
      ).toString(),
      apiKey: process.env.NANOBOT_API_KEY?.trim() || undefined,
      model: "",
      configPath: path.resolve(
        process.env.NANOBOT_CONFIG?.trim() || path.join(process.env.DATA_DIR?.trim() || "./data", "nanobot", "config.json"),
      ),
      workspace: path.resolve(
        process.env.NANOBOT_WORKSPACE?.trim() || path.join(process.env.DATA_DIR?.trim() || "./data", "nanobot", "workspace"),
      ),
      managed: booleanFromEnv("NANOBOT_MANAGED", true),
      autoReload: booleanFromEnv(
        "NANOBOT_AUTO_RELOAD",
        booleanFromEnv("NANOBOT_MANAGED", true),
      ),
      timeoutMs: numberFromEnv("NANOBOT_TIMEOUT_MS", 120_000),
      processTimeoutMs: numberFromEnv("NANOBOT_PROCESS_TIMEOUT_MS", 900_000),
    },
    sync: {
      batchSize: Math.min(numberFromEnv("SYNC_BATCH_SIZE", 100), 500),
    },
    autoAck: booleanFromEnv("AUTO_ACK", false),
    autoAckText: process.env.AUTO_ACK_TEXT?.trim() || "已收到并保存。",
    logLevel: logLevelRaw as AppConfig["logLevel"],
  };
}
