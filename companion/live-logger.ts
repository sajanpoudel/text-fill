import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type CompanionLogLevel = "info" | "warn" | "error";

export interface CompanionLogger extends Pick<typeof console, "log" | "warn" | "error"> {
  readonly filePath?: string;
  event(
    level: CompanionLogLevel,
    source: string,
    event: string,
    payload?: Record<string, unknown>
  ): void;
}

type CompanionLogEntry = {
  ts: string;
  level: CompanionLogLevel;
  source: string;
  event: string;
  payload?: Record<string, unknown>;
  message?: string;
};

function serializeValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatConsoleArgs(args: unknown[]): string {
  return args.map(serializeValue).join(" ");
}

class FileCompanionLogger implements CompanionLogger {
  readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  log(...args: unknown[]): void {
    const message = formatConsoleArgs(args);
    console.log(...args);
    this.write({
      ts: new Date().toISOString(),
      level: "info",
      source: "raw",
      event: "log",
      message,
    });
  }

  warn(...args: unknown[]): void {
    const message = formatConsoleArgs(args);
    console.warn(...args);
    this.write({
      ts: new Date().toISOString(),
      level: "warn",
      source: "raw",
      event: "warn",
      message,
    });
  }

  error(...args: unknown[]): void {
    const message = formatConsoleArgs(args);
    console.error(...args);
    this.write({
      ts: new Date().toISOString(),
      level: "error",
      source: "raw",
      event: "error",
      message,
    });
  }

  event(
    level: CompanionLogLevel,
    source: string,
    event: string,
    payload?: Record<string, unknown>
  ): void {
    const consoleMethod =
      level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (payload && Object.keys(payload).length > 0) {
      consoleMethod(`[${source}] ${event}`, payload);
    } else {
      consoleMethod(`[${source}] ${event}`);
    }
    this.write({
      ts: new Date().toISOString(),
      level,
      source,
      event,
      ...(payload && Object.keys(payload).length > 0 ? { payload } : {}),
    });
  }

  private write(entry: CompanionLogEntry): void {
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
      })
      .catch(() => undefined);
  }
}

export function getDefaultCompanionLogFilePath(cwd = process.cwd()): string {
  const configured = process.env.LOCAL_COMPANION_LOG_FILE?.trim();
  return resolve(cwd, configured || "companion/.data/live.log");
}

export function createCompanionLogger(
  filePath = getDefaultCompanionLogFilePath()
): CompanionLogger {
  return new FileCompanionLogger(filePath);
}

export function createNoopCompanionLogger(): CompanionLogger {
  return {
    log() {
      return;
    },
    warn() {
      return;
    },
    error() {
      return;
    },
    event() {
      return;
    },
  };
}
