import "dotenv/config";

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, "data"));
const workspace = path.resolve(
  process.env.NANOBOT_WORKSPACE || path.join(dataDir, "nanobot", "workspace"),
);
const configPath = path.resolve(
  process.env.NANOBOT_CONFIG || path.join(dataDir, "nanobot", "config.json"),
);
const skillsRoot = path.join(workspace, "skills");
const skillSources = [
  {
    slug: "wechat-article-extractor",
    source: path.join(root, "external-skills", "wechat-article-extractor"),
    repository: path.join(root, "external-skills", "wechat-article-extractor"),
    revision: "d8f74b8946065e64537f1ad39f962dbed86da3c7",
  },
  {
    slug: "fetch-skill",
    source: path.join(root, "external-skills", "fetch-skill"),
    repository: path.join(root, "external-skills", "fetch-skill"),
    revision: "d67a579dd4533386e41b6175e07a70c10b6a0c8e",
  },
  ...["mermaid-visualizer", "obsidian-canvas-creator", "excalidraw-diagram"].map((slug) => ({
    slug,
    source: path.join(root, "external-skills", "axton-obsidian-visual-skills", slug),
    repository: path.join(root, "external-skills", "axton-obsidian-visual-skills"),
    revision: "1265976d9746a84858b4b7b42fb86a215aa93de9",
  })),
];

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => !entry.split(path.sep).includes(".git") && !entry.split(path.sep).includes("node_modules"),
  });
}

fs.mkdirSync(skillsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(workspace, ".upstream"), { recursive: true, mode: 0o700 });

for (const { slug: skill, source, repository, revision } of skillSources) {
  if (!fs.existsSync(path.join(source, "SKILL.md"))) {
    throw new Error(
      `缺少原版 Skill：${skill}。请先运行 git submodule update --init --recursive。`,
    );
  }
  if (fs.existsSync(path.join(repository, ".git"))) {
    const actual = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (actual !== revision) throw new Error(`${skill} 版本不匹配：${actual}`);
  }
  const destination = path.join(skillsRoot, skill);
  if (!fs.existsSync(destination)) copyDirectory(source, destination);
  const upstream = path.join(workspace, ".upstream", skill);
  fs.mkdirSync(upstream, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(upstream, "SKILL.md"))) {
    fs.copyFileSync(path.join(source, "SKILL.md"), path.join(upstream, "SKILL.md"));
  }
}

const wechatSkill = path.join(skillsRoot, "wechat-article-extractor");
if (!fs.existsSync(path.join(wechatSkill, "node_modules"))) {
  execFileSync("npm", ["ci", "--omit=dev"], { cwd: wechatSkill, stdio: "inherit" });
}

const agentsSource = path.join(root, "nanobot", "AGENTS.md");
fs.copyFileSync(agentsSource, path.join(workspace, "AGENTS.md"));
fs.mkdirSync(path.join(workspace, "nanobot-bin"), { recursive: true, mode: 0o700 });
fs.copyFileSync(
  path.join(root, "nanobot", "run-wechat-extractor.cjs"),
  path.join(workspace, "nanobot-bin", "run-wechat-extractor.cjs"),
);
fs.copyFileSync(
  path.join(root, "nanobot", "extract-wechat-isolated.cjs"),
  path.join(workspace, "nanobot-bin", "extract-wechat-isolated.cjs"),
);

if (!fs.existsSync(configPath)) {
  const template = fs.readFileSync(path.join(root, "nanobot", "config.local.template.json"), "utf8");
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, template.replace("__WORKSPACE__", workspace.replaceAll("\\", "\\\\")), {
    encoding: "utf8",
    mode: 0o600,
  });
}

execFileSync(process.execPath, [path.join(root, "scripts", "harden-nanobot-config.mjs"), configPath], {
  stdio: "inherit",
});

console.log(`Nanobot workspace ready: ${workspace}`);
