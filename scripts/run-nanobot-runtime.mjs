import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const configPath = path.resolve(process.env.NANOBOT_CONFIG || "./data/nanobot/config.json");
const workspace = path.resolve(process.env.NANOBOT_WORKSPACE || "./data/nanobot/workspace");
const host = process.env.NANOBOT_SERVE_HOST || "127.0.0.1";
const port = Number(process.env.NANOBOT_SERVE_PORT || "8900");
const timeout = process.env.NANOBOT_SERVE_TIMEOUT || "28800";
const tenantPortStart = Number(process.env.NANOBOT_TENANT_PORT_START || "9000");
const tenantIdleMs = Number(process.env.NANOBOT_TENANT_IDLE_MS || String(30 * 60_000));
const maximumTenantRuntimes = Number(process.env.NANOBOT_MAX_TENANT_RUNTIMES || "12");
const searchWorkspace = path.resolve(
  process.env.NANOBOT_SEARCH_WORKSPACE || path.join(path.dirname(workspace), "search-workspace"),
);
const searchPort = process.env.NANOBOT_SEARCH_PORT || "8902";
const searchTimeout = process.env.NANOBOT_SEARCH_TIMEOUT || "45";
const searchScript = path.resolve(process.env.NANOBOT_SEARCH_SCRIPT || "./nanobot/search-runtime.py");
const catalogHost = process.env.NANOBOT_CATALOG_HOST || host;
const catalogPort = Number(process.env.NANOBOT_CATALOG_PORT || "8901");
const catalogTokens = new Set(
  [process.env.NANOBOT_RUNTIME_API_KEY, process.env.NANOBOT_API_KEY].filter(Boolean),
);
const catalogScript = path.resolve(
  process.env.NANOBOT_MODEL_CATALOG_SCRIPT || "./nanobot/model-catalog.py",
);
const projectNanobot = path.resolve(".nanobot-venv", "bin", "nanobot");
const nanobotExecutable = fs.existsSync(projectNanobot)
  ? projectNanobot
  : (process.env.PATH || "")
    .split(path.delimiter)
    .map((directory) => path.join(directory, "nanobot"))
    .find((candidate) => fs.existsSync(candidate));
let catalogPython = process.env.NANOBOT_PYTHON || "python3";
if (!process.env.NANOBOT_PYTHON && nanobotExecutable) {
  try {
    const shebang = fs.readFileSync(nanobotExecutable, "utf8").split(/\r?\n/, 1)[0] || "";
    if (shebang.startsWith("#!") && !shebang.slice(2).includes(" ") && /python(?:3(?:\.\d+)?)?$/.test(shebang.slice(2))) {
      catalogPython = shebang.slice(2);
    }
  } catch {
    // Fall back to python3; Docker places Nanobot's virtualenv first in PATH.
  }
}

let restarting = false;
let stopping = false;
let restartTimer;
let watcher;
let nextTenantPort = tenantPortStart;
let nextTenantSearchPort = Number(process.env.NANOBOT_TENANT_SEARCH_PORT_START || String(tenantPortStart + 1_000));
const tenantRuntimes = new Map();
const tenantSearchRuntimes = new Map();
const expectedStops = new WeakSet();

function isRunning(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function authorized(request) {
  if (!catalogTokens.size) return true;
  const token = request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice(7)
    : "";
  return catalogTokens.has(token);
}

const catalogServer = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://nanobot.local");
  if (request.method === "GET" && url.pathname === "/health") {
    return json(response, 200, { status: "ok" });
  }
  if (request.method !== "GET" || url.pathname !== "/models") {
    return json(response, 404, { error: "not_found" });
  }
  if (!authorized(request)) return json(response, 401, { error: "unauthorized" });
  const provider = String(url.searchParams.get("provider") || "").trim();
  if (!/^[a-z0-9_-]{1,80}$/.test(provider)) {
    return json(response, 400, { error: "invalid_provider" });
  }
  execFile(
    catalogPython,
    [catalogScript, "--config", configPath, "--provider", provider],
    { env: process.env, timeout: 20_000, maxBuffer: 1024 * 1024 },
    (error, stdout) => {
      if (error) return json(response, 502, { error: "catalog_unavailable" });
      try {
        return json(response, 200, JSON.parse(stdout));
      } catch {
        return json(response, 502, { error: "invalid_catalog_response" });
      }
    },
  );
});

