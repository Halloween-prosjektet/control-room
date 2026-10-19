// Protocol (plan section 7) plus the delivery additions that the Godot client uses:
//
// - Each client app event (all events except `auth`) can carry an integer `seq`.
//   The server replies {"event":"ack","seq":n} (cumulative) after it has processed
//   the event, and ignores (but acks) an event with a seq it has already processed.
// - `error` has `event: "error"`; the name of the failing event is in `event_name`.
// - `register` is an alias of `player_register`.

export type PiId = 1 | 2 | 3 | 4 | 5;
export const PI_IDS: readonly PiId[] = [1, 2, 3, 4, 5];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const USERNAME_MAX = 64;
export const SHARE_KEY_MAX = 128;
export const SESSION_MAX = 128;

// ---------------------------------------------------------------- client to server

export interface AuthEvent {
  event: "auth";
  pi: PiId;
  /**
   * Random id of one start of the client app (optional). When it changes, the server
   * resets the seq of the Pi, because a new app start begins again at seq 1.
   * A value that is not a string with 1 to SESSION_MAX characters is ignored.
   */
  session?: string;
}
interface AppBase {
  /** Delivery sequence number. Undefined for old clients (no dedupe, no ack). */
  seq?: number;
}
export interface PlayerRegisterEvent extends AppBase {
  event: "player_register";
  /** Trimmed, 1 to 64 characters. */
  username: string;
  timestamp?: unknown;
}
export interface GameStartEvent extends AppBase {
  event: "game_start";
  timestamp?: unknown;
}
export interface GameFinishEvent extends AppBase {
  event: "game_finish";
  timestamp?: unknown;
}
export interface PlayerLeaveEvent extends AppBase {
  event: "player_leave";
}
export interface ShareEvent extends AppBase {
  event: "share";
  key: string;
  value: Json;
  /** Target Pis, sorted, no duplicates. null = all Pis. */
  targets: PiId[] | null;
  timestamp?: unknown;
}
export interface PlayerIncomingOkEvent extends AppBase {
  event: "player_incoming_ok";
}
export interface PlayerLeftOkEvent extends AppBase {
  event: "player_left_ok";
}

export type AppEvent =
  | PlayerRegisterEvent
  | GameStartEvent
  | GameFinishEvent
  | PlayerLeaveEvent
  | ShareEvent
  | PlayerIncomingOkEvent
  | PlayerLeftOkEvent;

export type ClientEvent = AuthEvent | AppEvent;

export const APP_EVENT_NAMES = [
  "player_register",
  "game_start",
  "game_finish",
  "player_leave",
  "share",
  "player_incoming_ok",
  "player_left_ok",
] as const;
export type AppEventName = (typeof APP_EVENT_NAMES)[number];

/** Event names that the server accepts, with aliases mapped to the real name. */
const EVENT_ALIASES: Record<string, AppEventName | "auth"> = {
  auth: "auth",
  register: "player_register",
  player_register: "player_register",
  game_start: "game_start",
  game_finish: "game_finish",
  player_leave: "player_leave",
  share: "share",
  player_incoming_ok: "player_incoming_ok",
  player_left_ok: "player_left_ok",
};

// ---------------------------------------------------------------- server to client

export type ErrorCode =
  | "bad_json"
  | "unknown_event"
  | "bad_request"
  | "wrong_pi"
  | "room_busy"
  | "no_player"
  | "not_playing";

export type ServerMessage =
  | { event: "auth_ok" }
  | { event: "player_register_ok" }
  | { event: "game_start_ok" }
  | { event: "game_finish_ok" }
  | { event: "game_finish_wait"; max_wait: string }
  | { event: "player_leave_ok" }
  | { event: "share_ok" }
  | { event: "player_incoming"; username: string; player_data: { [key: string]: Json } }
  | { event: "player_left"; username: string }
  | { event: "ack"; seq: number }
  | { event: "error"; code: ErrorCode; message: string; event_name: string };

export const msg = {
  authOk: (): ServerMessage => ({ event: "auth_ok" }),
  playerRegisterOk: (): ServerMessage => ({ event: "player_register_ok" }),
  gameStartOk: (): ServerMessage => ({ event: "game_start_ok" }),
  gameFinishOk: (): ServerMessage => ({ event: "game_finish_ok" }),
  gameFinishWait: (maxWait: string): ServerMessage => ({
    event: "game_finish_wait",
    max_wait: maxWait,
  }),
  playerLeaveOk: (): ServerMessage => ({ event: "player_leave_ok" }),
  shareOk: (): ServerMessage => ({ event: "share_ok" }),
  playerIncoming: (username: string, playerData: { [key: string]: Json }): ServerMessage => ({
    event: "player_incoming",
    username,
    player_data: playerData,
  }),
  playerLeft: (username: string): ServerMessage => ({ event: "player_left", username }),
  ack: (seq: number): ServerMessage => ({ event: "ack", seq }),
  error: (code: ErrorCode, message: string, eventName: string): ServerMessage => ({
    event: "error",
    code,
    message,
    event_name: eventName,
  }),
};

