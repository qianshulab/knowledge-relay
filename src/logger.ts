import type { AppConfig } from "./config.js";

const priorities = { debug: 10, info: 20, warn: 30, error: 40 } as const;
let configuredLevel: AppConfig["logLevel"] = "info";

export function configureLogger(level: AppConfig["logLevel"]): void {
  configuredLevel = level;
}

function write(
  level: keyof typeof priorities,
  message: string,
  details?: Record<string, unknown>,
): void {
  if (priorities[level] < priorities[configuredLevel]) return;
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...(details ? { details } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, details?: Record<string, unknown>) =>
    write("debug", message, details),
  info: (message: string, details?: Record<string, unknown>) =>
    write("info", message, details),
  warn: (message: string, details?: Record<string, unknown>) =>
    write("warn", message, details),
  error: (message: string, details?: Record<string, unknown>) =>
    write("error", message, details),
};

export function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}
