// Test client that acts like the Godot ControlRoomClient
// (godot/addons/control_room_client/control_room_client.gd):
//
// - On open it sends {"event":"auth","pi":N,"session":S,"features":["game_finish_ack"]}
//   (no features when `finishAck` is false, like an old client). Each message before
//   auth_ok counts as one failed auth attempt (max 3), as in the Godot client.
// - Each event gets the next seq. Events are only sent after auth_ok and when the
//   queue is empty; else they go in the queue.
// - "ack" n removes all events with seq <= n from `unacked` and the queue.
// - After auth_ok it sends `unacked` again first, then the queue.
// - player_incoming -> player_incoming_ok; player_left -> player_left_ok;
//   game_finish_ok (with id, when `finishAck`) -> game_finish_ack. The reply echoes the
//   `id` of the message (when it has one), for each copy it gets.
// - F6: a copy with an id that it saw before changes nothing (`signals` gets one entry
//   per message). player_left for another player than `current` changes nothing.
//   game_finish_ok for another player than `current` (when `current` is known) is
//   ignored.
// - F2: game_start, game_finish, player_leave and share carry `username` of `current`
//   (when known). register sets `current`; leave clears it.

import type { ServerMessage } from "../src/protocol.ts";

type Payload = Record<string, unknown> & { seq: number };

export interface Received {
  msg: ServerMessage;
  /** Connection number of this client (1 = first connection). */
  conn: number;
}

let sessionCounter = 0;

export class PiClient {
  session: string;
  nextSeq = 1;
  sendQueue: Payload[] = [];
  unacked: Payload[] = [];
  authenticated = false;
  ws: WebSocket | null = null;
  conn = 0;
  received: Received[] = [];
  closes: { code: number; conn: number }[] = [];
  /** The last player_incoming (like current_player in the Godot client). */
  current: { username: string; data: unknown } | null = null;
  /** Send no auth on open (to test the pre-auth buffer). */
  manualAuth = false;
  /** false: do not send player_incoming_ok / player_left_ok / game_finish_ack (the test sends them). */
  autoOk = true;
  /** false: act like an old client (no auth feature, no game_finish_ack). */
  finishAck = true;
  /** false: act like an old client (no username in events). */
  sendUsername = true;
  /** The "signals" of the Godot client, once per message. */
  signals: { event: string; username?: string; data?: unknown }[] = [];
  /** Keys "event:id:username" of the messages that it acted on (F6). */
  private seen = new Set<string>();
  private authAttempts = 0;

  constructor(
    public url: string,
    readonly pi: number,
  ) {
    this.session = `s${process.pid}-${++sessionCounter}`;
  }

  // ------------------------------------------------------------ connection

