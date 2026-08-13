import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const configPath = path.resolve(process.env.NANOBOT_CONFIG || "./data/nanobot/config.json");
const workspace = path.resolve(process.env.NANOBOT_WORKSPACE || "./data/nanobot/workspace");
const host = process.env.NANOBOT_SERVE_HOST || "127.0.0.1";
const port = process.env.NANOBOT_SERVE_PORT || "8900";
const timeout = process.env.NANOBOT_SERVE_TIMEOUT || "120";
let runtime;
let restarting = false;
let stopping = false;
let restartTimer;
let watcher;

function start() {
  runtime = spawn("nanobot", [
    "serve",
    "--config", configPath,
    "--workspace", workspace,
    "--host", host,
    "--port", port,
    "--timeout", timeout,
  ], { env: process.env, stdio: "inherit" });
  runtime.once("error", (error) => {
    console.error(`Nanobot Runtime 无法启动：${error.message}`);
    process.exitCode = 1;
  });
  runtime.once("exit", (code, signal) => {
    if (stopping || restarting) return;
    console.error(`Nanobot Runtime 意外退出（${signal || code || "unknown"}）`);
    process.exit(code || 1);
  });
}

async function restart() {
  if (stopping || restarting) return;
  restarting = true;
  const previous = runtime;
  if (previous && previous.exitCode === null) {
    previous.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => previous.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (previous.exitCode === null) previous.kill("SIGKILL");
  }
  restarting = false;
  if (!stopping) {
    console.log("Nanobot 配置已更新，正在重新加载 Runtime…");
    start();
  }
}

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  watcher?.close();
  if (runtime && runtime.exitCode === null) {
    runtime.once("exit", () => process.exit(0));
    runtime.kill(signal);
    setTimeout(() => process.exit(0), 5_000).unref();
  } else {
    process.exit(0);
  }
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

watcher = fs.watch(path.dirname(configPath), (_event, fileName) => {
  if (fileName && String(fileName) !== path.basename(configPath)) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => void restart(), 700);
});

start();
