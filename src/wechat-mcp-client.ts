type JsonRecord = Record<string, unknown>;

export type WechatMcpSession = {
  username: string;
  name: string;
  avatar?: string;
  lastMessage?: string;
  lastMessageTime?: number | string;
  isGroup: boolean;
};

export type WechatMcpMessage = {
  id: string;
  createTime?: number | string;
  senderUsername?: string;
  isSent: boolean;
  renderType?: string;
  type?: number | string;
  content?: string;
  title?: string;
  url?: string;
  fileName?: string;
  imageUrl?: string;
  videoUrl?: string;
  coverUrl?: string;
  fileUrl?: string;
};

export type WechatMcpCheck = {
  ok: true;
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  toolCount: number;
  accountCount: number;
  accounts: string[];
};

type RpcResponse = {
  result?: JsonRecord;
  error?: { code?: number; message?: string; data?: unknown };
};

class McpSessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSessionExpiredError";
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function timestamp(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
  }
  return undefined;
}

function parseEventStream(body: string): RpcResponse {
  const data = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .at(-1);
  if (!data) throw new Error("MCP 返回了空的 SSE 响应");
  return JSON.parse(data) as RpcResponse;
}

function toolPayload(result: JsonRecord | undefined): unknown {
  const structured = result?.structuredContent;
  if (structured !== undefined) return structured;
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const item of content) {
    const value = record(item);
    if (value?.type !== "text" || typeof value.text !== "string") continue;
    try {
      return JSON.parse(value.text);
    } catch {
      return value.text;
    }
  }
  return result;
}

function findArray(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const root = record(value);
  if (!root) return [];
  for (const key of keys) {
    if (Array.isArray(root[key])) return root[key] as unknown[];
  }
  for (const key of ["data", "result", "payload"]) {
    const nested = record(root[key]);
    if (!nested) continue;
    for (const candidate of keys) {
      if (Array.isArray(nested[candidate])) return nested[candidate] as unknown[];
    }
  }
  return [];
}

export class WechatMcpClient {
  private nextId = 1;
  private initialized = false;
  private server = { name: "", version: "", protocolVersion: "" };
  private tools = new Set<string>();
  private sessionId = "";

  constructor(
    readonly endpoint: string,
    private readonly authorization: string,
    private readonly timeoutMs = 20_000,
  ) {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("MCP 地址只支持 HTTP 或 HTTPS");
    if (url.username || url.password) throw new Error("MCP 地址不能包含用户名或密码");
    if (!authorization.trim()) throw new Error("请填写 MCP Authorization");
  }

