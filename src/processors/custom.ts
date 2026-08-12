import type { MessageProcessor } from "./types.js";

/**
 * 项目自己的处理逻辑可以从这里开始扩展。
 * 返回 undefined 会继续交给后续 Webhook；返回 handled: true 会停止后续处理。
 */
export const customProcessor: MessageProcessor = async (message) => {
  const command = message.text.trim().toLowerCase();

  if (command === "/ping") {
    return { handled: true, reply: "pong" };
  }

  if (command === "/help" || command === "帮助") {
    return {
      handled: true,
      reply:
        "我可以接收并保存文字、图片、语音、文件和视频。当前可用命令：/ping、/help。",
    };
  }

  return undefined;
};
