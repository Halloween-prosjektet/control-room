// Reads the server configuration from environment variables (plan section 6).

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  /** File that gets a copy of each log line. null = no file. */
  logFile: string | null;
  ackRetryMs: number;
  /** Seconds without any frame (also a pong) before Bun closes a WebSocket. */
  wsIdleTimeoutS: number;
  defaultRoomMs: number;
  /** A run `incoming` in room 2 to 5 that sends no game_start for this long is removed. 0 = never. */
  incomingTimeoutMs: number;
  /** A run `playing` in a room for this long is removed. 0 = never. */
  playingTimeoutMs: number;
  tzName: string;
}

export const DEFAULT_CONFIG: Config = {
  port: 7321,
  host: "0.0.0.0",
  dbPath: "./data/control-room.sqlite",
  logFile: "./data/server.log",
  ackRetryMs: 2000,
  wsIdleTimeoutS: 120,
  defaultRoomMs: 300_000,
  incomingTimeoutMs: 900_000,
  playingTimeoutMs: 10_800_000,
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

/** LOG_FILE: a path, or "off" for no file. */
function logFileVar(env: Env): string | null {
  const value = strVar(env, "LOG_FILE", DEFAULT_CONFIG.logFile ?? "");
  return value.toLowerCase() === "off" ? null : value;
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
    logFile: logFileVar(env),
    ackRetryMs: intVar(env, "ACK_RETRY_MS", DEFAULT_CONFIG.ackRetryMs, 50, 3_600_000),
    wsIdleTimeoutS: intVar(env, "WS_IDLE_TIMEOUT_S", DEFAULT_CONFIG.wsIdleTimeoutS, 10, 960),
    defaultRoomMs: intVar(env, "DEFAULT_ROOM_MS", DEFAULT_CONFIG.defaultRoomMs, 1, 86_400_000),
    incomingTimeoutMs: intVar(
      env,
      "INCOMING_TIMEOUT_MS",
      DEFAULT_CONFIG.incomingTimeoutMs,
      0,
      86_400_000,
    ),
    playingTimeoutMs: intVar(
      env,
      "PLAYING_TIMEOUT_MS",
      DEFAULT_CONFIG.playingTimeoutMs,
      0,
      86_400_000,
    ),
    tzName,
  };
}
