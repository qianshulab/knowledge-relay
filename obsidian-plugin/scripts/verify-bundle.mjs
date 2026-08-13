import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const [bundle, manifestRaw, packageRaw] = await Promise.all([
  fs.readFile(path.join(root, "main.js"), "utf8"),
  fs.readFile(path.join(root, "manifest.json"), "utf8"),
  fs.readFile(path.join(root, "package.json"), "utf8"),
]);
const manifest = JSON.parse(manifestRaw);
const packageJson = JSON.parse(packageRaw);

if (/require\(\s*["']\.\/template\.cjs["']\s*\)/.test(bundle)) {
  throw new Error("main.js still loads template.cjs at runtime");
}
if (!bundle.includes("module.exports") || !bundle.includes("KnowledgeRelaySyncPlugin")) {
  throw new Error("main.js does not expose the Obsidian plugin entrypoint");
}
if (manifest.version !== packageJson.version) {
  throw new Error(`Version mismatch: manifest=${manifest.version} package=${packageJson.version}`);
}
console.log(`Single-file Obsidian bundle verified: v${manifest.version}`);
