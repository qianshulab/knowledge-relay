import { promises as fs } from "node:fs";
import path from "node:path";

export const adminUiVersion = "2.0.0";
export const webRoot = path.resolve(process.cwd(), "web-dist");

const fallback = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>知流</title></head><body><main><h1>前端资源尚未构建</h1><p>请先运行 npm run build:web。</p></main></body></html>`;

export async function loadWebIndex(): Promise<string> {
  try {
    return await fs.readFile(path.join(webRoot, "index.html"), "utf8");
  } catch {
    return fallback;
  }
}