function copyDirectory(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function prepareTenantWorkspace(key) {
  const destination = path.join(workspace, "tenants", key, "workspace");
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(destination, "artifacts"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(destination, "sessions"), { recursive: true, mode: 0o700 });
  for (const directory of ["skills", ".upstream", "nanobot-bin"]) {
    copyDirectory(path.join(workspace, directory), path.join(destination, directory));
  }
  const agents = path.join(workspace, "AGENTS.md");
  if (fs.existsSync(agents)) fs.copyFileSync(agents, path.join(destination, "AGENTS.md"));
  return destination;
}

function watchChild(child, label, onUnexpectedExit) {
  child.once("error", (error) => {
    console.error(`${label} 无法启动：${error.message}`);
  });
  child.once("exit", (code, signal) => {
    if (stopping || restarting || expectedStops.has(child)) return;
    console.error(`${label} 意外退出（${signal || code || "unknown"}）`);
    onUnexpectedExit?.();
  });
  return child;
}

async function waitForHealth(runtimePort, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(child)) throw new Error("Nanobot 用户 Runtime 启动失败");
    try {
      const response = await fetch(`http://127.0.0.1:${runtimePort}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Runtime may still be importing tools and skills.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Nanobot 用户 Runtime 在 30 秒内未就绪");
}

async function stopTenant(entry, signal = "SIGTERM") {
  if (!entry || !isRunning(entry.child)) return;
  expectedStops.add(entry.child);
  const exited = new Promise((resolve) => entry.child.once("exit", resolve));
  entry.child.kill(signal);
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (isRunning(entry.child)) entry.child.kill("SIGKILL");
}

async function evictTenantRuntime(runtimes) {
  const candidates = [...runtimes.values()]
    .filter((entry) => entry.active === 0)
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  const candidate = candidates[0];
  if (!candidate) throw new Error("当前活跃用户数已达 Runtime 安全上限");
  runtimes.delete(candidate.key);
  await stopTenant(candidate);
}

async function ensureTenantRuntime(key) {
  const existing = tenantRuntimes.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    await existing.ready;
    return existing;
  }
  if (tenantRuntimes.size >= maximumTenantRuntimes) await evictTenantRuntime(tenantRuntimes);
  const runtimePort = nextTenantPort++;
  const tenantWorkspace = prepareTenantWorkspace(key);
  const child = spawn(nanobotExecutable || "nanobot", [
    "serve",
    "--config", configPath,
    "--workspace", tenantWorkspace,
    "--host", "127.0.0.1",
    "--port", String(runtimePort),
    "--timeout", timeout,
  ], { env: process.env, stdio: "inherit" });
  const entry = {
    key,
    child,
    port: runtimePort,
    workspace: tenantWorkspace,
    lastUsedAt: Date.now(),
    active: 0,
    ready: undefined,
  };
  entry.ready = waitForHealth(runtimePort, child).catch(async (error) => {
    tenantRuntimes.delete(key);
    await stopTenant(entry, "SIGTERM");
    throw error;
  });
  tenantRuntimes.set(key, entry);
  watchChild(child, `Nanobot 用户 Runtime ${key}`, () => tenantRuntimes.delete(key));
  await entry.ready;
  console.log(`Nanobot 用户 Runtime 已就绪：${key}`);
  return entry;
}

async function ensureTenantSearchRuntime(key) {
  const existing = tenantSearchRuntimes.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    await existing.ready;
    return existing;
  }
  if (tenantSearchRuntimes.size >= maximumTenantRuntimes) {
    await evictTenantRuntime(tenantSearchRuntimes);
  }
  const runtimePort = nextTenantSearchPort++;
  const tenantWorkspace = path.join(searchWorkspace, "tenants", key, "workspace");
  fs.mkdirSync(tenantWorkspace, { recursive: true, mode: 0o700 });
  const child = spawn(catalogPython, [
    searchScript,
    "--config", configPath,
    "--workspace", tenantWorkspace,
    "--host", "127.0.0.1",
    "--port", String(runtimePort),
    "--timeout", searchTimeout,
  ], { env: process.env, stdio: "inherit" });
  const entry = {
    key,
    child,
    port: runtimePort,
    workspace: tenantWorkspace,
    lastUsedAt: Date.now(),
    active: 0,
    ready: undefined,
  };
  entry.ready = waitForHealth(runtimePort, child).catch(async (error) => {
    tenantSearchRuntimes.delete(key);
    await stopTenant(entry, "SIGTERM");
    throw error;
  });
  tenantSearchRuntimes.set(key, entry);
  watchChild(child, `Nanobot 用户检索 Runtime ${key}`, () => tenantSearchRuntimes.delete(key));
  await entry.ready;
  console.log(`Nanobot 用户检索 Runtime 已就绪：${key}`);
  return entry;
}

function tenantKey(request) {
  const raw = String(request.headers["x-knowledge-relay-tenant"] || "").trim().toLowerCase();
  if (!raw) return "personal";
  return /^[a-f0-9]{16}$/.test(raw) ? raw : undefined;
}

function createTenantBroker(runtimes, ensureRuntime) {
  return http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://nanobot.local");
  if (request.method === "GET" && url.pathname === "/health") {
    return json(response, 200, {
      status: "ok",
      isolation: "dedicated-runtime-per-tenant",
      activeRuntimes: runtimes.size,
    });
  }
  const key = tenantKey(request);
  if (!key) return json(response, 400, { error: "invalid_tenant" });
  let entry;
  try {
    entry = await ensureRuntime(key);
  } catch (error) {
    return json(response, 503, {
      error: "tenant_runtime_unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  entry.active += 1;
  entry.lastUsedAt = Date.now();
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    entry.active = Math.max(0, entry.active - 1);
    entry.lastUsedAt = Date.now();
  };
  const headers = { ...request.headers, host: `127.0.0.1:${entry.port}` };
  delete headers["x-knowledge-relay-tenant"];
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: entry.port,
    method: request.method,
    path: request.url,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
    upstreamResponse.once("end", finalize);
    upstreamResponse.once("close", finalize);
  });
  upstream.once("error", (error) => {
    finalize();
    if (!response.headersSent) json(response, 502, { error: "runtime_proxy_failed", message: error.message });
    else response.destroy(error);
  });
  request.once("aborted", () => {
    finalize();
    upstream.destroy();
  });
  response.once("close", finalize);
  request.pipe(upstream);
  });
}

const brokerServer = createTenantBroker(tenantRuntimes, ensureTenantRuntime);
const searchBrokerServer = createTenantBroker(tenantSearchRuntimes, ensureTenantSearchRuntime);

async function stopAllRuntimes(signal = "SIGTERM") {
  const tenants = [...tenantRuntimes.values(), ...tenantSearchRuntimes.values()];
  tenantRuntimes.clear();
  tenantSearchRuntimes.clear();
  await Promise.all(tenants.map((entry) => stopTenant(entry, signal)));
}

async function restart() {
  if (stopping || restarting) return;
  restarting = true;
  await stopAllRuntimes("SIGTERM");
  restarting = false;
  if (!stopping) {
    console.log("Nanobot 配置已更新，正在重新加载 Runtime…");
  }
}

async function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  watcher?.close();
  clearInterval(idleTimer);
  brokerServer.close();
  searchBrokerServer.close();
  catalogServer.close();
  await stopAllRuntimes(signal);
  process.exit(0);
}

for (const server of [catalogServer, brokerServer, searchBrokerServer]) {
  server.once("error", (error) => {
    console.error(`Nanobot 服务无法启动：${error.message}`);
    void stop("SIGTERM");
  });
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

watcher = fs.watch(path.dirname(configPath), (_event, fileName) => {
  if (fileName && String(fileName) !== path.basename(configPath)) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => void restart(), 700);
});

const idleTimer = setInterval(() => {
  const threshold = Date.now() - tenantIdleMs;
  for (const runtimes of [tenantRuntimes, tenantSearchRuntimes]) {
    for (const [key, entry] of runtimes) {
      if (entry.active > 0 || entry.lastUsedAt >= threshold) continue;
      runtimes.delete(key);
      void stopTenant(entry);
    }
  }
}, 60_000);
idleTimer.unref();

catalogServer.listen(catalogPort, catalogHost, () => {
  console.log(`Nanobot 模型目录已就绪：http://${catalogHost}:${catalogPort}`);
});
brokerServer.listen(port, host, () => {
  console.log(`Nanobot 多用户 Runtime 网关已就绪：http://${host}:${port}`);
});
searchBrokerServer.listen(Number(searchPort), host, () => {
  console.log(`Nanobot 多用户检索网关已就绪：http://${host}:${searchPort}`);
});
