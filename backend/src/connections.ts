// Map from Pi number to the open WebSocket, and the auth rules (plan section 8.1).
//
// - A new connection is "not authenticated". Messages before a valid `auth` go in a
//   buffer of that connection (max PRE_AUTH_BUFFER_MAX). After auth_ok, the buffer
//   is processed in order.
// - A valid `auth` binds the connection to Pi N. An older connection of Pi N is
//   closed with code 4000.
// - An `auth` that is not valid on a connection that is not authenticated: no reply,
//   close with code 4001. On an authenticated connection the server never closes
//   because of a bad message, so it replies `error` (bad_request).
// - Each valid `auth` calls onAuth (index.ts sends auth_ok and the outbox again).

import type { ServerWebSocket } from "bun";
import {
  isPlainObject,
  msg,
  type PiId,
  parseClientObject,
  type ServerMessage,
} from "./protocol.ts";

export const PRE_AUTH_BUFFER_MAX = 100;
export const CLOSE_REPLACED = 4000;
export const CLOSE_BAD_AUTH = 4001;

export interface ConnData {
  /** Unique number of the connection (for logs). */
  id: number;
  /** The Pi after a valid auth, else null. */
  pi: PiId | null;
  /** Text frames that came before auth. */
  buffer: string[];
  /** True when the server closed this connection itself (replaced or bad auth). */
  closedByServer: boolean;
}

export type Socket = ServerWebSocket<ConnData>;

export interface ConnectionHandlers {
  /** A valid auth for Pi `pi`. The handler must send auth_ok first. */
  onAuth(pi: PiId, session: string | undefined, features: readonly string[]): void;
  /** A text frame (not auth) from an authenticated Pi. */
  onMessage(pi: PiId, text: string): void;
  log(level: "info" | "warn", message: string): void;
}

let nextConnId = 1;

export function newConnData(): ConnData {
  return { id: nextConnId++, pi: null, buffer: [], closedByServer: false };
}

export class Connections {
  private readonly byPi = new Map<PiId, Socket>();

  constructor(private readonly handlers: ConnectionHandlers) {}

  open(ws: Socket): void {
    this.handlers.log("info", `connection ${ws.data.id} open`);
  }

  message(ws: Socket, raw: string | Buffer): void {
    const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    const auth = authFrame(text);
    if (auth !== null) {
      this.onAuthFrame(ws, auth);
      return;
    }
    const pi = ws.data.pi;
    if (pi === null) {
      if (ws.data.buffer.length >= PRE_AUTH_BUFFER_MAX) {
        this.handlers.log(
          "warn",
          `connection ${ws.data.id}: pre-auth buffer full; message dropped`,
        );
        return;
      }
      ws.data.buffer.push(text);
      return;
    }
    this.handlers.onMessage(pi, text);
  }

  close(ws: Socket, code: number, reason: string): void {
    const pi = ws.data.pi;
    if (pi !== null && this.byPi.get(pi) === ws) this.byPi.delete(pi);
    this.handlers.log(
      "info",
      `connection ${ws.data.id}${pi === null ? "" : ` (pi ${pi})`} closed: ${code} ${reason}`,
    );
  }

  /** Sends a message to the authenticated connection of the Pi. False if not sent. */
  send(pi: PiId, m: ServerMessage): boolean {
    const ws = this.byPi.get(pi);
    if (ws?.readyState !== 1) return false;
    return ws.send(JSON.stringify(m)) !== 0;
  }

  isReady(pi: PiId): boolean {
    const ws = this.byPi.get(pi);
    return ws !== undefined && ws.readyState === 1;
  }

  connectedPis(): PiId[] {
    return [...this.byPi.keys()].filter((pi) => this.isReady(pi)).sort((a, b) => a - b);
  }

  /** Closes all connections (server stop). */
  closeAll(code = 1001, reason = "server stops"): void {
    for (const ws of this.byPi.values()) {
      ws.data.closedByServer = true;
      ws.close(code, reason);
    }
    this.byPi.clear();
  }

  private onAuthFrame(ws: Socket, data: Record<string, unknown>): void {
    const parsed = parseClientObject(data);
    if (!parsed.ok || parsed.event.event !== "auth") {
      const why = parsed.ok ? "not auth" : parsed.message;
      if (ws.data.pi === null) {
        this.handlers.log(
          "warn",
          `connection ${ws.data.id}: bad auth (${why}); close ${CLOSE_BAD_AUTH}`,
        );
        ws.data.closedByServer = true;
        ws.close(CLOSE_BAD_AUTH, "bad auth");
      } else {
        ws.send(JSON.stringify(msg.error("bad_request", why, "auth")));
      }
      return;
    }
    const { pi, session, features } = parsed.event;

    const old = this.byPi.get(pi);
    if (old !== undefined && old !== ws) {
      this.handlers.log("info", `pi ${pi}: new connection ${ws.data.id} replaces ${old.data.id}`);
      old.data.closedByServer = true;
      old.data.pi = null;
      old.close(CLOSE_REPLACED, "replaced by a new connection");
    }
    const before = ws.data.pi;
    if (before !== null && before !== pi && this.byPi.get(before) === ws) this.byPi.delete(before);
    ws.data.pi = pi;
    this.byPi.set(pi, ws);

    this.handlers.onAuth(pi, session, features ?? []);

    // Messages from before the auth, in order.
    const buffered = ws.data.buffer;
    ws.data.buffer = [];
    for (const text of buffered) {
      if (ws.data.pi !== pi) break; // replaced during the loop
      this.handlers.onMessage(pi, text);
    }
  }
}

/** The decoded frame if it is a JSON object with event "auth", else null. */
function authFrame(text: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(text);
    return isPlainObject(data) && data.event === "auth" ? data : null;
  } catch {
    return null;
  }
}
