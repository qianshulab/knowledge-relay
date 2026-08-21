import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.js";
import { MessageItemType } from "./ilink/types.js";
import { downloadAttachments } from "./media.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

describe("微信附件下载", () => {
  it("瞬时网络错误后自动重试并写入租户目录", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-media-"));
    temporaryDirectories.push(dataDir);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(Buffer.from("attachment body"), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const config = {
      dataDir,
      ilink: {
        cdnBaseUrl: "https://cdn.example.test/",
        maxMediaBytes: 1_024,
      },
    } as AppConfig;

    const attachments = await downloadAttachments([{
      type: MessageItemType.FILE,
      file_item: {
        file_name: "report.txt",
        media: { full_url: "https://cdn.example.test/download/report" },
      },
    }], "message-1", "sender-1", config, "tenant-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.path).toContain(`${path.sep}media${path.sep}tenants${path.sep}`);
    await expect(fs.readFile(attachments[0]!.path, "utf8")).resolves.toBe("attachment body");
  });
});
