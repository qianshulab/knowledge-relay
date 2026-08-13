import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import AdmZip from "adm-zip";

import type { AppConfig } from "./config.js";

export const PLUGIN_ARCHIVE_NAME = "knowledge-relay-obsidian.zip";
export const PLUGIN_DOWNLOAD_URL = `/downloads/${PLUGIN_ARCHIVE_NAME}`;
export const PLUGIN_MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;

const PLUGIN_ID = "wechat-ilink-inbox-sync";
const MAX_ENTRY_COUNT = 100;
const MAX_UNCOMPRESSED_BYTES = 30 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

type PluginManifest = {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
};

export type PluginReleaseInfo = {
  available: boolean;
  downloadUrl: string;
  version?: string;
  minAppVersion?: string;
  size?: number;
  sha256?: string;
  publishedAt?: string;
  source?: "uploaded" | "bundled";
};

type ResolvedPluginRelease = PluginReleaseInfo & {
  archivePath?: string;
};

export class PluginReleaseError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "PluginReleaseError";
    this.statusCode = statusCode;
  }
}

function publishedArchive(config: AppConfig): string {
  return path.join(config.dataDir, "plugin-release", PLUGIN_ARCHIVE_NAME);
}

function publishedMetadata(config: AppConfig): string {
  return path.join(config.dataDir, "plugin-release", "metadata.json");
}

function bundledArchive(): string {
  return path.resolve("release", PLUGIN_ARCHIVE_NAME);
}

function safeEntryName(value: string): string {
  if (
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new PluginReleaseError("插件 ZIP 包含不安全的文件路径");
  }
  const parts = value.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new PluginReleaseError("插件 ZIP 包含不安全的文件路径");
  }
  return parts.join("/");
}

function parseVersion(value: unknown): [number, number, number, string] {
  if (typeof value !== "string") throw new PluginReleaseError("manifest.json 缺少有效版本号");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) throw new PluginReleaseError("插件版本号必须使用 x.y.z 格式");
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || ""];
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return Number(a[index]) > Number(b[index]) ? 1 : -1;
  }
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  return a[3].localeCompare(b[3]);
}

export function inspectPluginArchive(content: Buffer): Omit<PluginReleaseInfo, "available" | "downloadUrl" | "publishedAt" | "source"> {
  if (!content.length) throw new PluginReleaseError("请选择插件 ZIP 安装包");
  if (content.length > PLUGIN_MAX_ARCHIVE_BYTES) {
    throw new PluginReleaseError("插件 ZIP 不能超过 10 MB", 413);
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(content, { readEntries: true });
  } catch {
    throw new PluginReleaseError("无法读取插件 ZIP，请确认文件没有损坏");
  }

  const entries = zip.getEntries();
  if (!entries.length || entries.length > MAX_ENTRY_COUNT) {
    throw new PluginReleaseError(`插件 ZIP 文件数量必须在 1 到 ${MAX_ENTRY_COUNT} 个之间`);
  }

  let totalUncompressed = 0;
  const names = new Map<string, AdmZip.IZipEntry>();
  for (const entry of entries) {
    const name = safeEntryName(entry.entryName);
    if (entry.header.encrypted) throw new PluginReleaseError("不支持加密的插件 ZIP");
    totalUncompressed += entry.header.size;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new PluginReleaseError("插件 ZIP 解压后的内容不能超过 30 MB");
    }
    if (!entry.isDirectory) {
      if (names.has(name)) throw new PluginReleaseError("插件 ZIP 包含重复文件");
      names.set(name, entry);
    }
  }

  const manifestNames = [...names.keys()].filter((name) => name === "manifest.json" || /^[^/]+\/manifest\.json$/.test(name));
  if (manifestNames.length !== 1) {
    throw new PluginReleaseError("插件 ZIP 必须包含一个 manifest.json，可放在根目录或单一插件目录中");
  }
  const manifestName = manifestNames[0]!;
  const prefix = manifestName.slice(0, -"manifest.json".length);
  if (!names.has(`${prefix}main.js`)) throw new PluginReleaseError("插件 ZIP 缺少 main.js");
  if ([...names.keys()].some((name) => prefix && !name.startsWith(prefix))) {
    throw new PluginReleaseError("插件 ZIP 只能包含一个插件目录");
  }

  const manifestEntry = names.get(manifestName)!;
  if (manifestEntry.header.size > MAX_MANIFEST_BYTES) throw new PluginReleaseError("manifest.json 内容过大");
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString("utf8")) as PluginManifest;
  } catch {
    throw new PluginReleaseError("manifest.json 不是有效的 JSON");
  }
  if (manifest.id !== PLUGIN_ID) throw new PluginReleaseError(`插件 ID 必须是 ${PLUGIN_ID}`);
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    throw new PluginReleaseError("manifest.json 缺少插件名称");
  }
  parseVersion(manifest.version);

  try {
    if (!zip.test()) throw new Error("CRC mismatch");
  } catch {
    throw new PluginReleaseError("插件 ZIP 校验失败，请重新打包后上传");
  }

  return {
    version: manifest.version.trim(),
    minAppVersion: typeof manifest.minAppVersion === "string" ? manifest.minAppVersion.trim() : undefined,
    size: content.length,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
  };
}

