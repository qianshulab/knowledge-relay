import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import { PassThrough } from "node:stream";
import path from "node:path";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import QRCode from "qrcode";

import type { BotManager } from "./bot-manager.js";
import { inferCaptureType, type CaptureInput } from "./capture.js";
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
import type { AppDatabase, ContentFormat, InboxSearchResult, OwnerProfile } from "./storage/database.js";
import { adminUiVersion, loadWebIndex, webRoot } from "./web-ui.js";
import type { WechatMcpIntakeManager } from "./wechat-mcp-intake.js";

type OwnerRequest = FastifyRequest & {
  owner?: OwnerProfile;
  sessionToken?: string;
  tenantDatabase?: AppDatabase;
};

type DiagramGenerationPhase = "analyzing" | "saving";

type DiagramGenerationJob = {
  tenantId: string;
  messageId: string;
  title: string;
  status: "generating" | "failed";
  phase: DiagramGenerationPhase;
  message: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
};

function publicDiagramGeneration(job: DiagramGenerationJob) {
  return {
    status: job.status,
    cached: false,
    generation: {
      phase: job.phase,
      message: job.message,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      ...(job.error ? { error: job.error } : {}),
    },
  };
}

function diagramGenerationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/sk-[A-Za-z0-9_-]{12,}/g, "[已隐藏密钥]").slice(0, 500);
}

function tenantDatabase(request: FastifyRequest): AppDatabase {
  const scoped = (request as OwnerRequest).tenantDatabase;
  if (!scoped) throw new Error("请先登录");
  return scoped;
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply): OwnerProfile | undefined {
  const owner = (request as OwnerRequest).owner;
  if (!owner || owner.role !== "admin") {
    void reply.code(403).send({ error: "仅系统管理员可执行此操作" });
    return undefined;
  }
  return owner;
}

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

function syncSchema(request: FastifyRequest): "1.1" | "1.2" {
  const requested = request.headers["x-knowledge-relay-schema"];
  return requested === "1.2" ? "1.2" : "1.1";
}

