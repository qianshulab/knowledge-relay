import type { AppConfig } from "../config.js";
import type { InboundMessage } from "../messages.js";
import { customProcessor } from "./custom.js";
import { callProcessingWebhook } from "./webhook.js";
import type { ProcessorResult } from "./types.js";

export async function processMessage(
  message: InboundMessage,
  config: AppConfig,
): Promise<ProcessorResult> {
  const customResult = await customProcessor(message, { config });
  if (customResult?.handled) return customResult;

  const webhookResult = await callProcessingWebhook(message, config);
  if (webhookResult?.handled) return webhookResult;

  if (config.autoAck) {
    return { handled: true, reply: config.autoAckText };
  }
  return { handled: false };
}
