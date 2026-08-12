import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import AdmZip from "adm-zip";

const root = process.cwd();
const outputDirectory = path.join(root, "release");
const output = path.join(outputDirectory, "knowledge-relay-obsidian.zip");
const zip = new AdmZip();
for (const file of ["main.js", "manifest.json", "styles.css", "template.cjs", "README.md", "versions.json"]) {
  zip.addLocalFile(path.join(root, "obsidian-plugin", file), "wechat-ilink-inbox-sync");
}
await fs.mkdir(outputDirectory, { recursive: true });
zip.writeZip(output);
const content = await fs.readFile(output);
const digest = crypto.createHash("sha256").update(content).digest("hex");
await fs.writeFile(path.join(outputDirectory, "knowledge-relay-obsidian.sha256"), `${digest}  knowledge-relay-obsidian.zip\n`);
console.log(`Obsidian plugin packaged: ${path.relative(root, output)} (${digest.slice(0, 12)}…)`);
