import crypto from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import QRCode from "qrcode";

import type { BotManager } from "./bot-manager.js";
import type { AppConfig } from "./config.js";
import type { AccountLoginManager } from "./ilink/account-login-manager.js";
import { errorDetails, logger } from "./logger.js";
import { NanobotClient } from "./nanobot.js";
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
    const archive = path.resolve("release/knowledge-relay-obsidian.zip");
    if (!existsSync(archive)) return reply.code(404).send({ error: "插件安装包尚未生成" });
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", "attachment; filename=knowledge-relay-obsidian.zip");
    return reply.send(createReadStream(archive));
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

  app.post<{ Body: Record<string, unknown> }>("/api/me/password", async (request, reply) => {
    const currentPassword = stringBody(request.body?.currentPassword, 200);
    const newPassword = stringBody(request.body?.newPassword, 200);
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

  app.get("/api/skills", async () => ({ skills: database.listSkills() }));

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

  app.get("/api/sync/pull", async (request, reply) => {
    const token = bearer(request);
    const target = token ? database.syncTargetForToken(token) : undefined;
    if (!target) return reply.code(401).send({ error: "Obsidian 同步令牌无效" });
    return { folder: target.folder, ...database.getOrCreateSyncBatch(target.id, config.sync.batchSize) };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/sync/ack", async (request, reply) => {
    const token = bearer(request);
    const target = token ? database.syncTargetForToken(token) : undefined;
    if (!target) return reply.code(401).send({ error: "Obsidian 同步令牌无效" });
    const batchId = stringBody(request.body?.batchId, 100);
    if (!batchId) return reply.code(400).send({ error: "缺少 batchId" });
    return { ok: true, ...database.acknowledgeSyncBatch(target.id, batchId) };
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
