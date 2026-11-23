import pino, { type Logger } from "pino";
import type { Config } from "./config";

export type AppLogger = Logger;

const MAX_ERROR_MESSAGE_LENGTH = 300;

/**
 * Serialize errors without leaking large payloads.
 * Parser errors may echo fragments of the input document, so the message is
 * truncated. Stack traces stay out of production logs.
 */
function safeErrorSerializer(err: unknown, includeStack: boolean) {
  if (!(err instanceof Error)) {
    return { message: String(err).slice(0, MAX_ERROR_MESSAGE_LENGTH) };
  }
  const code = (err as { code?: unknown }).code;
  return {
    type: err.name,
    message: err.message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    ...(typeof code === "string" ? { code } : {}),
    ...(includeStack && err.stack ? { stack: err.stack } : {}),
  };
}

export function createLogger(
  config: Pick<Config, "LOG_LEVEL" | "NODE_ENV">,
): AppLogger {
  const includeStack = config.NODE_ENV !== "production";

  return pino({
    level: config.LOG_LEVEL,
    base: { service: "tally-ingest", env: config.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Defense in depth: never let raw document content or credentials be logged.
    redact: {
      paths: [
        "rawXml",
        "xml",
        "body",
        "buffer",
        "file.buffer",
        "*.rawXml",
        "*.xml",
        "*.buffer",
        "req.headers.authorization",
        "req.headers.cookie",
      ],
      censor: "[REDACTED]",
    },
    serializers: {
      err: (err: unknown) => safeErrorSerializer(err, includeStack),
    },
  });
}
