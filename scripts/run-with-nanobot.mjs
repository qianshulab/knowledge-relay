import "dotenv/config";

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const mode = process.argv[2] === "start" ? "start" : "dev";
const root = process.cwd();
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, "data"));
const workspace = path.resolve(
  process.env.NANOBOT_WORKSPACE || path.join(dataDir, "nanobot", "workspace"),
);
const configPath = path.join(dataDir, "nanobot", "config.json");
const managed = !["0", "false", "no", "off"].includes(
  String(process.env.NANOBOT_MANAGED ?? "true").toLowerCase(),
);
const children = [];
let stopping = false;

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

function launch(command, args) {
  const child = spawn(command, args, { cwd: root, env: process.env, stdio: "inherit" });
  children.push(child);
  return child;
}

function stop(signal = "SIGTERM") {
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

async function waitForNanobot(child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`Nanobot Runtime 启动失败，退出码 ${child.exitCode}`);
    }
    try {
      const response = await fetch("http://127.0.0.1:8900/health", {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Runtime may still be importing plugins.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Nanobot Runtime 在 30 秒内未通过健康检查");
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

if (managed) {
  const setup = launch(process.execPath, [path.join(root, "scripts", "setup-nanobot.mjs")]);
  const exitCode = await new Promise((resolve) => setup.once("exit", (code) => resolve(code ?? 1)));
  if (exitCode !== 0) process.exit(exitCode);
  let runtime;
  if (!(await portOpen(8900))) {
    runtime = launch("nanobot", [
      "serve",
      "--config", configPath,
      "--workspace", workspace,
      "--host", "127.0.0.1",
      "--port", "8900",
      "--timeout", "120",
    ]);
  }
  try {
    await waitForNanobot(runtime);
  } catch (error) {
    stop();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  runtime?.once("exit", (code, signal) => {
    if (stopping) return;
    console.error(`Nanobot Runtime 意外退出（${signal || code || "unknown"}）`);
    stop();
  });
}

const app = mode === "dev"
  ? launch(path.join(root, "node_modules", ".bin", "tsx"), ["watch", "src/index.ts"])
  : launch(process.execPath, [path.join(root, "dist", "index.js")]);
const appCode = await new Promise((resolve) => app.once("exit", (code) => resolve(code ?? 1)));
stop();
process.exit(appCode);
