import type { AppConfig } from "../config.js";
import type { InboundMessage } from "../messages.js";

export type ProcessorResult = {
  handled: boolean;
  reply?: string;
};

export type ProcessorContext = {
  config: AppConfig;
};

export type MessageProcessor = (
  message: InboundMessage,
  context: ProcessorContext,
) => Promise<ProcessorResult | undefined>;
