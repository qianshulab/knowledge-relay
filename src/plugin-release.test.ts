import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "./config.js";
import {
  getPluginReleaseInfo,
  inspectPluginArchive,
  publishPluginRelease,
  resolvePluginRelease,
} from "./plugin-release.js";

const temporaryDirectories: string[] = [];

function archive(options: { version?: string; id?: string; main?: boolean; prefix?: string; extra?: [string, string] } = {}): Buffer {
  const zip = new AdmZip();
  const prefix = options.prefix === undefined ? "wechat-ilink-inbox-sync/" : options.prefix;
  zip.addFile(`${prefix}manifest.json`, Buffer.from(JSON.stringify({
    id: options.id || "wechat-ilink-inbox-sync",
    name: "知流同步",
    version: options.version || "1.4.0",
    minAppVersion: "1.5.0",
  })));
  if (options.main !== false) zip.addFile(`${prefix}main.js`, Buffer.from("module.exports = {};"));
  if (options.extra) zip.addFile(options.extra[0], Buffer.from(options.extra[1]));
  return zip.toBuffer();
}

async function temporaryConfig(): Promise<AppConfig> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-plugin-"));
  temporaryDirectories.push(dataDir);
  return { dataDir } as AppConfig;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("plugin release", () => {
  it("validates the real packaged plugin", async () => {
    const content = await fs.readFile(path.resolve("release/knowledge-relay-obsidian.zip"));
    const info = inspectPluginArchive(content);
    expect(info.version).toBe("1.4.1");
    expect(info.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts a clean plugin directory and reports its manifest metadata", () => {
    const info = inspectPluginArchive(archive());
    expect(info).toMatchObject({ version: "1.4.0", minAppVersion: "1.5.0" });
    expect(info.size).toBeGreaterThan(0);
  });

  it("rejects the wrong plugin, missing entry, and unsafe path", () => {
    expect(() => inspectPluginArchive(archive({ id: "another-plugin" }))).toThrow("插件 ID");
    expect(() => inspectPluginArchive(archive({ main: false }))).toThrow("缺少 main.js");
    expect(() => inspectPluginArchive(archive({ extra: ["C:/outside.js", "bad"] }))).toThrow("不安全的文件路径");
  });

  it("publishes to the persistent data directory and prevents ambiguous replacements", async () => {
    const config = await temporaryConfig();
    const first = archive({ version: "1.4.2" });
    const published = await publishPluginRelease(config, first);
    expect(published).toMatchObject({ available: true, version: "1.4.2", source: "uploaded" });

    const resolved = await resolvePluginRelease(config);
    expect(resolved.archivePath).toBe(path.join(config.dataDir, "plugin-release", "knowledge-relay-obsidian.zip"));
    expect((await getPluginReleaseInfo(config)).sha256).toBe(published.sha256);
    await expect(publishPluginRelease(config, first)).resolves.toMatchObject({ version: "1.4.2" });
    await expect(publishPluginRelease(config, archive({ version: "1.4.2", extra: ["wechat-ilink-inbox-sync/styles.css", "changed"] })))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(publishPluginRelease(config, archive({ version: "1.2.9" })))
      .rejects.toThrow("不能从 v1.4.2 降级");
  });

  it("应用升级后优先提供比历史上传包更新的内置版本", async () => {
    const config = await temporaryConfig();
    const directory = path.join(config.dataDir, "plugin-release");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "knowledge-relay-obsidian.zip"), archive({ version: "1.2.9" }));
    await expect(resolvePluginRelease(config)).resolves.toMatchObject({ version: "1.4.1", source: "bundled" });
  });
});
