import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import path from "node:path";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import QRCode from "qrcode";

import type { BotManager } from "./bot-manager.js";
import type { AppConfig } from "./config.js";
import type { AccountLoginManager } from "./ilink/account-login-manager.js";
import { errorDetails, logger } from "./logger.js";
import { NanobotClient } from "./nanobot.js";
import {
  getNanobotProviderModels,
  getNanobotProviderSettings,
  saveNanobotProviderSettings,
} from "./nanobot-config.js";
import {
  getPluginReleaseInfo,
  PLUGIN_MAX_ARCHIVE_BYTES,
  publishPluginRelease,
  resolvePluginRelease,
} from "./plugin-release.js";
import type { AppDatabase, OwnerProfile } from "./storage/database.js";
import { adminPage } from "./ui.js";

type OwnerRequest = FastifyRequest & { owner?: OwnerProfile; sessionToken?: string };

function bearer(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  const cookie = request.headers.cookie || "";
  for (const item of cookie.split(";")) {
    const [name, ...parts] = item.trim().split("=");
    if (name === "ilink_session") return decodeURIComponent(parts.join("="));
  }
  return undefined;
}

function stringBody(value: unknown, maximum = 500): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function booleanBody(value: unknown): boolean {
  return value === true;
}

function sessionCookie(config: AppConfig, token: string, maxAgeSeconds: number): string {
  const secure = config.publicBaseUrl?.startsWith("https://") ? "; Secure" : "";
  return `ilink_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function publicAccount(account: ReturnType<AppDatabase["getBotAccounts"]>[number], running: boolean) {
  return {
    id: account.id,
    botId: account.botId,
    ownerUserId: account.ownerUserId,
    connectedAt: account.connectedAt,
    state: running ? "running" : account.state,
    lastPollAt: account.lastPollAt,
    lastMessageAt: account.lastMessageAt,
    lastError: account.lastError,
  };
}

export function createServer(
  config: AppConfig,
  database: AppDatabase,
  bots: BotManager,
  login: AccountLoginManager,
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const nanobot = new NanobotClient(config);
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  let oauthInProgress = false;
  let pluginPublishInProgress = false;

  for (const contentType of ["application/zip", "application/octet-stream", "application/x-zip-compressed"]) {
    app.addContentTypeParser(contentType, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  }

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    return payload;
  });

  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0] || request.url;
    const origin = request.headers.origin;
    if (origin && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const expectedOrigin = config.publicBaseUrl
        ? new URL(config.publicBaseUrl).origin
        : `${request.protocol}://${request.headers.host}`;
      if (origin !== expectedOrigin) return reply.code(403).send({ error: "请求来源不受信任" });
    }
    if (
      url === "/" ||
      url === "/health" ||
      url === "/api/bootstrap" ||
      url === "/api/setup" ||
      url === "/api/login" ||
      url === "/downloads/knowledge-relay-obsidian.zip" ||
      url.startsWith("/api/sync/")
    ) {
      return;
    }
    const token = bearer(request);
    const owner = token ? database.ownerForSession(token) : undefined;
    if (!owner) return reply.code(401).send({ error: "请先登录" });
    (request as OwnerRequest).owner = owner;
    (request as OwnerRequest).sessionToken = token;
  });

  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(adminPage));
  app.get("/health", async () => ({ ok: true, database: true, time: new Date().toISOString() }));
  app.get("/downloads/knowledge-relay-obsidian.zip", async (_request, reply) => {
    const release = await resolvePluginRelease(config);
    if (!release.available || !release.archivePath) {
      return reply.code(404).send({ error: "插件安装包尚未发布" });
    }
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", "attachment; filename=knowledge-relay-obsidian.zip");
    reply.header("Cache-Control", "no-cache");
    if (release.size) reply.header("Content-Length", String(release.size));
    if (release.sha256) reply.header("ETag", `"${release.sha256}"`);
    return reply.send(createReadStream(release.archivePath));
  });

  app.get("/api/bootstrap", async () => ({ needsSetup: !database.hasOwner() }));

  app.post<{ Body: Record<string, unknown> }>("/api/setup", async (request, reply) => {
    if (database.hasOwner()) return reply.code(409).send({ error: "系统已经完成初始化" });
    const owner = database.createOwner({
      displayName: stringBody(request.body?.displayName, 60),
      password: stringBody(request.body?.password, 200),
    });
    const migrated = await database.claimLegacyData();
    const session = database.createSession(config.sessionDays);
    reply.header("Set-Cookie", sessionCookie(config, session.token, config.sessionDays * 86_400));
    return { owner, migrated };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/login", async (request, reply) => {
    const key = request.ip;
    const currentTime = Date.now();
    const attempt = loginAttempts.get(key);
    if (attempt && attempt.resetAt > currentTime && attempt.count >= 8) {
      reply.header("Retry-After", String(Math.ceil((attempt.resetAt - currentTime) / 1_000)));
      return reply.code(429).send({ error: "登录尝试过多，请 15 分钟后重试" });
    }
    const owner = database.authenticateOwner(stringBody(request.body?.password, 200));
    if (!owner) {
      const next = attempt && attempt.resetAt > currentTime
        ? { count: attempt.count + 1, resetAt: attempt.resetAt }
        : { count: 1, resetAt: currentTime + 15 * 60 * 1_000 };
      loginAttempts.set(key, next);
      return reply.code(401).send({ error: "密码错误" });
    }
    loginAttempts.delete(key);
    const session = database.createSession(config.sessionDays);
    reply.header("Set-Cookie", sessionCookie(config, session.token, config.sessionDays * 86_400));
    return { owner };
  });

  app.post("/api/logout", async (request, reply) => {
    const token = (request as OwnerRequest).sessionToken;
    if (token) database.revokeSession(token);
    reply.header("Set-Cookie", sessionCookie(config, "", 0));
    return { ok: true };
  });

  app.get("/api/me", async (request) => ({ owner: (request as OwnerRequest).owner }));

  app.put<{ Body: Record<string, unknown> }>("/api/me/profile", async (request, reply) => {
    const displayName = stringBody(request.body?.displayName, 60);
    if (!displayName) return reply.code(400).send({ error: "请输入账户名称" });
    return { owner: database.updateOwnerDisplayName(displayName) };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/me/password", async (request, reply) => {
    const currentPassword = stringBody(request.body?.currentPassword, 200);
    const newPassword = stringBody(request.body?.newPassword, 200);
    const confirmPassword = stringBody(request.body?.confirmPassword, 200);
    if (newPassword.length < 8) return reply.code(400).send({ error: "新密码至少需要 8 个字符" });
    if (newPassword !== confirmPassword) return reply.code(400).send({ error: "两次输入的新密码不一致" });
    if (!database.changePassword(currentPassword, newPassword)) {
      return reply.code(400).send({ error: "当前密码不正确" });
    }
    reply.header("Set-Cookie", sessionCookie(config, "", 0));
    return { ok: true, loginRequired: true };
  });

  app.get("/api/dashboard", async () => {
    return {
      ...database.dashboard(),
      accounts: database.getBotAccounts().map((account) => publicAccount(account, bots.isRunning(account.id))),
      syncTargets: database.listSyncTargets(),
    };
  });

  app.get<{ Querystring: { limit?: string; before?: string } }>("/api/messages", async (request) => {
    const limit = Math.min(Math.max(Number(request.query.limit || 100) || 100, 1), 200);
    const before = Number(request.query.before || 0) || undefined;
    return { messages: database.listMessages(limit, before) };
  });

  app.get<{ Params: { id: string } }>("/api/messages/:id", async (request, reply) => {
    const message = database.getMessage(request.params.id);
    return message
      ? { ...message, attachments: database.attachmentsForMessageView(message.id) }
      : reply.code(404).send({ error: "消息不存在" });
  });

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    "/api/attachments/:id",
    async (request, reply) => {
      const attachment = database.attachmentForOwner(request.params.id);
      if (!attachment) return reply.code(404).send({ error: "附件不存在" });
      const disposition = request.query.download === "1" ? "attachment" : "inline";
      reply.header("Content-Type", attachment.mimeType);
      reply.header("Content-Length", String(attachment.size));
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
      reply.header(
        "Content-Disposition",
        `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
      );
      return reply.send(createReadStream(attachment.path));
    },
  );

  app.post("/api/ilink/login/start", async () => login.start());

  app.get<{ Params: { sessionId: string } }>("/api/ilink/login/:sessionId/qr.svg", async (request, reply) => {
    const content = login.getQrContent(request.params.sessionId);
    if (!content) return reply.code(404).send({ error: "二维码不存在或已过期" });
    const svg = await QRCode.toString(content, { type: "svg", margin: 1, width: 320, errorCorrectionLevel: "M" });
    return reply.type("image/svg+xml; charset=utf-8").send(svg);
  });

  app.get<{ Params: { sessionId: string } }>("/api/ilink/login/:sessionId/status", async (request) =>
    login.poll(request.params.sessionId));

  app.post<{ Params: { sessionId: string }; Body: Record<string, unknown> }>(
    "/api/ilink/login/:sessionId/verify",
    async (request, reply) => {
      const code = stringBody(request.body?.code, 10);
      if (!/^\d{4,10}$/.test(code)) return reply.code(400).send({ error: "配对码应为 4–10 位数字" });
      return login.poll(request.params.sessionId, code);
    },
  );

  app.delete<{ Params: { id: string } }>("/api/ilink/accounts/:id", async (request, reply) => {
    const account = database.getBotAccount(request.params.id);
    if (!account) return reply.code(404).send({ error: "微信账号不存在" });
    await bots.stop(account.id);
    database.removeBotAccount(account.id);
    return { ok: true };
  });

  app.get("/api/agent/settings", async () => {
    const settings = database.getAgentSettings(config.nanobot);
    const runtime = await nanobot.runtimeInfo(settings);
    return {
      ...settings,
      model: runtime.model || "",
    };
  });

  app.put<{ Body: Record<string, unknown> }>("/api/agent/settings", async (request, reply) => {
    const requestedBaseUrl = new URL(
      stringBody(request.body?.baseUrl, 1_000) || config.nanobot.baseUrl,
    ).toString();
    if (requestedBaseUrl !== config.nanobot.baseUrl) {
      return reply.code(400).send({ error: "Nanobot 地址由服务配置统一设置，不能在页面更改" });
    }
    const settings = {
      enabled: booleanBody(request.body?.enabled),
      baseUrl: config.nanobot.baseUrl,
      apiKey: config.nanobot.apiKey,
      model: "",
      instructions: stringBody(request.body?.instructions, 10_000),
      autoReply: booleanBody(request.body?.autoReply),
      notifyOnFailure: request.body?.notifyOnFailure !== false,
    };
    database.saveAgentSettings(settings);
    return { ok: true };
  });

  app.post("/api/agent/test", async () => nanobot.health(database.getAgentSettings(config.nanobot)));

  app.get("/api/nanobot/provider", async () => getNanobotProviderSettings(config));

  app.get<{ Querystring: { provider?: string } }>("/api/nanobot/provider/models", async (request) => {
    return getNanobotProviderModels(config, stringBody(request.query.provider, 80));
  });

  app.put<{ Body: Record<string, unknown> }>("/api/nanobot/provider", async (request) => {
    await saveNanobotProviderSettings(config, {
      provider: stringBody(request.body?.provider, 80),
      model: stringBody(request.body?.model, 200),
      apiBase: stringBody(request.body?.apiBase, 1_000),
      apiKey: stringBody(request.body?.apiKey, 2_000) || undefined,
      clearApiKey: booleanBody(request.body?.clearApiKey),
    });
    return { ok: true, autoReload: config.nanobot.autoReload };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/nanobot/provider/openai-oauth", async (request, reply) => {
    if (!config.nanobot.managed) {
      return reply.code(409).send({ error: "当前部署不支持从网页发起 OAuth，请在 Nanobot 容器或服务器终端完成授权" });
    }
    if (oauthInProgress) return reply.code(409).send({ error: "已有一个 OpenAI OAuth 授权正在进行" });
    oauthInProgress = true;
    const model = stringBody(request.body?.model, 200) || "openai-codex/gpt-5.6-sol";
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "nanobot",
          ["provider", "login", "openai-codex", "--set-main", "--model", model, "--config", config.nanobot.configPath],
          {
            timeout: 150_000,
            maxBuffer: 256 * 1024,
            env: {
              ...process.env,
              XDG_DATA_HOME: path.join(config.dataDir, "nanobot", "auth"),
            },
          },
          (error, _stdout, stderr) => {
            if (!error) return resolve();
            const detail = String(stderr || error.message)
              .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
              .replace(/[\r\n\t]+/g, " ")
              .slice(0, 300);
            reject(new Error(detail || "OpenAI OAuth 授权失败"));
          },
        );
      });
      return { ok: true, autoReload: config.nanobot.autoReload };
    } finally {
      oauthInProgress = false;
    }
  });

  app.get("/api/skills", async () => ({ skills: database.listSkills() }));

  app.get("/api/plugin-release", async () => getPluginReleaseInfo(config));

  app.post<{ Body: Buffer }>(
    "/api/plugin-release",
    { bodyLimit: PLUGIN_MAX_ARCHIVE_BYTES },
    async (request, reply) => {
      if (pluginPublishInProgress) return reply.code(409).send({ error: "已有插件版本正在发布，请稍后再试" });
      if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "请上传 ZIP 安装包" });
      pluginPublishInProgress = true;
      try {
        return await publishPluginRelease(config, request.body);
      } finally {
        pluginPublishInProgress = false;
      }
    },
  );

  app.post<{ Body: Record<string, unknown> }>("/api/skills", async (request) => {
    return {
      skill: database.createSkill({
        slug: stringBody(request.body?.slug, 60),
        name: stringBody(request.body?.name, 80),
        description: stringBody(request.body?.description, 500),
        content: stringBody(request.body?.content, 20_000),
        enabled: request.body?.enabled !== false,
      }),
    };
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/skills/:id",
    async (request) => {
      return {
        skill: database.updateSkill(request.params.id, {
          name: stringBody(request.body?.name, 80),
          description: stringBody(request.body?.description, 500),
          content: stringBody(request.body?.content, 20_000),
          enabled: request.body?.enabled !== false,
        }),
      };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/skills/:id", async (request) => {
    return { ok: true, action: database.deleteOrResetSkill(request.params.id) };
  });

  app.get("/api/sync-targets", async () => ({ targets: database.listSyncTargets() }));

  app.post<{ Body: Record<string, unknown> }>("/api/sync-targets", async (request) => {
    return database.createSyncTarget({
      name: stringBody(request.body?.name, 80),
      folder: stringBody(request.body?.folder, 200),
      primary: booleanBody(request.body?.primary),
    });
  });

  app.delete<{ Params: { id: string } }>("/api/sync-targets/:id", async (request, reply) => {
    return database.revokeSyncTarget(request.params.id)
      ? { ok: true }
      : reply.code(404).send({ error: "同步设备不存在" });
  });

  app.get<{ Querystring: { limit?: string } }>("/api/sync/pull", async (request, reply) => {
    const token = bearer(request);
    const target = token ? database.syncTargetForToken(token) : undefined;
    if (!target) return reply.code(401).send({ error: "Obsidian 同步令牌无效" });
    const requestedLimit = Math.min(Math.max(Number(request.query.limit || 50) || 50, 1), 100);
    const batch = database.getOrCreateSyncBatch(
      target.id,
      Math.min(requestedLimit, config.sync.batchSize),
    );
    return {
      schemaVersion: "1.1",
      collectionId: target.id,
      syncId: batch.batchId || "",
      serverTime: new Date().toISOString(),
      folder: target.folder,
      ...batch,
    };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/sync/ack", async (request, reply) => {
    const token = bearer(request);
    const target = token ? database.syncTargetForToken(token) : undefined;
    if (!target) return reply.code(401).send({ error: "Obsidian 同步令牌无效" });
    const batchId = stringBody(request.body?.batchId, 100);
    if (!batchId) return reply.code(400).send({ error: "缺少 batchId" });
    return {
      schemaVersion: "1.1",
      ok: true,
      syncId: batchId,
      ...database.acknowledgeSyncBatch(target.id, batchId),
    };
  });

  app.post("/api/sync/reset", async (request, reply) => {
    const token = bearer(request);
    const target = token ? database.syncTargetForToken(token) : undefined;
    if (!target) return reply.code(401).send({ error: "Obsidian 同步令牌无效" });
    return { schemaVersion: "1.1", ok: true, ...database.resetSyncTargetCursor(target.id) };
  });

  app.get<{ Params: { id: string } }>("/api/sync/attachments/:id", async (request, reply) => {
    const token = bearer(request);
    const target = token ? database.syncTargetForToken(token) : undefined;
    if (!target) return reply.code(401).send({ error: "Obsidian 同步令牌无效" });
    const attachment = database.attachmentForTarget(target.id, request.params.id);
    if (!attachment) return reply.code(404).send({ error: "附件不存在" });
    reply.header("Content-Type", attachment.mimeType);
    reply.header("Content-Length", String(attachment.size));
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
    return reply.send(createReadStream(attachment.path));
  });

  app.setErrorHandler(async (error, request, reply) => {
    const statusCode =
      typeof error === "object" && error && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    const isConflict = error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
    const safeStatus = isConflict ? 409 : statusCode && statusCode < 500 ? statusCode : 500;
    logger.error("接口请求失败", { requestId: crypto.randomUUID(), method: request.method, url: request.url, ...errorDetails(error) });
    await reply.code(safeStatus).send({
      error: isConflict
        ? "绑定信息已经存在"
        : safeStatus < 500 && error instanceof Error
          ? error.message
          : "服务处理失败，请稍后重试。",
    });
  });

  return app;
}
