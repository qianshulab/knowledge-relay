export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !(init.body instanceof Blob) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", "application/json");
  const response = await fetch(url, { ...init, headers, credentials: "same-origin" });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload
      ? String((payload as { error: unknown }).error)
      : `请求失败（${response.status}）`;
    if (response.status === 401) window.dispatchEvent(new CustomEvent("knowledge-relay:unauthorized"));
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

export async function streamApi<T>(
  url: string,
  init: RequestInit,
  onEvent: (event: T) => void | Promise<void>,
): Promise<void> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !(init.body instanceof Blob) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", "application/x-ndjson");
  const response = await fetch(url, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    const isJson = response.headers.get("content-type")?.includes("application/json");
    const payload = isJson ? await response.json() : await response.text();
    const message = typeof payload === "object" && payload && "error" in payload
      ? String((payload as { error: unknown }).error)
      : `请求失败（${response.status}）`;
    if (response.status === 401) window.dispatchEvent(new CustomEvent("knowledge-relay:unauthorized"));
    throw new ApiError(message, response.status);
  }
  if (!response.body) throw new ApiError("服务器没有返回流式响应", 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const consume = async (line: string) => {
    const value = line.trim();
    if (!value) return;
    await onEvent(JSON.parse(value) as T);
  };
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) await consume(line);
    if (done) break;
  }
  if (pending.trim()) await consume(pending);
}

export function jsonBody(value: unknown): RequestInit {
  return { body: JSON.stringify(value) };
}

export function attachmentUrl(id: string, download = false): string {
  return `/api/attachments/${encodeURIComponent(id)}${download ? "?download=1" : ""}`;
}
