import crypto from "node:crypto";

import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import type {
  GetUpdatesResponse,
  IlinkAccount,
  QrCodeResponse,
  QrStatusResponse,
} from "./types.js";

const VERSION = "0.1.0";

type ClientOptions = {
  apiBaseUrl: string;
  appId?: string;
  botAgent: string;
  token?: string;
};

function trailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function randomWechatUin(): string {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

function clientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class IlinkApiError extends Error {
  constructor(
    message: string,
    readonly ret?: number,
    readonly errcode?: number,
  ) {
    super(message);
    this.name = "IlinkApiError";
  }
}

export class IlinkClient {
  readonly apiBaseUrl: string;
  private readonly botAgent: string;
  private readonly appId: string;
  private readonly token?: string;

  constructor(options: ClientOptions) {
    this.apiBaseUrl = trailingSlash(options.apiBaseUrl);
    this.appId = options.appId || "bot";
    this.botAgent = options.botAgent;
    this.token = options.token;
  }

  static forAccount(config: AppConfig, account: IlinkAccount): IlinkClient {
    return new IlinkClient({
      apiBaseUrl: account.baseUrl,
      appId: config.ilink.appId,
      token: account.botToken,
      botAgent: config.ilink.botAgent,
    });
  }

  private headers(authenticated: boolean): Record<string, string> {
    const result: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin(),
      "iLink-App-Id": this.appId,
      "iLink-App-ClientVersion": String(clientVersion(VERSION)),
    };
    if (authenticated && this.token) result.Authorization = `Bearer ${this.token}`;
    return result;
  }

  private baseInfo(): { channel_version: string; bot_agent: string } {
    return { channel_version: VERSION, bot_agent: this.botAgent };
  }

  private async post<T>(
    endpoint: string,
    body: Record<string, unknown>,
    options: { authenticated?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = options.timeoutMs
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : undefined;
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(new URL(endpoint, this.apiBaseUrl), {
        method: "POST",
        headers: this.headers(options.authenticated ?? true),
        body: JSON.stringify({ ...body, base_info: this.baseInfo() }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`iLink ${endpoint} HTTP ${response.status}: ${raw.slice(0, 300)}`);
      }
      return JSON.parse(raw) as T;
    } finally {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async fetchQrCode(localTokens: string[] = []): Promise<QrCodeResponse> {
    return this.post<QrCodeResponse>(
      "ilink/bot/get_bot_qrcode?bot_type=3",
      { local_token_list: localTokens.slice(0, 10) },
      { authenticated: false, timeoutMs: 20_000 },
    );
  }

  async getQrStatus(
    qrcode: string,
    verifyCode?: string,
    signal?: AbortSignal,
  ): Promise<QrStatusResponse> {
    const endpoint = new URL("ilink/bot/get_qrcode_status", this.apiBaseUrl);
    endpoint.searchParams.set("qrcode", qrcode);
    if (verifyCode) endpoint.searchParams.set("verify_code", verifyCode);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 40_000);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: this.headers(false),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`iLink QR status HTTP ${response.status}: ${raw.slice(0, 300)}`);
      }
      return JSON.parse(raw) as QrStatusResponse;
    } catch (error) {
      if (isAbortError(error) && !signal?.aborted) return { status: "wait" };
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async getUpdates(
    cursor: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<GetUpdatesResponse> {
    try {
      const result = await this.post<GetUpdatesResponse>(
        "ilink/bot/getupdates",
        { get_updates_buf: cursor },
        { timeoutMs: timeoutMs + 5_000, signal },
      );
      const ret = result.ret ?? 0;
      const errcode = result.errcode ?? 0;
      if (ret !== 0 || errcode !== 0) {
        throw new IlinkApiError(
          result.errmsg || `iLink getupdates failed: ret=${ret}, errcode=${errcode}`,
          result.ret,
          result.errcode,
        );
      }
      return result;
    } catch (error) {
      if (isAbortError(error)) {
        return { ret: 0, msgs: [], get_updates_buf: cursor };
      }
      throw error;
    }
  }

  async sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    const result = await this.post<{ ret?: number; errmsg?: string }>(
      "ilink/bot/sendmessage",
      {
        msg: {
          to_user_id: toUserId,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text } }],
        },
      },
      { timeoutMs: 15_000 },
    );
    if ((result.ret ?? 0) !== 0) {
      throw new IlinkApiError(result.errmsg || "iLink sendmessage failed", result.ret);
    }
  }

  async notifyStart(): Promise<void> {
    await this.notify("ilink/bot/msg/notifystart");
  }

  async notifyStop(): Promise<void> {
    await this.notify("ilink/bot/msg/notifystop");
  }

  private async notify(endpoint: string): Promise<void> {
    try {
      await this.post(endpoint, {}, { timeoutMs: 10_000 });
    } catch (error) {
      logger.warn(`iLink ${endpoint.split("/").at(-1)} 失败，继续运行`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
