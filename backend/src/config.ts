// Reads the server configuration from environment variables (plan section 6).

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  ackRetryMs: number;
  defaultRoomMs: number;
  tzName: string;
}

export const DEFAULT_CONFIG: Config = {
  port: 7321,
  host: "0.0.0.0",
  dbPath: "./data/control-room.sqlite",
  ackRetryMs: 2000,
  defaultRoomMs: 300_000,
  tzName: "Europe/Oslo",
};

type Env = Record<string, string | undefined>;

function intVar(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got "${raw}"`);
  }
  return value;
}

function strVar(env: Env, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
}

function validTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(env: Env = process.env): Config {
  const tzName = strVar(env, "TZ_NAME", DEFAULT_CONFIG.tzName);
  if (!validTimeZone(tzName)) throw new Error(`TZ_NAME is not a known time zone: "${tzName}"`);
  return {
    port: intVar(env, "PORT", DEFAULT_CONFIG.port, 0, 65535),
    host: strVar(env, "HOST", DEFAULT_CONFIG.host),
    dbPath: strVar(env, "DB_PATH", DEFAULT_CONFIG.dbPath),
    ackRetryMs: intVar(env, "ACK_RETRY_MS", DEFAULT_CONFIG.ackRetryMs, 50, 3_600_000),
    defaultRoomMs: intVar(env, "DEFAULT_ROOM_MS", DEFAULT_CONFIG.defaultRoomMs, 1, 86_400_000),
    tzName,
  };
}
