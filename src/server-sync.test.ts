import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BotManager } from "./bot-manager.js";
import type { AppConfig } from "./config.js";
import type { AccountLoginManager } from "./ilink/account-login-manager.js";
import { createServer } from "./server.js";
import { AppDatabase } from "./storage/database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

describe("Obsidian sync protocol negotiation", () => {
  it("serves schema 1.2 to plugin 1.4 while keeping 1.1 as the legacy default", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-sync-schema-"));
    temporaryDirectories.push(directory);
    const database = await AppDatabase.open(directory);
    database.createOwner({ displayName: "Owner", password: "test-password" });
    const target = database.createSyncTarget({ name: "Vault", folder: "Inbox", primary: true });
    const config = {
      host: "127.0.0.1",
      port: 8787,
      dataDir: directory,
      sessionDays: 30,
      ilink: { allowFrom: [] },
      nanobot: {},
      sync: { batchSize: 100 },
      logLevel: "error",
    } as unknown as AppConfig;
    const app = createServer(config, database, {} as BotManager, {} as AccountLoginManager);

    const current = await app.inject({
      method: "GET",
      url: "/api/sync/pull?limit=10",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "X-Knowledge-Relay-Plugin": "1.4.0",
        "X-Knowledge-Relay-Schema": "1.2",
      },
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ schemaVersion: "1.2", items: [] });
    expect(current.headers["x-knowledge-relay-schema"]).toBe("1.2");

    const legacy = await app.inject({
      method: "GET",
      url: "/api/sync/pull?limit=10",
      headers: { Authorization: `Bearer ${target.token}` },
    });
    expect(legacy.json()).toMatchObject({ schemaVersion: "1.1", items: [] });

    await app.close();
    database.close();
  });
});