  private async rpc(method: string, params: JsonRecord = {}): Promise<JsonRecord> {
    const credential = this.authorization.trim();
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: /^Bearer\s+/i.test(credential) ? credential : `Bearer ${credential}`,
            ...(this.sessionId && method !== "initialize" ? { "Mcp-Session-Id": this.sessionId } : {}),
            ...(this.server.protocolVersion && method !== "initialize"
              ? { "MCP-Protocol-Version": this.server.protocolVersion }
              : {}),
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const responseBody = await response.text();
        if ([404, 410].includes(response.status) && this.sessionId) {
          this.resetSession();
          throw new McpSessionExpiredError("MCP 会话已失效，正在重新建立连接");
        }
        if (!response.ok) {
          const error = new Error(`MCP 请求失败：HTTP ${response.status}`);
          if ([408, 425, 429].includes(response.status) || response.status >= 500) {
            lastError = error;
            if (attempt < 3) {
              await wait(attempt * 200);
              continue;
            }
          }
          throw error;
        }
        const announcedSession = response.headers.get("mcp-session-id")?.trim();
        if (announcedSession) this.sessionId = announcedSession;
        let payload: RpcResponse;
        try {
          payload = response.headers.get("content-type")?.includes("text/event-stream")
            ? parseEventStream(responseBody)
            : JSON.parse(responseBody) as RpcResponse;
        } catch {
          throw new Error("MCP 返回的不是有效 JSON-RPC 响应");
        }
        if (payload.error) {
          const detail = payload.error.message || String(payload.error.code || "未知错误");
          if (this.sessionId && /session|会话|not initialized|initialize first|expired|invalid/i.test(detail)) {
            this.resetSession();
            throw new McpSessionExpiredError(`MCP 会话已失效：${detail}`);
          }
          throw new Error(`MCP ${method} 失败：${detail}`);
        }
        return payload.result || {};
      } catch (error) {
        if (error instanceof McpSessionExpiredError) throw error;
        lastError = error;
        const transient = error instanceof TypeError
          || (error instanceof Error && /fetch failed|timeout|abort|ECONN|ENET|EAI_AGAIN|socket/i.test(error.message));
        if (!transient || attempt >= 3) break;
        await wait(attempt * 200);
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError || "未知网络错误");
    throw new Error(`MCP 网络连接暂时不可用，系统将自动重连：${detail}`);
  }

  private resetSession(): void {
    this.initialized = false;
    this.sessionId = "";
    this.tools.clear();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const result = await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "knowledge-relay", version: "1.0.0" },
    });
    const serverInfo = record(result.serverInfo);
    this.server = {
      name: text(serverInfo?.name) || "MCP Server",
      version: text(serverInfo?.version),
      protocolVersion: text(result.protocolVersion),
    };
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await this.rpc("tools/list", cursor ? { cursor } : {});
      for (const item of Array.isArray(page.tools) ? page.tools : []) {
        const tool = record(item);
        if (typeof tool?.name === "string") this.tools.add(tool.name);
      }
      cursor = text(page.nextCursor) || undefined;
      pages += 1;
    } while (cursor && pages < 20);
    for (const required of ["wechat.core.list_accounts", "wechat.chat.list_sessions", "wechat.chat.get_messages"]) {
      if (!this.tools.has(required)) throw new Error(`MCP 缺少必要工具：${required}`);
    }
    this.initialized = true;
  }

  private async callTool(name: string, args: JsonRecord): Promise<unknown> {
    await this.initialize();
    if (!this.tools.has(name)) throw new Error(`MCP 未提供工具：${name}`);
    try {
      return toolPayload(await this.rpc("tools/call", { name, arguments: args }));
    } catch (error) {
      if (!(error instanceof McpSessionExpiredError)) throw error;
      await this.initialize();
      if (!this.tools.has(name)) throw new Error(`MCP 重新连接后未提供工具：${name}`);
      return toolPayload(await this.rpc("tools/call", { name, arguments: args }));
    }
  }

  async listAccounts(): Promise<string[]> {
    const payload = await this.callTool("wechat.core.list_accounts", {});
    return findArray(payload, ["accounts", "items", "list"])
      .map((item) => {
        if (typeof item === "string") return item;
        const row = record(item);
        return text(row?.account) || text(row?.accountId) || text(row?.id) || text(row?.username);
      })
      .filter(Boolean);
  }

  async listSessions(account: string, limit = 30): Promise<WechatMcpSession[]> {
    const payload = await this.callTool("wechat.chat.list_sessions", {
      ...(account ? { account } : {}),
      limit: Math.max(1, Math.min(50, limit)),
      offset: 0,
      source: "auto",
      include_hidden: false,
      include_official: false,
      preview: true,
    });
    return findArray(payload, ["sessions", "items", "list"]).map((item) => {
      const row = record(item) || {};
      return {
        username: text(row.username) || text(row.id),
        name: text(row.name) || text(row.displayName) || text(row.username) || text(row.id),
        avatar: text(row.avatar) || undefined,
        lastMessage: text(row.lastMessage) || undefined,
        lastMessageTime: timestamp(row.lastMessageTime),
        isGroup: Boolean(row.isGroup),
      };
    }).filter((item) => item.username);
  }

  async getMessages(account: string, username: string, limit = 20): Promise<WechatMcpMessage[]> {
    const payload = await this.callTool("wechat.chat.get_messages", {
      ...(account ? { account } : {}),
      username,
      limit: Math.max(1, Math.min(50, limit)),
      offset: 0,
      source: "auto",
      order: "desc",
    });
    return findArray(payload, ["messages", "items", "list"]).map((item) => {
      const row = record(item) || {};
      return {
        id: text(row.id) || text(row.serverIdStr) || text(row.serverId) || text(row.localId),
        createTime: timestamp(row.createTime),
        senderUsername: text(row.senderUsername) || undefined,
        isSent: Boolean(row.isSent),
        renderType: text(row.renderType) || undefined,
        type: typeof row.type === "number" || typeof row.type === "string" ? row.type : undefined,
        content: text(row.content) || undefined,
        title: text(row.title) || undefined,
        url: text(row.url) || undefined,
        fileName: text(row.fileName) || undefined,
        imageUrl: text(row.imageUrl) || undefined,
        videoUrl: text(row.videoUrl) || undefined,
        coverUrl: text(row.coverUrl) || undefined,
        fileUrl: text(row.fileUrl) || undefined,
      };
    }).filter((item) => item.id);
  }

  async check(): Promise<WechatMcpCheck> {
    await this.initialize();
    const accounts = await this.listAccounts();
    return {
      ok: true,
      serverName: this.server.name,
      serverVersion: this.server.version,
      protocolVersion: this.server.protocolVersion,
      toolCount: this.tools.size,
      accountCount: accounts.length,
      accounts,
    };
  }

  async downloadMedia(value: string, maximumBytes: number): Promise<{ content: Buffer; mimeType: string }> {
    const url = new URL(value, this.endpoint);
    if (url.origin !== new URL(this.endpoint).origin) {
      throw new Error("拒绝从 MCP 服务之外的地址下载受保护媒体");
    }
    const credential = this.authorization.trim();
    const response = await fetch(url, {
      headers: { Authorization: /^Bearer\s+/i.test(credential) ? credential : `Bearer ${credential}` },
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, 60_000)),
    });
    if (!response.ok) throw new Error(`MCP 媒体下载失败：HTTP ${response.status}`);
    const announced = Number(response.headers.get("content-length") || 0);
    if (announced > maximumBytes) throw new Error("MCP 媒体超过大小限制");
    if (!response.body) return { content: Buffer.alloc(0), mimeType: response.headers.get("content-type") || "application/octet-stream" };
    const reader = response.body.getReader();
    const parts: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      total += chunk.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("MCP 媒体超过大小限制");
      }
      parts.push(Buffer.from(chunk));
    }
    return {
      content: Buffer.concat(parts, total),
      mimeType: (response.headers.get("content-type") || "application/octet-stream").split(";")[0] || "application/octet-stream",
    };
  }
}
