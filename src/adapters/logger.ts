import pino, { type Logger } from "pino";

export function createLogger(): Logger {
  const level = process.env.LOG_LEVEL ?? "info";
  if (process.env.LOG_PRETTY === "1") {
    return pino({ level, transport: { target: "pino-pretty" } });
  }
  return pino({ level });
}

export type { Logger };
