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

const configPath = path.resolve(process.argv[2] || process.env.NANOBOT_CONFIG || "");
if (!process.argv[2] && !process.env.NANOBOT_CONFIG) {
  throw new Error("Usage: harden-nanobot-config.mjs <config.json>");
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.agents ||= {};
config.agents.defaults ||= {};
const existing = Array.isArray(config.agents.defaults.disabledSkills)
  ? config.agents.defaults.disabledSkills.filter((item) => typeof item === "string")
  : [];
const hardened = [...new Set([...existing, ...disabledSkills])].sort();
if (JSON.stringify(existing) !== JSON.stringify(hardened)) {
  config.agents.defaults.disabledSkills = hardened;
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, configPath);
  fs.chmodSync(configPath, 0o600);
}
