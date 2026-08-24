import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const disabledSkills = [
  "clawhub",
  "cron",
  "github",
  "image-generation",
  "memory",
  "my",
  "skill-creator",
  "summarize",
  "tmux",
  "update-setup",
  "weather",
];

const unconfiguredProviderKey = "__KNOWLEDGE_RELAY_PROVIDER_NOT_CONFIGURED__";

const configPath = path.resolve(process.argv[2] || process.env.NANOBOT_CONFIG || "");
if (!process.argv[2] && !process.env.NANOBOT_CONFIG) {
  throw new Error("Usage: harden-nanobot-config.mjs <config.json>");
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.agents ||= {};
config.agents.defaults ||= {};
config.providers ||= {};
config.providers.deepseek ||= {};

// Kimi Code and Moonshot Platform use different credentials and endpoints.
// Releases before 1.9.1 exposed only the Moonshot entry, so migrate an
// unmistakable Kimi Code configuration to Nanobot's native kimi_coding
// provider during startup. The old key is removed from the wrong provider.
const moonshot = config.providers.moonshot;
const moonshotBase = String(moonshot?.apiBase || "").trim();
const moonshotKey = String(moonshot?.apiKey || "").trim();
const isLegacyKimiCoding = config.agents.defaults.provider === "moonshot"
  && (moonshotKey.startsWith("sk-kimi-") || /^https:\/\/api\.kimi\.com\/coding(?:\/|$)/i.test(moonshotBase));
if (isLegacyKimiCoding) {
  config.providers.kimiCoding ||= {};
  config.providers.kimiCoding.apiBase = moonshotBase || "https://api.kimi.com/coding/v1";
  config.providers.kimiCoding.apiKey = moonshotKey || config.providers.kimiCoding.apiKey || null;
  config.agents.defaults.provider = "kimi_coding";
  if (!["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"].includes(config.agents.defaults.model)) {
    config.agents.defaults.model = "kimi-for-coding";
  }
  delete moonshot.apiBase;
  delete moonshot.apiKey;
}
const configuredDeepseekKey = String(process.env.DEEPSEEK_API_KEY || "").trim();
if (
  config.providers.deepseek.apiKey === "${DEEPSEEK_API_KEY}"
  || config.providers.deepseek.apiKey === unconfiguredProviderKey
) {
  config.providers.deepseek.apiKey = configuredDeepseekKey || unconfiguredProviderKey;
}
const existing = Array.isArray(config.agents.defaults.disabledSkills)
  ? config.agents.defaults.disabledSkills.filter((item) => typeof item === "string")
  : [];
const hardened = [...new Set([...existing, ...disabledSkills])].sort();
config.agents.defaults.disabledSkills = hardened;
const serialized = `${JSON.stringify(config, null, 2)}\n`;
const current = `${fs.readFileSync(configPath, "utf8").trimEnd()}\n`;
if (current !== serialized) {
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, configPath);
  fs.chmodSync(configPath, 0o600);
}
