import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const configPath = path.resolve(process.env.NANOBOT_CONFIG || "./data/nanobot/config.json");
const workspace = path.resolve(process.env.NANOBOT_WORKSPACE || "./data/nanobot/workspace");
const host = process.env.NANOBOT_SERVE_HOST || "127.0.0.1";
const port = process.env.NANOBOT_SERVE_PORT || "8900";
const timeout = process.env.NANOBOT_SERVE_TIMEOUT || "120";
const searchWorkspace = path.resolve(
  process.env.NANOBOT_SEARCH_WORKSPACE || path.join(path.dirname(workspace), "search-workspace"),
);
const searchPort = process.env.NANOBOT_SEARCH_PORT || "8902";
const searchTimeout = process.env.NANOBOT_SEARCH_TIMEOUT || "45";
const searchScript = path.resolve(
  process.env.NANOBOT_SEARCH_SCRIPT || "./nanobot/search-runtime.py",
);
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
    // Fall back to python3; the Docker image puts Nanobot's venv first in PATH.
  }
}
let runtime;
let searchRuntime;
let restarting = false;
let stopping = false;
let restartTimer;
let watcher;
const expectedStops = new WeakSet();

function isRunning(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

function catalogJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

const catalogServer = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://nanobot.local");
  if (request.method === "GET" && url.pathname === "/health") {
    return catalogJson(response, 200, { status: "ok" });
  }
  if (request.method !== "GET" || url.pathname !== "/models") {
    return catalogJson(response, 404, { error: "not_found" });
  }
  const bearerToken = request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice(7)
    : "";
  if (catalogTokens.size && !catalogTokens.has(bearerToken)) {
    return catalogJson(response, 401, { error: "unauthorized" });
  }
  const provider = String(url.searchParams.get("provider") || "").trim();
  if (!/^[a-z0-9_-]{1,80}$/.test(provider)) {
    return catalogJson(response, 400, { error: "invalid_provider" });
  }
  execFile(
    catalogPython,
    [catalogScript, "--config", configPath, "--provider", provider],
    { env: process.env, timeout: 20_000, maxBuffer: 1024 * 1024 },
    (error, stdout) => {
      if (error) {
        return catalogJson(response, 502, { error: "catalog_unavailable" });
      }
      try {
        return catalogJson(response, 200, JSON.parse(stdout));
      } catch {
        return catalogJson(response, 502, { error: "invalid_catalog_response" });
      }
    },
  );
});

catalogServer.once("error", (error) => {
  console.error(`Nanobot 模型目录无法启动：${error.message}`);
  stopping = true;
  watcher?.close();
  if (runtime && runtime.exitCode === null) runtime.kill("SIGTERM");
  if (searchRuntime && searchRuntime.exitCode === null) searchRuntime.kill("SIGTERM");
  process.exit(1);
});

function watchRuntime(child, label) {
  child.once("error", (error) => {
    console.error(`${label} 无法启动：${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (stopping || restarting || expectedStops.has(child)) return;
    console.error(`${label} 意外退出（${signal || code || "unknown"}）`);
    if (isRunning(runtime)) runtime.kill("SIGTERM");
    if (isRunning(searchRuntime)) searchRuntime.kill("SIGTERM");
    process.exit(code || 1);
  });
  return child;
}

function start() {
  fs.mkdirSync(searchWorkspace, { recursive: true, mode: 0o700 });
  runtime = watchRuntime(spawn(nanobotExecutable || "nanobot", [
    "serve",
    "--config", configPath,
    "--workspace", workspace,
    "--host", host,
    "--port", port,
    "--timeout", timeout,
  ], { env: process.env, stdio: "inherit" }), "Nanobot 整理 Runtime");
  searchRuntime = watchRuntime(spawn(catalogPython, [
    searchScript,
    "--config", configPath,
    "--workspace", searchWorkspace,
    "--host", host,
    "--port", searchPort,
    "--timeout", searchTimeout,
  ], { env: process.env, stdio: "inherit" }), "Nanobot 检索 Runtime");
}

async function stopRuntimes(signal) {
  const active = [runtime, searchRuntime].filter(isRunning);
  const exits = active.map((child) => new Promise((resolve) => child.once("exit", resolve)));
  for (const child of active) {
    expectedStops.add(child);
    child.kill(signal);
  }
  await Promise.race([
    Promise.all(exits),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  const forced = active.filter(isRunning);
  for (const child of forced) child.kill("SIGKILL");
  if (forced.length) {
    await Promise.race([
      Promise.all(exits),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

async function restart() {
  if (stopping || restarting) return;
  restarting = true;
  await stopRuntimes("SIGTERM");
  restarting = false;
  if (!stopping) {
    console.log("Nanobot 配置已更新，正在重新加载 Runtime…");
    start();
  }
}

async function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  watcher?.close();
  if (catalogServer.listening) catalogServer.close();
  await stopRuntimes(signal);
  process.exit(0);
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

watcher = fs.watch(path.dirname(configPath), (_event, fileName) => {
  if (fileName && String(fileName) !== path.basename(configPath)) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => void restart(), 700);
});

catalogServer.listen(catalogPort, catalogHost, () => {
  console.log(`Nanobot 模型目录已就绪：http://${catalogHost}:${catalogPort}`);
  start();
});
