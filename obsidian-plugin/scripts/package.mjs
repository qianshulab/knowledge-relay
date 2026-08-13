import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import AdmZip from "adm-zip";

const manifest = JSON.parse(await fs.readFile("manifest.json", "utf8"));
const outputDirectory = path.resolve("release");
const archiveName = `knowledge-relay-obsidian-${manifest.version}.zip`;
const archivePath = path.join(outputDirectory, archiveName);
const zip = new AdmZip();
for (const file of ["main.js", "manifest.json", "styles.css", "README.md", "versions.json"]) {
  zip.addLocalFile(path.resolve(file), "wechat-ilink-inbox-sync");
}
await fs.mkdir(outputDirectory, { recursive: true });
zip.writeZip(archivePath);
const content = await fs.readFile(archivePath);
const digest = crypto.createHash("sha256").update(content).digest("hex");
await fs.writeFile(`${archivePath}.sha256`, `${digest}  ${archiveName}\n`, "utf8");
console.log(`Packaged ${archiveName} (${digest.slice(0, 12)}…)`);
