import "dotenv/config";

import { BotManager } from "./bot-manager.js";
import { loadConfig } from "./config.js";
import { AccountLoginManager } from "./ilink/account-login-manager.js";
import { configureLogger, errorDetails, logger } from "./logger.js";
import { createServer } from "./server.js";
import { AppDatabase } from "./storage/database.js";
import { WechatMcpIntakeManager } from "./wechat-mcp-intake.js";

async function main(): Promise<void> {
  const config = loadConfig();
  configureLogger(config.logLevel);

  const database = await AppDatabase.open(config.dataDir, config.nanobot.workspace);
  database.purgeExpired();
  database.publishPendingMessages();

  const bots = new BotManager(config, database);
  const login = new AccountLoginManager(config, database, bots);
  const wechatMcp = new WechatMcpIntakeManager(config, database, bots);
  const server = createServer(config, database, bots, login, wechatMcp);

  await server.listen({ host: config.host, port: config.port });
  logger.info("管理页面已启动", {
    address: `http://${config.host}:${config.port}`,
    dataDir: config.dataDir,
  });
  await bots.startAll();
  await wechatMcp.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("正在停止服务", { signal });
    await wechatMcp.stop();
    await bots.stopAll();
    await server.close();
    database.close();
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error("服务启动失败", errorDetails(error));
  process.exitCode = 1;
});
