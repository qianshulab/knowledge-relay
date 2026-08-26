import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
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
import type { AppDatabase, ContentFormat, InboxSearchResult, KnowledgeMap, OwnerProfile } from "./storage/database.js";
import { adminUiVersion, loadWebIndex, webRoot } from "./web-ui.js";

type OwnerRequest = FastifyRequest & {
  owner?: OwnerProfile;
  sessionToken?: string;
  tenantDatabase?: AppDatabase;
};

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
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const nanobot = new NanobotClient(config);
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const captureLimits = new Map<string, { count: number; resetAt: number }>();
  let oauthInProgress = false;
  let pluginPublishInProgress = false;
  const diagramGenerations = new Map<string, Promise<KnowledgeMap>>();

  void app.register(fastifyStatic, {
    root: webRoot,
    prefix: "/app/",
    decorateReply: false,
    cacheControl: true,
    maxAge: "1h",
    immutable: false,
  });

  for (const contentType of ["application/zip", "application/octet-stream", "application/x-zip-compressed"]) {
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
    const user = database.registerWithInvitation({
      token: stringBody(request.body?.inviteToken, 500),
      username: stringBody(request.body?.username, 32),
      displayName: stringBody(request.body?.displayName, 60),
      password: stringBody(request.body?.password, 200),
    });
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

  app.get("/api/admin/invitations", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return { invitations: tenantDatabase(request).listInvitations() };
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
    return {
      ...scoped.dashboard(),
      accounts: scoped.getBotAccounts().map((account) => publicAccount(account, bots.isRunning(account.id))),
      syncTargets: scoped.listSyncTargets(),
    };
  });

  app.get<{ Querystring: { limit?: string; before?: string; state?: string; active?: string; favorite?: string; format?: string; category?: string; domain?: string; organized?: string } }>("/api/messages", async (request) => {
    const limit = Math.min(Math.max(Number(request.query.limit || 10) || 10, 1), 50);
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
      let generation = diagramGenerations.get(generationKey);
      if (!generation) {
        generation = (async () => {
          const result = await nanobot.generateKnowledgeDiagram(
            message,
            settings,
            scoped.getEnabledSkills(),
            { tenantId },
          );
          return scoped.saveKnowledgeDiagram(message.id, result, message.revision);
        })();
        diagramGenerations.set(generationKey, generation);
        void generation.finally(() => diagramGenerations.delete(generationKey)).catch(() => undefined);
      }
      const diagram = await generation;
      return { status: "ready", cached: false, diagram };
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