// ---------------------------------------------------------------- type guards

export function isPiId(v: unknown): v is PiId {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isJson(v: unknown, depth = 0): v is Json {
  if (depth > 64) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJson(x, depth + 1));
  if (isPlainObject(v)) return Object.values(v).every((x) => isJson(x, depth + 1));
  return false;
}

export function isValidSeq(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
}

// ---------------------------------------------------------------- parsing

export type ParseResult =
  | { ok: true; event: ClientEvent }
  | {
      ok: false;
      code: "bad_json" | "unknown_event" | "bad_request";
      message: string;
      /** Name of the failing event as the client sent it ("" when unknown). */
      eventName: string;
      /** The seq of the message, when it has a valid one (so that the server can ack it). */
      seq?: number;
    };

/** Parses one WebSocket text frame. Never throws. */
export function parseClientMessage(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, code: "bad_json", message: "message is not valid JSON", eventName: "" };
  }
  return parseClientObject(data);
}

/** Validates a decoded JSON value. Never throws. */
export function parseClientObject(data: unknown): ParseResult {
  if (!isPlainObject(data)) {
    return { ok: false, code: "bad_json", message: "message is not a JSON object", eventName: "" };
  }
  const rawName = data.event;
  const eventName = typeof rawName === "string" ? rawName : "";
  const fail = (
    code: "unknown_event" | "bad_request",
    message: string,
    seq?: number,
  ): ParseResult => {
    const r: ParseResult = { ok: false, code, message, eventName };
    if (seq !== undefined) r.seq = seq;
    return r;
  };

  let seq: number | undefined;
  if ("seq" in data && data.seq !== undefined && data.seq !== null) {
    if (!isValidSeq(data.seq)) return fail("bad_request", "seq must be a positive integer");
    seq = data.seq;
  }

  if (typeof rawName !== "string")
    return fail("bad_request", "field 'event' must be a string", seq);
  const name = Object.hasOwn(EVENT_ALIASES, rawName) ? EVENT_ALIASES[rawName] : undefined;
  if (name === undefined) return fail("unknown_event", `unknown event '${rawName}'`, seq);

  const withSeq = <T extends AppEvent>(e: T): ParseResult => {
    if (seq !== undefined) e.seq = seq;
    return { ok: true, event: e };
  };
  const withTs = <T extends { timestamp?: unknown }>(e: T): T => {
    if ("timestamp" in data) e.timestamp = data.timestamp;
    return e;
  };

  switch (name) {
    case "auth": {
      if (!isPiId(data.pi)) return fail("bad_request", "pi must be an integer from 1 to 5");
      const auth: AuthEvent = { event: "auth", pi: data.pi };
      const session = data.session;
      if (typeof session === "string" && session.length >= 1 && session.length <= SESSION_MAX) {
        auth.session = session;
      }
      return { ok: true, event: auth };
    }
    case "player_register": {
      if (typeof data.username !== "string") {
        return fail("bad_request", "username must be a string", seq);
      }
      const username = data.username.trim();
      if (username.length < 1 || username.length > USERNAME_MAX) {
        return fail("bad_request", `username must have 1 to ${USERNAME_MAX} characters`, seq);
      }
      return withSeq(withTs<PlayerRegisterEvent>({ event: "player_register", username }));
    }
    case "game_start":
      return withSeq(withTs<GameStartEvent>({ event: "game_start" }));
    case "game_finish":
      return withSeq(withTs<GameFinishEvent>({ event: "game_finish" }));
    case "player_leave":
      return withSeq<PlayerLeaveEvent>({ event: "player_leave" });
    case "player_incoming_ok":
      return withSeq<PlayerIncomingOkEvent>({ event: "player_incoming_ok" });
    case "player_left_ok":
      return withSeq<PlayerLeftOkEvent>({ event: "player_left_ok" });
    case "share": {
      const key = data.key;
      if (typeof key !== "string" || key.length < 1 || key.length > SHARE_KEY_MAX) {
        return fail(
          "bad_request",
          `key must be a string with 1 to ${SHARE_KEY_MAX} characters`,
          seq,
        );
      }
      if (!("value" in data) || !isJson(data.value)) {
        return fail("bad_request", "value must be a JSON value", seq);
      }
      const targets = parseTargets(data.pi);
      if (targets === "bad") {
        return fail("bad_request", "pi must be null, an integer 1 to 5, or an array of them", seq);
      }
      return withSeq(withTs<ShareEvent>({ event: "share", key, value: data.value, targets }));
    }
  }
}

function parseTargets(v: unknown): PiId[] | null | "bad" {
  if (v === undefined || v === null) return null;
  if (isPiId(v)) return [v];
  if (Array.isArray(v) && v.every(isPiId)) {
    return [...new Set(v)].sort((a, b) => a - b);
  }
  return "bad";
}
