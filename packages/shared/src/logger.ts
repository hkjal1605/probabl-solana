export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Readonly<Record<string, unknown>>;
export interface LogRecord {
  timestamp: string;
  level: Exclude<LogLevel, "silent">;
  service: string;
  event: string;
  fields: Record<string, unknown>;
}
export type LogSink = (record: LogRecord) => void;
export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  fields?: LogFields;
  sink?: LogSink;
  now?: () => Date;
}

const REDACTED = "[REDACTED]";
const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};
const sensitiveKey = (key: string) => {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    /password|secret|privatekey|apikey|credential|authorization|cookie|signature|rawtransaction|signedtransaction|mnemonic|seedphrase|accesstoken|refreshtoken|sessiontoken|internalToken/i.test(
      normalized,
    ) ||
    /^(token|bearer|headers|body|requestbody|responsebody|payload|calldata|environment|env|dsn|databaseurl|rpcurl|contentbase64)$/.test(
      normalized,
    )
  );
};

/** Defense in depth, not permission to log secrets or arbitrary request/RPC payloads. */
function safeText(input: string): string {
  return input
    .replace(/\b(?:https?|wss?|postgres(?:ql)?):\/\/[^\s<>"']+/gi, "[REDACTED_URL]")
    .replace(/\bBearer\s+[^\s,;"']+/gi, `Bearer ${REDACTED}`)
    .replace(
      /\b(password|secret|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|signature|authorization|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      `$1=${REDACTED}`,
    )
    .replace(/0x[\da-f]{64,}/gi, "[REDACTED_HEX]")
    .slice(0, 2048);
}

function dataProperty(value: object, key: string): unknown {
  let current: object | null = value;
  for (let depth = 0; current && depth < 8; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : "[ACCESSOR]";
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

/** Does not call object toJSON/accessors, bounds nesting/volume, and preserves raw integer precision. */
export function sanitizeLogFields(fields: LogFields): Record<string, unknown> {
  const seen = new WeakSet<object>();
  let budget = 300;
  function visit(value: unknown, depth: number, key = ""): unknown {
    if (sensitiveKey(key)) return REDACTED;
    if (--budget < 0 || depth > 6) return "[TRUNCATED]";
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value === "string") {
      // Named public identities stay useful; long arbitrary hex strings do not.
      if (
        /^(?:orderHash|buyOrderHash|sellOrderHash|transactionHash|blockHash|marketId|conditionId|proposalId|batchId|intentId|packetHash|projectionHash|sourceHash|requestDigest)$/i.test(
          key,
        ) &&
        /^0x[\da-f]{64}$/i.test(value)
      )
        return value;
      return safeText(value);
    }
    if (typeof value !== "object") return `[${typeof value}]`;
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    try {
      if (value instanceof Error) {
        const result: Record<string, unknown> = {
          name: visit(dataProperty(value, "name"), depth + 1, "name"),
          message: visit(dataProperty(value, "message"), depth + 1, "message"),
        };
        // RPC errors often carry raw requests and credentials; never serialize arbitrary properties/stack/cause.
        for (const field of ["code", "status"]) {
          const descriptor = Object.getOwnPropertyDescriptor(value, field);
          if (descriptor && "value" in descriptor)
            result[field] = visit(descriptor.value, depth + 1, field);
        }
        return result;
      }
      if (value instanceof Date)
        return Number.isNaN(Date.prototype.getTime.call(value))
          ? "Invalid Date"
          : Date.prototype.toISOString.call(value);
      if (Array.isArray(value)) {
        const result: unknown[] = [];
        const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
        for (
          let index = 0;
          index < Math.min(typeof length === "number" ? length : 0, 40);
          index++
        ) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          result.push(
            descriptor && "value" in descriptor
              ? visit(descriptor.value, depth + 1)
              : "[ACCESSOR_OR_HOLE]",
          );
        }
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const field of Object.keys(value).slice(0, 40)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        if (descriptor && "value" in descriptor && descriptor.value === undefined) continue;
        result[safeText(field)] = sensitiveKey(field)
          ? REDACTED
          : descriptor && "value" in descriptor
            ? visit(descriptor.value, depth + 1, field)
            : "[ACCESSOR]";
      }
      return result;
    } catch {
      return "[UNREADABLE]";
    }
  }
  const result = visit(fields, 0);
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { value: result };
}

const consoleSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  if (record.level === "error") console.error(line);
  else if (record.level === "warn") console.warn(line);
  else if (record.level === "debug") console.debug(line);
  else console.info(line);
};

export function logLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  if (value === undefined || value === "") return fallback;
  if (!LOG_LEVELS.includes(value as LogLevel))
    throw new Error("LOG_LEVEL must be debug, info, warn, error or silent");
  return value as LogLevel;
}

/** Browser-safe structured logger: no Bun, Node, filesystem or transport dependency. */
export class Logger {
  readonly #options: Required<LoggerOptions>;
  constructor(options: LoggerOptions) {
    this.#options = {
      level: "info",
      sink: consoleSink,
      now: () => new Date(),
      ...options,
      fields: sanitizeLogFields(options.fields ?? {}),
    };
  }
  child(fields: LogFields): Logger {
    return new Logger({
      ...this.#options,
      fields: { ...this.#options.fields, ...sanitizeLogFields(fields) },
    });
  }
  debug(event: string, fields: LogFields = {}): void {
    this.#write("debug", event, fields);
  }
  info(event: string, fields: LogFields = {}): void {
    this.#write("info", event, fields);
  }
  warn(event: string, fields: LogFields = {}): void {
    this.#write("warn", event, fields);
  }
  error(event: string, fields: LogFields = {}): void {
    this.#write("error", event, fields);
  }
  #write(level: Exclude<LogLevel, "silent">, event: string, fields: LogFields): void {
    if (priorities[level] < priorities[this.#options.level]) return;
    try {
      this.#options.sink({
        timestamp: this.#options.now().toISOString(),
        level,
        service: safeText(this.#options.service),
        event: safeText(event),
        fields: { ...this.#options.fields, ...sanitizeLogFields(fields) },
      });
    } catch {
      // Observability must never change custody behavior or turn a successful request into an error.
    }
  }
}