function inboxDateRange(question: string): { receivedAfter?: string; receivedBefore?: string } {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (question.includes("昨天")) {
    const yesterday = new Date(startOfToday);
    yesterday.setDate(yesterday.getDate() - 1);
    return { receivedAfter: yesterday.toISOString(), receivedBefore: startOfToday.toISOString() };
  }
  if (question.includes("今天")) return { receivedAfter: startOfToday.toISOString() };
  if (question.includes("本周")) {
    const monday = new Date(startOfToday);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return { receivedAfter: monday.toISOString() };
  }
  const days = question.includes("最近30天") || question.includes("近30天")
    ? 30
    : question.includes("最近7天") || question.includes("近7天")
      ? 7
      : 0;
  return days ? { receivedAfter: new Date(Date.now() - days * 86_400_000).toISOString() } : {};
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
  wechatMcp?: WechatMcpIntakeManager,
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const nanobot = new NanobotClient(config);
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const captureLimits = new Map<string, { count: number; resetAt: number }>();
  let oauthInProgress = false;
  let pluginPublishInProgress = false;
  const diagramGenerations = new Map<string, DiagramGenerationJob>();
  const activeKnowledgeChats = new Set<string>();

  void app.register(fastifyStatic, {
    root: webRoot,
    prefix: "/app/",
    decorateReply: false,
    cacheControl: true,
    maxAge: "1h",
    immutable: false,
  });

  for (const contentType of ["application/zip", "application/octet-stream", "application/x-zip-compressed", "image/jpeg", "image/png", "image/webp"]) {
    app.addContentTypeParser(contentType, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  }

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Knowledge-Relay-UI", adminUiVersion);
    reply.header("X-Content-Type-Options", "nosniff");
    if (!reply.hasHeader("X-Frame-Options")) reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (!reply.hasHeader("Content-Security-Policy")) {
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
    }
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
      url.startsWith("/app/") ||
      url === "/health" ||
      url === "/api/bootstrap" ||
      url === "/api/setup" ||
      url === "/api/login" ||
      url === "/api/register" ||
      url === "/api/captures" ||
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
    (request as OwnerRequest).tenantDatabase = database.forTenant(owner.id);
  });

  app.get("/", async (_request, reply) => reply
    .header("Cache-Control", "no-store, max-age=0")
    .type("text/html; charset=utf-8")
    .send(await loadWebIndex()));
  app.get("/health", async (_request, reply) => {
    const databaseHealthy = database.healthCheck();
    return reply.code(databaseHealthy ? 200 : 503).send({
      ok: databaseHealthy,
      database: databaseHealthy,
      time: new Date().toISOString(),
    });
  });
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
      username: stringBody(request.body?.username, 32) || "owner",
      displayName: stringBody(request.body?.displayName, 60),
      password: stringBody(request.body?.password, 200),
    });
    const ownerDatabase = database.forTenant(owner.id);
    const migrated = await ownerDatabase.claimLegacyData();
    const session = database.createSessionFor(owner.id, config.sessionDays);
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
    const owner = database.authenticate(
      stringBody(request.body?.username, 32),
      stringBody(request.body?.password, 200),
    );
    if (!owner) {
      const next = attempt && attempt.resetAt > currentTime
        ? { count: attempt.count + 1, resetAt: attempt.resetAt }
        : { count: 1, resetAt: currentTime + 15 * 60 * 1_000 };
      loginAttempts.set(key, next);
      return reply.code(401).send({ error: "用户名或密码错误" });
    }
    loginAttempts.delete(key);
    const session = database.createSessionFor(owner.id, config.sessionDays);
    reply.header("Set-Cookie", sessionCookie(config, session.token, config.sessionDays * 86_400));
    return { owner };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/register", async (request, reply) => {
    let user;
    try {
      user = database.registerWithInvitation({
        token: stringBody(request.body?.inviteToken, 500),
        username: stringBody(request.body?.username, 32),
        displayName: stringBody(request.body?.displayName, 60),
        password: stringBody(request.body?.password, 200),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "邀请注册失败";
      if (/UNIQUE constraint failed: users\.username/i.test(message)) {
        return reply.code(409).send({ error: "用户名已被使用" });
      }
      return reply.code(400).send({ error: message });
    }
    const session = database.createSessionFor(user.id, config.sessionDays);
    reply.header("Set-Cookie", sessionCookie(config, session.token, config.sessionDays * 86_400));
    return { owner: user };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/captures", async (request, reply) => {
    const token = bearer(request);
    const tenantId = token ? database.tenantForApiToken(token) : undefined;
    if (!tenantId) return reply.code(401).send({ error: "API 收件令牌无效" });
    const currentTime = Date.now();
    const currentLimit = captureLimits.get(tenantId);
    if (currentLimit && currentLimit.resetAt > currentTime && currentLimit.count >= 120) {
      reply.header("Retry-After", String(Math.ceil((currentLimit.resetAt - currentTime) / 1_000)));
      return reply.code(429).send({ error: "API 收件过于频繁，请稍后重试" });
    }
    captureLimits.set(tenantId, currentLimit && currentLimit.resetAt > currentTime
      ? { ...currentLimit, count: currentLimit.count + 1 }
      : { count: 1, resetAt: currentTime + 60_000 });
    const text = stringBody(request.body?.text, 100_000);
    const rawUrl = stringBody(request.body?.url, 4_000);
    let sourceUrl = "";
    if (rawUrl) {
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return reply.code(400).send({ error: "链接格式不正确" });
      }
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
        return reply.code(400).send({ error: "只支持不含账号信息的 HTTP/HTTPS 链接" });
      }
      sourceUrl = parsed.toString();
    }
    if (!text && !sourceUrl) return reply.code(400).send({ error: "请提供 text 或 url" });
    const externalId = stringBody(request.body?.externalId, 300) || crypto.randomUUID();
    const id = `api:${crypto.createHash("sha256").update(`${tenantId}:${externalId}`).digest("hex").slice(0, 32)}`;
    const scoped = database.forTenant(tenantId);
    if (scoped.getMessage(id)) return reply.code(200).send({ id, accepted: false, duplicate: true });
    const hostname = sourceUrl ? new URL(sourceUrl).hostname.toLowerCase() : "";
    const sourceType = hostname === "mp.weixin.qq.com" ? "wechat_article" : sourceUrl ? "web" : "manual";
    const capture: CaptureInput = {
      id,
      source: {
        channel: "api",
        type: sourceType,
        externalId,
        connectionId: "capture-api",
        name: stringBody(request.body?.sourceName, 100) || (hostname || "API 收件"),
        ...(sourceUrl ? { url: sourceUrl } : {}),
      },
      captureType: inferCaptureType([text, sourceUrl].filter(Boolean).join("\n"), []),
      actorId: stringBody(request.body?.actorId, 200) || "api",
      receivedAt: new Date().toISOString(),
      text: [text, sourceUrl && !text.includes(sourceUrl) ? sourceUrl : ""].filter(Boolean).join("\n"),
      attachments: [],
    };
    const accepted = bots.acceptCapture(tenantId, capture);
    if (!accepted.accepted) return reply.code(200).send({ id, accepted: false, duplicate: true });
    return reply.code(202).send({ id, accepted: true, status: "processing" });
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
    return { owner: tenantDatabase(request).updateOwnerDisplayName(displayName) };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/me/password", async (request, reply) => {
    const currentPassword = stringBody(request.body?.currentPassword, 200);
    const newPassword = stringBody(request.body?.newPassword, 200);
    const confirmPassword = stringBody(request.body?.confirmPassword, 200);
    if (newPassword.length < 8) return reply.code(400).send({ error: "新密码至少需要 8 个字符" });
    if (newPassword !== confirmPassword) return reply.code(400).send({ error: "两次输入的新密码不一致" });
    if (!tenantDatabase(request).changePassword(currentPassword, newPassword)) {
      return reply.code(400).send({ error: "当前密码不正确" });
    }
    reply.header("Set-Cookie", sessionCookie(config, "", 0));
    return { ok: true, loginRequired: true };
  });

  app.get("/api/admin/users", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return { users: tenantDatabase(request).listUsers() };
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/admin/users/:id/status",
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const disabled = request.body?.disabled === true;
      const user = tenantDatabase(request).setUserDisabled(request.params.id, disabled);
      if (disabled) await bots.pauseTenant(request.params.id);
      else await bots.resumeTenant(request.params.id);
      return { user };
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/admin/users/:id/reset-password",
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const newPassword = stringBody(request.body?.newPassword, 200);
      const confirmPassword = stringBody(request.body?.confirmPassword, 200);
      if (newPassword.length < 8) return reply.code(400).send({ error: "新密码至少需要 8 个字符" });
      if (newPassword !== confirmPassword) return reply.code(400).send({ error: "两次输入的新密码不一致" });
      return { ok: true, reset: tenantDatabase(request).resetUserPassword(request.params.id, newPassword) };
    },
  );

  app.delete<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/admin/users/:id",
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const scoped = tenantDatabase(request);
      const target = scoped.listUsers().find((user) => user.id === request.params.id);
      if (!target) return reply.code(404).send({ error: "用户不存在" });
      if (target.role === "admin") return reply.code(400).send({ error: "不能删除管理员账户" });
      const confirmation = stringBody(request.body?.confirmation, 120);
      if (confirmation.toLocaleLowerCase("zh-CN") !== target.username.toLocaleLowerCase("zh-CN")) {
        return reply.code(400).send({ error: "请输入该用户的完整用户名进行确认" });
      }
      await bots.pauseTenant(target.id);
      const deleted = scoped.deleteUser(target.id, confirmation);
      return { ok: true, deleted };
    },
  );

  app.get("/api/me/api-tokens", async (request) => ({
    tokens: tenantDatabase(request).listApiTokens(),
  }));

  app.post<{ Body: Record<string, unknown> }>("/api/me/api-tokens", async (request) =>
    tenantDatabase(request).createApiToken(stringBody(request.body?.name, 80)));

  app.delete<{ Params: { id: string } }>("/api/me/api-tokens/:id", async (request, reply) =>
    tenantDatabase(request).revokeApiToken(request.params.id)
      ? { ok: true }
      : reply.code(404).send({ error: "API 令牌不存在" }));

  app.get("/api/wechat-mcp", async (request) => {
    const source = database.getWechatMcpSource();
    const binding = tenantDatabase(request).getWechatMcpBindingForTenant();
    return {
      available: Boolean(source?.enabled && source.qrConfigured),
      source: source?.enabled ? {
        displayName: source.displayName,
        qrConfigured: source.qrConfigured,
        lastPollAt: source.lastPollAt,
        lastError: source.lastError,
      } : undefined,
      binding: binding ? {
        id: binding.id,
        wechatDisplayName: binding.wechatDisplayName,
        boundAt: binding.boundAt,
        lastMessageAt: binding.lastMessageAt,
      } : undefined,
    };
  });

  app.post("/api/wechat-mcp/binding-code", async (request, reply) => {
    const source = database.getWechatMcpSource();
    if (!source?.enabled || !source.qrConfigured) {
      return reply.code(409).send({ error: "管理员尚未启用微信助手收件" });
    }
    if (tenantDatabase(request).getWechatMcpBindingForTenant()) {
      return reply.code(409).send({ error: "当前账户已经绑定微信联系人" });
    }
    return tenantDatabase(request).createWechatMcpBindingCode(15);
  });

  app.delete("/api/wechat-mcp/binding", async (request, reply) =>
    tenantDatabase(request).deleteWechatMcpBindingForTenant()
      ? { ok: true }
      : reply.code(404).send({ error: "当前账户尚未绑定微信助手" }));

  app.get("/api/wechat-mcp/assistant-qr", async (_request, reply) => {
    const source = database.getWechatMcpSourceSecret();
    if (!source?.enabled || !source.qrPath) return reply.code(404).send({ error: "微信助手二维码尚未配置" });
    try {
      const stat = await fs.stat(source.qrPath);
      reply.header("Content-Type", source.qrMimeType || "image/jpeg");
      reply.header("Content-Length", String(stat.size));
      reply.header("Cache-Control", "private, max-age=300");
      reply.header("Content-Disposition", "inline");
      return reply.send(createReadStream(source.qrPath));
    } catch {
      return reply.code(404).send({ error: "微信助手二维码文件不存在" });
    }
  });

  app.get("/api/admin/wechat-mcp", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return {
      source: database.getWechatMcpSource(),
      bindings: database.listWechatMcpBindings(),
      users: tenantDatabase(request).listWechatMcpUserBindingStatuses(),
    };
  });

  app.put<{ Body: Record<string, unknown> }>("/api/admin/wechat-mcp", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const endpoint = stringBody(request.body?.endpoint, 1_000);
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      return reply.code(400).send({ error: "MCP 地址格式不正确" });
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      return reply.code(400).send({ error: "MCP 地址必须是 HTTP(S)，且不能包含用户名或密码" });
    }
    const source = database.saveWechatMcpSource({
      endpoint: parsed.toString(),
      authorization: stringBody(request.body?.authorization, 4_096) || undefined,
      displayName: stringBody(request.body?.displayName, 80) || "知流助手",
      account: stringBody(request.body?.account, 200),
      pollIntervalSeconds: Math.max(3, Math.min(60, Number(request.body?.pollIntervalSeconds) || 8)),
      enabled: booleanBody(request.body?.enabled),
    });
    if (wechatMcp) void wechatMcp.reload();
    return { source };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/admin/wechat-mcp/check", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    if (!wechatMcp) return reply.code(503).send({ error: "微信助手接收服务未启动" });
    const existing = database.getWechatMcpSourceSecret();
    const endpoint = stringBody(request.body?.endpoint, 1_000) || existing?.endpoint || "";
    const authorization = stringBody(request.body?.authorization, 4_096) || existing?.authorization || "";
    try {
      return await wechatMcp.check({
        id: existing?.id || "default",
        enabled: false,
        endpoint,
        authorization,
        authorizationConfigured: Boolean(authorization),
        displayName: stringBody(request.body?.displayName, 80) || existing?.displayName || "知流助手",
        account: stringBody(request.body?.account, 200) || existing?.account || "",
        pollIntervalSeconds: existing?.pollIntervalSeconds || 8,
        qrConfigured: existing?.qrConfigured || false,
        qrMimeType: existing?.qrMimeType,
        qrPath: existing?.qrPath,
        updatedAt: existing?.updatedAt || new Date().toISOString(),
      });
    } catch (error) {
      logger.warn("微信助手 MCP 连接检查失败", errorDetails(error));
      return reply.code(502).send({ error: error instanceof Error ? error.message : "MCP 连接检查失败" });
    }
  });

  app.put<{ Body: Buffer }>(
    "/api/admin/wechat-mcp/assistant-qr",
    { bodyLimit: 4 * 1024 * 1024 },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const mimeType = String(request.headers["content-type"] || "").split(";")[0] || "";
      const suffix = ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" } as Record<string, string>)[mimeType];
      if (!suffix || !Buffer.isBuffer(request.body) || request.body.length < 100) {
        return reply.code(400).send({ error: "请上传 JPG、PNG 或 WebP 格式的助手二维码" });
      }
      if (!database.getWechatMcpSource()) return reply.code(409).send({ error: "请先保存 MCP 配置" });
      const directory = path.join(config.dataDir, "system", "wechat-mcp");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const filePath = path.join(directory, `assistant-qr${suffix}`);
      const previous = database.getWechatMcpSourceSecret()?.qrPath;
      await fs.writeFile(filePath, request.body, { mode: 0o600 });
      if (previous && previous !== filePath) await fs.unlink(previous).catch(() => undefined);
      database.setWechatMcpQr(filePath, mimeType);
      return { ok: true, qrUrl: `/api/wechat-mcp/assistant-qr?v=${Date.now()}` };
    },
  );

  app.delete("/api/admin/wechat-mcp/assistant-qr", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const previous = database.getWechatMcpSourceSecret()?.qrPath;
    database.setWechatMcpQr();
    if (previous) await fs.unlink(previous).catch(() => undefined);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/wechat-mcp/bindings/:id", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return database.deleteWechatMcpBinding(request.params.id)
      ? { ok: true }
      : reply.code(404).send({ error: "绑定关系不存在" });
  });

  app.get<{ Querystring: { limit?: string; offset?: string; status?: string } }>("/api/admin/invitations", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const allowedStatuses = new Set(["all", "pending", "used", "expired", "revoked"]);
    const requestedStatus = stringBody(request.query.status, 20);
    const status = allowedStatuses.has(requestedStatus) ? requestedStatus as "all" | "pending" | "used" | "expired" | "revoked" : "all";
    const result = tenantDatabase(request).listInvitations({
      limit: Math.max(1, Math.min(50, Number(request.query.limit) || 10)),
      offset: Math.max(0, Number(request.query.offset) || 0),
      status,
    });
    return {
      invitations: result.invitations,
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.offset + result.invitations.length < result.total,
      },
    };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/admin/invitations", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const hours = Math.min(Math.max(Number(request.body?.hours || 72) || 72, 1), 24 * 30);
    return tenantDatabase(request).createInvitation(hours);
  });

  app.delete<{ Params: { id: string } }>("/api/admin/invitations/:id", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return tenantDatabase(request).revokeInvitation(request.params.id)
      ? { ok: true }
      : reply.code(404).send({ error: "邀请不存在或已失效" });
  });

  app.get("/api/dashboard", async (request) => {
    const scoped = tenantDatabase(request);
    const agentSettings = scoped.getAgentSettings(config.nanobot);
    const tenantId = scoped.currentTenantId();
    const diagramJobs = tenantId
      ? [...diagramGenerations.values()]
        .filter((job) => job.tenantId === tenantId && job.status === "generating")
        .map((job) => ({
          messageId: job.messageId,
          title: job.title,
          phase: job.phase,
          message: job.message,
          startedAt: job.startedAt,
          updatedAt: job.updatedAt,
        }))
      : [];
    return {
      ...scoped.dashboard(),
      agentEnabled: agentSettings.enabled,
      accounts: scoped.getBotAccounts().map((account) => publicAccount(account, bots.isRunning(account.id))),
      wechatAssistant: (() => {
        const source = database.getWechatMcpSource();
        const binding = scoped.getWechatMcpBindingForTenant();
        return {
          available: Boolean(source?.enabled && source.qrConfigured),
          bound: Boolean(binding),
          displayName: source?.displayName,
          lastMessageAt: binding?.lastMessageAt,
          error: source?.lastError,
        };
      })(),
      syncTargets: scoped.listSyncTargets(),
      diagramProcessing: diagramJobs.length,
      diagramJobs,
    };
  });

  app.get<{ Querystring: { limit?: string; before?: string; state?: string; active?: string; favorite?: string; format?: string; category?: string; domain?: string; organized?: string; q?: string } }>("/api/messages", async (request) => {
    const limit = Math.min(Math.max(Number(request.query.limit || 10) || 10, 1), 100);
    const before = Number(request.query.before || 0) || undefined;
    const requestedState = stringBody(request.query.state, 20);
    const state = (["inbox", "library", "archived"] as const).find((value) => value === requestedState);
    const requestedFormat = stringBody(request.query.format, 30);
    const format = (["wechat_article", "web_article", "document", "image", "audio", "video", "mixed", "text"] as ContentFormat[])
      .find((value) => value === requestedFormat);
    const options = {
      ...(state ? { state } : {}),
      ...(request.query.active === "1" ? { active: true } : {}),
      ...(request.query.favorite === "1" ? { favorite: true } : {}),
      ...(format ? { format } : {}),
      ...(stringBody(request.query.category, 40) ? { category: stringBody(request.query.category, 40) } : {}),
      ...(stringBody(request.query.domain, 120) ? { domain: stringBody(request.query.domain, 120) } : {}),
      ...(request.query.organized === "1" ? { organized: true } : {}),
      ...(stringBody(request.query.q, 200) ? { query: stringBody(request.query.q, 200) } : {}),
    };
    const scoped = tenantDatabase(request);
    const messages = scoped.listMessages(limit + 1, before, options);
    const hasMore = messages.length > limit;
    const page = messages.slice(0, limit);
    return {
      messages: page,
      pagination: {
        limit,
        total: scoped.countMessages(options),
        hasMore,
        nextBefore: hasMore ? page.at(-1)?.seq : undefined,
      },
    };
  });

  app.get<{ Querystring: { organized?: string; limit?: string } }>("/api/knowledge/facets", async (request) =>
    tenantDatabase(request).knowledgeFacets(
      request.query.organized === "1",
      Math.max(1, Math.min(100, Number(request.query.limit) || 10)),
    ),
  );

  app.get<{ Querystring: { messageId?: string } }>("/api/knowledge/map", async (request, reply) => {
    const scoped = tenantDatabase(request);
    const messageId = stringBody(request.query.messageId, 300);
    if (!messageId) return scoped.knowledgeMap();
    const diagram = scoped.getKnowledgeDiagram(messageId);
    return diagram || reply.code(404).send({ error: "这条内容还没有生成智能图解" });
  });

  app.post<{ Body: Record<string, unknown> }>("/api/inbox/query", async (request, reply) => {
    const question = stringBody(request.body?.question, 500);
    const filters = request.body?.filters && typeof request.body.filters === "object"
      ? request.body.filters as Record<string, unknown>
      : {};
    const requestedCategory = stringBody(filters.category, 40);
    const inferredCategory = !requestedCategory && /(?:待办|任务)/.test(question) ? "task" : "";
    const category = requestedCategory || inferredCategory;
    const domain = stringBody(filters.domain, 80);
    const knowledgePoint = stringBody(filters.knowledgePoint, 80);
    const tool = stringBody(filters.tool, 80);
    const requestedScope = stringBody(filters.scope, 20);
    const organized = requestedScope === "knowledge"
      ? true
      : requestedScope === "inbox"
        ? false
        : undefined;
    if (!question && !category && !domain && !knowledgePoint && !tool) {
      return reply.code(400).send({ error: "请输入想查找的内容" });
    }
    const parsedRange = inboxDateRange(question);
    const searchQuestion = question
      .replace(/(?:最近|近)\s*(?:7|30)\s*天/g, " ")
      .replace(/今天|昨天|本周/g, " ")
      .replace(inferredCategory ? /待办|任务/g : /$^/, " ")
      .trim();
    const filterName = domain || knowledgePoint || tool || category;
    let mode = "indexed_inbox_search";
    let interpretation = "";
    const scoped = tenantDatabase(request);
    const settings = scoped.getAgentSettings(config.nanobot);
    let plan: Awaited<ReturnType<NanobotClient["planInboxQuery"]>> | undefined;
    if (question && settings.enabled) {
      try {
        plan = await nanobot.planInboxQuery(question, {
          ...settings,
          baseUrl: config.nanobot.searchBaseUrl || settings.baseUrl,
        }, { tenantId: scoped.currentTenantId() });
        interpretation = plan.intent;
        mode = "nanobot_planned_search";
      } catch (error) {
        logger.warn("Nanobot 检索意图理解失败，已使用本地规则检索", errorDetails(error));
      }
    }
    const range = Object.keys(parsedRange).length
      ? parsedRange
      : {
        ...(plan?.receivedAfter ? { receivedAfter: plan.receivedAfter } : {}),
        ...(plan?.receivedBefore ? { receivedBefore: plan.receivedBefore } : {}),
      };
    const baseOptions = {
      limit: 12,
      organized,
      category,
      domain,
      knowledgePoint,
      tool,
      ...range,
    };
    const ranked = new Map<string, { item: InboxSearchResult; score: number }>();
    const addMatches = (items: InboxSearchResult[], score: number): void => {
      for (const item of items) {
        const current = ranked.get(item.id);
        ranked.set(item.id, { item, score: (current?.score || 0) + score });
      }
    };
    if (searchQuestion || category || domain || knowledgePoint || tool || Object.keys(range).length) {
      addMatches(scoped.searchInbox(searchQuestion, baseOptions), 30);
    }
    const expandedQueries = Array.from(new Set(plan?.queries || []))
      .filter((value) => value && value !== searchQuestion)
      .slice(0, 6);
    expandedQueries.forEach((query, index) => {
      addMatches(scoped.searchInbox(query, baseOptions), 22 - index * 2);
    });
    if (plan?.category && !category) {
      addMatches(scoped.searchInbox("", { ...baseOptions, category: plan.category }), 12);
    }
    if (!domain) {
      plan?.domains.forEach((value) => {
        addMatches(scoped.searchInbox("", { ...baseOptions, domain: value }), 12);
      });
    }
    if (!knowledgePoint) {
      plan?.knowledgePoints.forEach((value) => {
        addMatches(scoped.searchInbox("", { ...baseOptions, knowledgePoint: value }), 12);
      });
    }
    if (!tool) {
      plan?.tools.forEach((value) => {
        addMatches(scoped.searchInbox("", { ...baseOptions, tool: value }), 12);
      });
    }
    const matches = Array.from(ranked.values())
      .sort((left, right) => right.score - left.score || right.item.seq - left.item.seq)
      .slice(0, 8)
      .map((entry) => entry.item);
    const answer = matches.length
      ? `${interpretation ? `已理解为“${interpretation}”。` : ""}找到 ${matches.length} 条相关收件内容，最相关的是《${matches[0]!.title}》。`
      : `没有找到${filterName ? `与“${filterName}”匹配的` : "与这次查询匹配的"}收件内容。可以换一个更具体的说法再试。`;
    return {
      mode,
      readOnly: true,
      answer,
      interpretation,
      matches,
      scope: "inbox_only",
    };
  });

  app.get<{ Querystring: { limit?: string; offset?: string } }>("/api/knowledge/chats", async (request) => {
    const result = tenantDatabase(request).listKnowledgeConversations(
      Math.max(1, Math.min(50, Number(request.query.limit) || 30)),
      Math.max(0, Number(request.query.offset) || 0),
    );
    return { ...result, hasMore: result.conversations.length + (Number(request.query.offset) || 0) < result.total };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/knowledge/chats", async (request) => ({
    conversation: tenantDatabase(request).createKnowledgeConversation(stringBody(request.body?.title, 80)),
  }));

  app.get<{ Params: { id: string } }>("/api/knowledge/chats/:id", async (request, reply) => {
    const conversation = tenantDatabase(request).getKnowledgeConversation(request.params.id);
    return conversation ? { conversation } : reply.code(404).send({ error: "问答会话不存在" });
  });

  app.delete<{ Params: { id: string } }>("/api/knowledge/chats/:id", async (request, reply) =>
    tenantDatabase(request).deleteKnowledgeConversation(request.params.id)
      ? { ok: true }
      : reply.code(404).send({ error: "问答会话不存在" }));

  type KnowledgeChatUpdate =
    | { type: "status"; phase: "retrieving" | "reading" | "generating"; message: string }
    | { type: "delta"; content: string };
  const runKnowledgeChatAnswer = async (
    scoped: AppDatabase,
    conversation: NonNullable<ReturnType<AppDatabase["getKnowledgeConversation"]>>,
    question: string,
    tenantId: string,
    onUpdate?: (event: KnowledgeChatUpdate) => void,
  ) => {
      const runKey = `${tenantId}:${conversation.id}`;
      if (activeKnowledgeChats.has(runKey)) {
        throw new Error("这个会话正在生成回答，请稍候");
      }
      activeKnowledgeChats.add(runKey);
      try {
        const settings = scoped.getAgentSettings(config.nanobot);
        if (!settings.enabled) throw new Error("请先在系统设置中启用 AI 智能整理");
        scoped.appendKnowledgeChatMessage(conversation.id, "user", question);
        onUpdate?.({ type: "status", phase: "retrieving", message: "正在理解问题并检索知识库…" });
        const recentHistory = conversation.messages.slice(-10);
        const previousQuestions = recentHistory
          .filter((message) => message.role === "user")
          .slice(-2)
          .map((message) => message.content);
        const retrievalQuestion = [...previousQuestions, question].join("；").slice(0, 1_500);
        let plan: Awaited<ReturnType<NanobotClient["planInboxQuery"]>> | undefined;
        try {
          plan = await nanobot.planInboxQuery(retrievalQuestion, {
            ...settings,
            baseUrl: config.nanobot.searchBaseUrl || settings.baseUrl,
          }, { tenantId });
        } catch (error) {
          logger.warn("知识问答检索规划失败，已使用本地索引", errorDetails(error));
        }
        const ranked = new Map<string, { item: InboxSearchResult; score: number }>();
        type RankedKnowledgeChunk = ReturnType<AppDatabase["searchKnowledgeChunks"]>[number] & { combinedScore: number };
        const rankedChunks = new Map<string, RankedKnowledgeChunk>();
        const addMatches = (items: InboxSearchResult[], score: number): void => {
          for (const item of items) {
            const current = ranked.get(item.id);
            ranked.set(item.id, { item, score: (current?.score || 0) + score });
          }
        };
        const addChunkMatches = (query: string, score: number): void => {
          for (const item of scoped.searchKnowledgeChunks(query, 40)) {
            const key = `${item.messageId}:${item.ordinal}`;
            const current = rankedChunks.get(key);
            rankedChunks.set(key, { ...item, combinedScore: (current?.combinedScore || 0) + score + item.score });
          }
        };
        addMatches(scoped.searchInbox(retrievalQuestion, { organized: true, limit: 20 }), 30);
        addChunkMatches(retrievalQuestion, 30);
        Array.from(new Set(plan?.queries || [])).slice(0, 6).forEach((query, index) => {
          addMatches(scoped.searchInbox(query, { organized: true, limit: 20 }), 24 - index * 2);
          addChunkMatches(query, 24 - index * 2);
        });
        plan?.domains.forEach((domain) => addMatches(scoped.searchInbox("", { organized: true, domain, limit: 12 }), 12));
        plan?.knowledgePoints.forEach((knowledgePoint) => addMatches(scoped.searchInbox("", { organized: true, knowledgePoint, limit: 12 }), 12));
        plan?.tools.forEach((tool) => addMatches(scoped.searchInbox("", { organized: true, tool, limit: 12 }), 12));
        const previousCitationIds = recentHistory
          .filter((message) => message.role === "assistant")
          .slice(-1)
          .flatMap((message) => message.citations.map((citation) => citation.messageId));
        const chunksByMessage = new Map<string, RankedKnowledgeChunk[]>();
        Array.from(rankedChunks.values())
          .sort((left, right) => right.combinedScore - left.combinedScore || left.ordinal - right.ordinal)
          .forEach((chunk) => {
            const current = chunksByMessage.get(chunk.messageId) || [];
            if (current.length < 4) chunksByMessage.set(chunk.messageId, [...current, chunk]);
          });
        const chunkRankedIds = Array.from(chunksByMessage.entries())
          .sort((left, right) => right[1].reduce((sum, chunk) => sum + chunk.combinedScore, 0)
            - left[1].reduce((sum, chunk) => sum + chunk.combinedScore, 0))
          .map(([messageId]) => messageId);
        const candidateIds = Array.from(new Set([
          ...previousCitationIds,
          ...chunkRankedIds,
          ...Array.from(ranked.values())
            .sort((left, right) => right.score - left.score || right.item.seq - left.item.seq)
            .map((entry) => entry.item.id),
        ])).slice(0, 8);
        onUpdate?.({ type: "status", phase: "reading", message: `已找到 ${candidateIds.length} 篇候选资料，正在核对相关段落…` });
        const sources = candidateIds.flatMap((id) => {
          const detail = scoped.getMessageDetail(id);
          if (!detail || detail.agentStatus !== "completed") return [];
          const chunks = chunksByMessage.get(id) || scoped.knowledgeChunksForMessage(id, 4);
          const content = chunks.length
            ? chunks.map((chunk) => `## ${chunk.heading}\n${chunk.content}`).join("\n\n")
            : detail.contentMarkdown || detail.detailsMarkdown || detail.markdown || detail.text;
          return [{
            id: detail.id,
            title: detail.title,
            summary: detail.summary,
            content,
            domains: detail.domains,
            knowledgePoints: detail.knowledgePoints,
          }];
        });
        if (!sources.length) {
          const content = "当前知识库中没有找到足够依据回答这个问题。可以换用更明确的主题、人物、工具名称，或先把相关资料发送到收件台完成整理。";
          onUpdate?.({ type: "delta", content });
          const message = scoped.appendKnowledgeChatMessage(conversation.id, "assistant", content);
          return { message, followUps: [] };
        }
        onUpdate?.({ type: "status", phase: "generating", message: `正在依据 ${sources.length} 篇资料组织回答…` });
        const result = await nanobot.answerKnowledgeQuestion(
          question,
          sources,
          recentHistory.map((message) => ({ role: message.role, content: message.content })),
          settings,
          { tenantId, conversationId: conversation.id },
          onUpdate ? (content) => onUpdate({ type: "delta", content }) : undefined,
        );
        const citations = result.citedSourceIds.flatMap((id) => {
          const source = sources.find((item) => item.id === id);
          const sourceIndex = sources.findIndex((item) => item.id === id);
          return source ? [{ messageId: source.id, title: source.title, excerpt: source.summary, reference: `S${sourceIndex + 1}` }] : [];
        });
        const message = scoped.appendKnowledgeChatMessage(conversation.id, "assistant", result.answer, citations);
        return { message, followUps: result.followUps };
      } finally {
        activeKnowledgeChats.delete(runKey);
      }
  };

  const knowledgeChatRequest = (
    request: FastifyRequest<{ Params: { id: string }; Body: Record<string, unknown> }>,
    reply: FastifyReply,
  ) => {
    const scoped = tenantDatabase(request);
    const conversation = scoped.getKnowledgeConversation(request.params.id);
    if (!conversation) {
      void reply.code(404).send({ error: "问答会话不存在" });
      return;
    }
    const question = stringBody(request.body?.question, 2_000);
    if (!question) {
      void reply.code(400).send({ error: "请输入问题" });
      return;
    }
    const tenantId = scoped.currentTenantId();
    if (!tenantId) {
      void reply.code(401).send({ error: "请先登录" });
      return;
    }
    if (!scoped.getAgentSettings(config.nanobot).enabled) {
      void reply.code(409).send({ error: "请先在系统设置中启用 AI 智能整理" });
      return;
    }
    if (activeKnowledgeChats.has(`${tenantId}:${conversation.id}`)) {
      void reply.code(409).send({ error: "这个会话正在生成回答，请稍候" });
      return;
    }
    return { scoped, conversation, question, tenantId };
  };

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/knowledge/chats/:id/messages",
    async (request, reply) => {
      const input = knowledgeChatRequest(request, reply);
      if (!input) return reply;
      return runKnowledgeChatAnswer(input.scoped, input.conversation, input.question, input.tenantId);
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/knowledge/chats/:id/messages/stream",
    async (request, reply) => {
      const input = knowledgeChatRequest(request, reply);
      if (!input) return reply;
      const stream = new PassThrough();
      const write = (event: KnowledgeChatUpdate | {
        type: "done";
        message: ReturnType<AppDatabase["appendKnowledgeChatMessage"]>;
        followUps: string[];
      } | { type: "heartbeat"; at: string } | { type: "error"; error: string }) => {
        if (!stream.destroyed) stream.write(`${JSON.stringify(event)}\n`);
      };
      const heartbeat = setInterval(() => write({ type: "heartbeat", at: new Date().toISOString() }), 15_000);
      heartbeat.unref();
      reply.headers({
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      });
      void runKnowledgeChatAnswer(
        input.scoped,
        input.conversation,
        input.question,
        input.tenantId,
        write,
      ).then((result) => {
        write({ type: "done", ...result });
      }).catch((error) => {
        const message = error instanceof Error ? error.message : "知识问答暂时失败";
        write({ type: "error", error: message.replace(/[\r\n\t]+/g, " ").slice(0, 300) });
      }).finally(() => {
        clearInterval(heartbeat);
        stream.end();
      });
      return reply.send(stream);
    },
  );

  app.get<{ Params: { id: string } }>("/api/messages/:id", async (request, reply) => {
    const scoped = tenantDatabase(request);
    const message = scoped.getMessageDetail(request.params.id);
    return message
      ? { ...message, attachments: scoped.attachmentsForMessageView(message.id) }
      : reply.code(404).send({ error: "消息不存在" });
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/reprocess", async (request, reply) => {
    const scoped = tenantDatabase(request);
    if (!scoped.getMessage(request.params.id)) return reply.code(404).send({ error: "消息不存在" });
    const tenantId = scoped.currentTenantId();
    if (!tenantId) return reply.code(401).send({ error: "请先登录" });
    const result = bots.reprocessMessage(tenantId, request.params.id);
    return reply.code(result.accepted ? 202 : 200).send({
      ok: true,
      queued: result.accepted,
      status: "processing",
    });
  });

  app.get<{ Params: { id: string } }>("/api/messages/:id/diagram", async (request, reply) => {
    const scoped = tenantDatabase(request);
    if (!scoped.getMessage(request.params.id)) return reply.code(404).send({ error: "消息不存在" });
    const tenantId = scoped.currentTenantId();
    const generation = tenantId ? diagramGenerations.get(`${tenantId}:${request.params.id}`) : undefined;
    if (generation) return publicDiagramGeneration(generation);
    const diagram = scoped.getKnowledgeDiagram(request.params.id);
    return diagram
      ? { status: "ready", cached: true, diagram }
      : { status: "not_generated", cached: false };
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/messages/:id/diagram",
    async (request, reply) => {
      const scoped = tenantDatabase(request);
      const message = scoped.getMessageDetail(request.params.id);
      if (!message) return reply.code(404).send({ error: "消息不存在" });
      const force = request.body?.force === true;
      const cached = !force ? scoped.getKnowledgeDiagram(message.id) : undefined;
      if (cached) return { status: "ready", cached: true, diagram: cached };
      const settings = scoped.getAgentSettings(config.nanobot);
      if (!settings.enabled) return reply.code(409).send({ error: "请先在系统设置中启用 AI 智能整理" });
      const tenantId = scoped.currentTenantId();
      if (!tenantId) return reply.code(401).send({ error: "请先登录" });
      const generationKey = `${tenantId}:${message.id}`;
      const existing = diagramGenerations.get(generationKey);
      if (existing?.status === "generating") {
        return reply.code(202).send(publicDiagramGeneration(existing));
      }
      const now = new Date().toISOString();
      const generation: DiagramGenerationJob = {
        tenantId,
        messageId: message.id,
        title: message.title || message.text.slice(0, 80) || "未命名内容",
        status: "generating",
        phase: "analyzing",
        message: "正在分析资料结构并选择合适的图形",
        startedAt: now,
        updatedAt: now,
      };
      diagramGenerations.set(generationKey, generation);
      void (async () => {
        try {
          let result: Awaited<ReturnType<NanobotClient["generateKnowledgeDiagram"]>>;
          try {
            result = await nanobot.generateKnowledgeDiagram(
              message,
              settings,
              scoped.getEnabledSkills(),
              {
                tenantId,
                onRetry: (attempt, maximumAttempts) => {
                  generation.message = `模型输出未完整，正在自动修复（第 ${attempt}/${maximumAttempts} 次）`;
                  generation.updatedAt = new Date().toISOString();
                },
              },
            );
          } catch (modelError) {
            generation.phase = "saving";
            generation.message = "模型生成未完成，正在使用已整理内容构建稳定图解";
            generation.updatedAt = new Date().toISOString();
            result = scoped.knowledgeMap(message.id);
            result.selectionReason = "模型未返回可用结构，已根据已整理的摘要、要点和知识索引生成稳定图解";
            if (result.nodes.length < 2) {
              const root = result.nodes[0]!;
              const label = (message.summary || message.text || "当前资料的核心内容")
                .replace(/[\r\n\t]+/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 120) || "当前资料的核心内容";
              const pointId = `point:${crypto.createHash("sha256").update(label).digest("hex").slice(0, 12)}`;
              result.nodes.push({ id: pointId, label, type: "point", role: "result" });
              result.edges.push({ source: root.id, target: pointId, label: "核心内容", kind: "primary" });
            }
            logger.warn("AI 智能图解生成失败，已使用稳定结构兜底", {
              tenantId,
              messageId: message.id,
              ...errorDetails(modelError),
            });
          }
          generation.phase = "saving";
          generation.message = "图解结构已生成，正在保存结果";
          generation.updatedAt = new Date().toISOString();
          scoped.saveKnowledgeDiagram(message.id, result, message.revision);
          if (diagramGenerations.get(generationKey) === generation) diagramGenerations.delete(generationKey);
        } catch (error) {
          generation.status = "failed";
          generation.message = "智能图解生成失败，可重新尝试";
          generation.error = diagramGenerationError(error);
          generation.updatedAt = new Date().toISOString();
          logger.warn("智能图解生成失败", {
            tenantId,
            messageId: message.id,
            ...errorDetails(error),
          });
          const cleanup = setTimeout(() => {
            if (diagramGenerations.get(generationKey) === generation) diagramGenerations.delete(generationKey);
          }, 10 * 60_000);
          cleanup.unref();
        }
      })();
      return reply.code(202).send(publicDiagramGeneration(generation));
    },
  );

  app.delete<{ Params: { id: string } }>("/api/messages/:id", async (request, reply) => {
    const deleted = tenantDatabase(request).deleteMessage(request.params.id);
    return deleted
      ? { ok: true, deleted }
      : reply.code(404).send({ error: "消息不存在" });
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/messages/:id/library",
    async (request, reply) => {
      const requestedState = stringBody(request.body?.state, 20);
      if (requestedState && !["inbox", "library", "archived"].includes(requestedState)) {
        return reply.code(400).send({ error: "资源状态无效" });
      }
      return {
        message: tenantDatabase(request).updateResourceState(request.params.id, {
          ...(requestedState
            ? { state: requestedState as "inbox" | "library" | "archived" }
            : {}),
          ...(typeof request.body?.favorite === "boolean" ? { favorite: request.body.favorite } : {}),
          ...(typeof request.body?.read === "boolean" ? { read: request.body.read } : {}),
        }),
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    "/api/attachments/:id",
    async (request, reply) => {
      const attachment = tenantDatabase(request).attachmentForOwner(request.params.id);
      if (!attachment) return reply.code(404).send({ error: "附件不存在" });
      const disposition = request.query.download === "1" ? "attachment" : "inline";
      reply.header("Content-Type", attachment.mimeType);
      reply.header("Content-Length", String(attachment.size));
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
      reply.header("X-Frame-Options", "SAMEORIGIN");
      reply.header(
        "Content-Disposition",
        `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
      );
      return reply.send(createReadStream(attachment.path));
    },
  );

  app.post("/api/ilink/login/start", async (request) => login.start(tenantDatabase(request)));

  app.get<{ Params: { sessionId: string } }>("/api/ilink/login/:sessionId/qr.svg", async (request, reply) => {
    const tenantId = tenantDatabase(request).currentTenantId()!;
    const content = login.getQrContent(request.params.sessionId, tenantId);
    if (!content) return reply.code(404).send({ error: "二维码不存在或已过期" });
    const svg = await QRCode.toString(content, { type: "svg", margin: 1, width: 320, errorCorrectionLevel: "M" });
    return reply.type("image/svg+xml; charset=utf-8").send(svg);
  });

  app.get<{ Params: { sessionId: string } }>("/api/ilink/login/:sessionId/status", async (request) =>
    login.poll(request.params.sessionId, tenantDatabase(request).currentTenantId()!));

  app.post<{ Params: { sessionId: string }; Body: Record<string, unknown> }>(
    "/api/ilink/login/:sessionId/verify",
    async (request, reply) => {
      const code = stringBody(request.body?.code, 10);
      if (!/^\d{4,10}$/.test(code)) return reply.code(400).send({ error: "配对码应为 4–10 位数字" });
      return login.poll(request.params.sessionId, tenantDatabase(request).currentTenantId()!, code);
    },
  );

  app.delete<{ Params: { id: string } }>("/api/ilink/accounts/:id", async (request, reply) => {
    const scoped = tenantDatabase(request);
    const account = scoped.getBotAccount(request.params.id);
    if (!account) return reply.code(404).send({ error: "微信账号不存在" });
    await bots.stop(account.id);
    scoped.removeBotAccount(account.id);
    return { ok: true };
  });

  app.get("/api/agent/settings", async (request) => {
    const scoped = tenantDatabase(request);
    const settings = scoped.getAgentSettings(config.nanobot);
    const runtime = await nanobot.runtimeInfo(settings, { tenantId: scoped.currentTenantId() });
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
    tenantDatabase(request).saveAgentSettings(settings);
    return { ok: true };
  });

  app.post("/api/agent/test", async (request) => {
    const scoped = tenantDatabase(request);
    const provider = await getNanobotProviderSettings(config);
    const result = await nanobot.health(scoped.getAgentSettings(config.nanobot), {
      tenantId: scoped.currentTenantId(),
    });
    return {
      ...result,
      provider: provider.active.provider,
      model: provider.active.model,
    };
  });

  app.get("/api/nanobot/provider", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return getNanobotProviderSettings(config);
  });

  app.get<{ Querystring: { provider?: string } }>("/api/nanobot/provider/models", async (request) => {
    if ((request as OwnerRequest).owner?.role !== "admin") throw Object.assign(new Error("仅系统管理员可查看模型配置"), { statusCode: 403 });
    return getNanobotProviderModels(config, stringBody(request.query.provider, 80));
  });

  app.put<{ Body: Record<string, unknown> }>("/api/nanobot/provider", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
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
    if (!requireAdmin(request, reply)) return;
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

  app.get("/api/skills", async (request) => ({ skills: tenantDatabase(request).listSkills() }));

  app.get("/api/plugin-release", async () => getPluginReleaseInfo(config));

  app.post<{ Body: Buffer }>(
    "/api/plugin-release",
    { bodyLimit: PLUGIN_MAX_ARCHIVE_BYTES },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
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
      skill: tenantDatabase(request).createSkill({
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
    async (request, reply) => {
      const scoped = tenantDatabase(request);
      const current = scoped.listSkills().find((skill) => skill.id === request.params.id);
      if (current?.kind === "adapter" && !requireAdmin(request, reply)) return;
      return {
        skill: scoped.updateSkill(request.params.id, {
          name: stringBody(request.body?.name, 80),
          description: stringBody(request.body?.description, 500),
          content: stringBody(request.body?.content, 20_000),
          enabled: request.body?.enabled !== false,
        }),
      };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/skills/:id", async (request, reply) => {
    const scoped = tenantDatabase(request);
    const current = scoped.listSkills().find((skill) =>
      skill.id === request.params.id || `builtin:${skill.slug}` === request.params.id);
    if (current?.kind === "adapter" && !requireAdmin(request, reply)) return;
    return { ok: true, action: scoped.deleteOrResetSkill(request.params.id) };
  });

  app.get("/api/sync-targets", async (request) => ({ targets: tenantDatabase(request).listSyncTargets() }));

  app.post<{ Body: Record<string, unknown> }>("/api/sync-targets", async (request) => {
    return tenantDatabase(request).createSyncTarget({
      name: stringBody(request.body?.name, 80),
      folder: stringBody(request.body?.folder, 200),
      primary: booleanBody(request.body?.primary),
    });
  });

  app.delete<{ Params: { id: string } }>("/api/sync-targets/:id", async (request, reply) => {
    return tenantDatabase(request).revokeSyncTarget(request.params.id)
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
    const schemaVersion = syncSchema(request);
    reply.header("X-Knowledge-Relay-Schema", schemaVersion);
    return {
      schemaVersion,
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
    const schemaVersion = syncSchema(request);
    reply.header("X-Knowledge-Relay-Schema", schemaVersion);
    return {
      schemaVersion,
      ok: true,
      syncId: batchId,
      ...database.acknowledgeSyncBatch(target.id, batchId),
    };
  });

  app.post("/api/sync/reset", async (request, reply) => {
    const token = bearer(request);
    const target = token ? database.syncTargetForToken(token) : undefined;
    if (!target) return reply.code(401).send({ error: "Obsidian 同步令牌无效" });
    const schemaVersion = syncSchema(request);
    reply.header("X-Knowledge-Relay-Schema", schemaVersion);
    return { schemaVersion, ok: true, ...database.resetSyncTargetCursor(target.id) };
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