async function inspectPath(archivePath: string, source: "uploaded" | "bundled", metadataPath?: string): Promise<ResolvedPluginRelease | undefined> {
  try {
    const [content, stat] = await Promise.all([fs.readFile(archivePath), fs.stat(archivePath)]);
    const inspected = inspectPluginArchive(content);
    let publishedAt = stat.mtime.toISOString();
    if (metadataPath) {
      try {
        const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as { publishedAt?: unknown; sha256?: unknown };
        if (metadata.sha256 === inspected.sha256 && typeof metadata.publishedAt === "string") {
          publishedAt = new Date(metadata.publishedAt).toISOString();
        }
      } catch {
        // The archive is authoritative; metadata is only a presentation cache.
      }
    }
    return { available: true, downloadUrl: PLUGIN_DOWNLOAD_URL, archivePath, source, publishedAt, ...inspected };
  } catch (error) {
    if (error instanceof PluginReleaseError) throw error;
    const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

export async function resolvePluginRelease(config: AppConfig): Promise<ResolvedPluginRelease> {
  const uploaded = await inspectPath(publishedArchive(config), "uploaded", publishedMetadata(config));
  if (uploaded) return uploaded;
  const bundled = await inspectPath(bundledArchive(), "bundled");
  return bundled || { available: false, downloadUrl: PLUGIN_DOWNLOAD_URL };
}

export async function getPluginReleaseInfo(config: AppConfig): Promise<PluginReleaseInfo> {
  const { archivePath: _archivePath, ...info } = await resolvePluginRelease(config);
  return info;
}

export async function publishPluginRelease(config: AppConfig, content: Buffer): Promise<PluginReleaseInfo> {
  const inspected = inspectPluginArchive(content);
  const current = await resolvePluginRelease(config);
  if (current.available && current.version && current.sha256) {
    const comparison = compareVersions(inspected.version!, current.version);
    if (comparison < 0) throw new PluginReleaseError(`不能从 v${current.version} 降级到 v${inspected.version}`, 409);
    if (comparison === 0) {
      if (inspected.sha256 === current.sha256) return getPluginReleaseInfo(config);
      throw new PluginReleaseError(`v${inspected.version} 已存在；内容变化时请先提升版本号`, 409);
    }
  }

  const directory = path.dirname(publishedArchive(config));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const suffix = `${process.pid}-${crypto.randomUUID()}`;
  const archiveTemp = path.join(directory, `.${PLUGIN_ARCHIVE_NAME}.${suffix}.tmp`);
  const metadataTemp = path.join(directory, `.metadata.${suffix}.tmp`);
  const publishedAt = new Date().toISOString();
  try {
    await fs.writeFile(archiveTemp, content, { mode: 0o600, flag: "wx" });
    await fs.rename(archiveTemp, publishedArchive(config));
    await fs.writeFile(metadataTemp, JSON.stringify({ ...inspected, publishedAt }, null, 2), { mode: 0o600, flag: "wx" });
    await fs.rename(metadataTemp, publishedMetadata(config));
  } finally {
    await Promise.all([fs.rm(archiveTemp, { force: true }), fs.rm(metadataTemp, { force: true })]);
  }
  return { available: true, downloadUrl: PLUGIN_DOWNLOAD_URL, source: "uploaded", publishedAt, ...inspected };
}