  connect(): Promise<void> {
    this.conn += 1;
    const conn = this.conn;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.authenticated = false;
    this.authAttempts = 0;
    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        if (!this.manualAuth) this.sendAuth();
        resolve();
      };
      ws.onerror = () => reject(new Error(`pi ${this.pi}: socket error`));
      ws.onclose = (ev) => {
        this.closes.push({ code: ev.code, conn });
        if (this.ws === ws) {
          this.ws = null;
          this.authenticated = false;
        }
      };
      ws.onmessage = (ev) => this.onFrame(ws, conn, String(ev.data));
    });
  }

  /** Connects and waits for auth_ok. */
  async online(): Promise<this> {
    await this.connect();
    await waitUntil(() => this.authenticated, `pi ${this.pi} auth_ok`);
    return this;
  }

  sendAuth(): void {
    this.authAttempts += 1;
    this.raw(
      this.finishAck
        ? { event: "auth", pi: this.pi, session: this.session, features: ["game_finish_ack"] }
        : { event: "auth", pi: this.pi, session: this.session },
    );
  }

  raw(data: unknown): void {
    this.ws?.send(typeof data === "string" ? data : JSON.stringify(data));
  }

  /** Closes the socket (like a lost network). Unacked events stay. */
  async disconnect(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    this.authenticated = false;
    if (ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((r) => ws.addEventListener("close", () => r()));
    ws.close();
    await closed;
  }

  /** Like a restart of the Godot app: new session, seq starts at 1, queues empty. */
  async restartApp(): Promise<void> {
    await this.disconnect();
    this.session = `s${process.pid}-${++sessionCounter}`;
    this.nextSeq = 1;
    this.sendQueue = [];
    this.unacked = [];
    this.current = null;
    this.seen.clear();
  }

  // ------------------------------------------------------------ events

  sendEvent(data: Record<string, unknown>): number {
    const payload: Payload = { ...data, seq: this.nextSeq++ };
    if (this.authenticated && this.sendQueue.length === 0 && this.sendRaw(payload)) {
      this.unacked.push(payload);
    } else {
      this.sendQueue.push(payload);
    }
    return payload.seq;
  }

  /** The username field of an event (F2): the current player, when known. */
  private who(): Record<string, unknown> {
    return this.sendUsername && this.current ? { username: this.current.username } : {};
  }

  register(username: string): number {
    this.current = { username, data: null };
    return this.sendEvent({ event: "player_register", username, timestamp: ts() });
  }
  start(): number {
    return this.sendEvent({ event: "game_start", timestamp: ts(), ...this.who() });
  }
  finish(): number {
    return this.sendEvent({ event: "game_finish", timestamp: ts(), ...this.who() });
  }
  leave(): number {
    const seq = this.sendEvent({ event: "player_leave", ...this.who() });
    this.current = null;
    return seq;
  }
  share(key: string, value: unknown, pi: unknown = null): number {
    return this.sendEvent({ event: "share", key, value, pi, timestamp: ts(), ...this.who() });
  }

  /** True when the server acked all events. */
  allAcked(): boolean {
    return this.unacked.length === 0 && this.sendQueue.length === 0;
  }

  // ------------------------------------------------------------ received

  events(name: string): ServerMessage[] {
    return this.received.filter((r) => r.msg.event === name).map((r) => r.msg);
  }

  count(name: string): number {
    return this.events(name).length;
  }

  waitCount(name: string, n: number, timeoutMs = 3000): Promise<void> {
    return waitUntil(() => this.count(name) >= n, `pi ${this.pi}: ${n} x ${name}`, timeoutMs);
  }

  /** Waits until the server acked the event with this seq. */
  waitAck(seq: number, timeoutMs = 3000): Promise<void> {
    return waitUntil(
      () => !this.unacked.some((p) => p.seq <= seq) && !this.sendQueue.some((p) => p.seq <= seq),
      `pi ${this.pi}: ack ${seq}`,
      timeoutMs,
    );
  }

  // ------------------------------------------------------------ internals

  /** F6: true for the first copy of a message (a message with no id is always new). */
  private firstCopy(event: string, id: unknown, username: unknown): boolean {
    if (typeof id !== "number") return true;
    const key = `${event}:${id}:${String(username)}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  private sendRaw(payload: Payload): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }

  private flushQueue(): void {
    while (this.sendQueue.length > 0) {
      const first = this.sendQueue[0] as Payload;
      if (!this.sendRaw(first)) break;
      this.unacked.push(first);
      this.sendQueue.shift();
    }
  }

  private onFrame(ws: WebSocket, conn: number, text: string): void {
    if (this.ws !== ws) return;
    let data: ServerMessage;
    try {
      data = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    this.received.push({ msg: data, conn });
    if (!this.authenticated) {
      if (data.event === "auth_ok") {
        this.authenticated = true;
        this.sendQueue = [...this.unacked, ...this.sendQueue];
        this.unacked = [];
        this.flushQueue();
      } else if (this.authAttempts < 3) {
        this.sendAuth();
      }
      return;
    }
    this.flushQueue();
    switch (data.event) {
      case "ack":
        this.unacked = this.unacked.filter((p) => p.seq > data.seq);
        this.sendQueue = this.sendQueue.filter((p) => p.seq > data.seq);
        break;
      case "player_incoming":
        if (this.autoOk) this.sendEvent(withId({ event: "player_incoming_ok" }, data.id));
        if (this.firstCopy(data.event, data.id, data.username)) {
          this.current = { username: data.username, data: data.player_data };
          this.signals.push({ event: data.event, username: data.username, data: data.player_data });
        }
        break;
      case "player_left":
        if (this.autoOk) this.sendEvent(withId({ event: "player_left_ok" }, data.id));
        if (
          this.firstCopy(data.event, data.id, data.username) &&
          this.current?.username === data.username
        ) {
          this.current = null;
          this.signals.push({ event: data.event, username: data.username });
        }
        break;
      case "game_finish_ok":
        if (this.autoOk && this.finishAck && typeof data.id === "number") {
          this.sendEvent({ event: "game_finish_ack", id: data.id });
        }
        if (
          this.firstCopy(data.event, data.id, data.username) &&
          (data.username === undefined ||
            this.current === null ||
            this.current.username === data.username)
        ) {
          this.signals.push({ event: data.event, username: data.username });
        }
        break;
      default:
        break;
    }
  }
}

/** Adds `id` to an ok event when the server message has one. */
function withId(e: Record<string, unknown>, id: unknown): Record<string, unknown> {
  return typeof id === "number" ? { ...e, id } : e;
}

export function ts(): string {
  return new Date().toISOString();
}

export async function waitUntil(
  cond: () => boolean,
  what: string,
  timeoutMs = 3000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await Bun.sleep(3);
  }
}
