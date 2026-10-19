// Test helper: drives game.step() like five Pis, and keeps a "mirror db" that
// applies only the db effects. The mirror must always agree with the state.

import {
  type Effect,
  emptyState,
  type Input,
  type OutboxEntry,
  type PiDelivery,
  type RoomTime,
  type RunRow,
  type Share,
  type Slot,
  type State,
  type StepOptions,
  step,
} from "../src/game.ts";
import type { PiId, ServerMessage } from "../src/protocol.ts";

export const BASE = Date.UTC(2026, 9, 31, 18, 0, 0, 0);

export class MirrorDb {
  runs = new Map<string, RunRow>();
  roomTimes = new Map<string, RoomTime>(); // `${playerId}:${room}`
  shares = new Map<string, Share>(); // `${playerId}:${key}`
  slots = new Map<number, Slot>();
  outbox = new Map<number, OutboxEntry>();
  pis = new Map<number, PiDelivery>();

  apply(effects: Effect[]): void {
    for (const e of effects) {
      switch (e.type) {
        case "run_upsert":
          this.runs.set(e.run.playerId, structuredClone(e.run));
          break;
        case "room_time_upsert":
          if (!this.runs.has(e.playerId)) throw new Error("room_time before run row");
          this.roomTimes.set(`${e.playerId}:${e.room}`, structuredClone(e.time));
          break;
        case "share_upsert":
          if (!this.runs.has(e.playerId)) throw new Error("share before run row");
          this.shares.set(`${e.playerId}:${e.share.key}`, structuredClone(e.share));
          break;
        case "slot_upsert":
          this.slots.set(e.slot.room, structuredClone(e.slot));
          break;
        case "pi_upsert":
          this.pis.set(e.pi, structuredClone(e.delivery));
          break;
        case "outbox_add":
          if (this.outbox.has(e.entry.id)) throw new Error("duplicate outbox id");
          this.outbox.set(e.entry.id, structuredClone(e.entry));
          break;
        case "outbox_remove":
          this.outbox.delete(e.id);
          break;
        case "outbox_mark_sent": {
          const entry = this.outbox.get(e.id);
          if (entry) entry.sent = true;
          break;
        }
        case "send":
        case "log":
          break;
      }
    }
  }
}

export interface Sent {
  pi: PiId;
  msg: ServerMessage;
}

export class Sim {
  state: State = emptyState();
  now = BASE;
  private ids = 0;
  readonly seq = [0, 0, 0, 0, 0];
  readonly db = new MirrorDb();
  readonly opts: Partial<StepOptions>;
  last: Effect[] = [];

  constructor(opts: Partial<StepOptions> = {}) {
    this.opts = { defaultRoomMs: 300_000, newId: () => `run-${++this.ids}`, ...opts };
    for (const s of this.state.slots) this.db.slots.set(s.room, structuredClone(s));
    this.state.pis.forEach((d, i) => {
      this.db.pis.set(i + 1, structuredClone(d));
    });
  }

  apply(input: Input): Effect[] {
    const before = JSON.stringify(this.state);
    const r = step(this.state, input, this.now, this.opts);
    if (JSON.stringify(this.state) !== before) throw new Error("step changed its input state");
    this.state = r.state;
    this.db.apply(r.effects);
    this.last = r.effects;
    return r.effects;
  }

  /** Sends an app event from a Pi with the next seq (or no seq when `seq` is false). */
  ev(pi: PiId, data: Record<string, unknown>, seq: number | false | undefined = undefined) {
    let s: number | undefined;
    if (seq === undefined) {
      this.seq[pi - 1] = (this.seq[pi - 1] ?? 0) + 1;
      s = this.seq[pi - 1];
    } else if (seq !== false) s = seq;
    const payload = s === undefined ? data : { ...data, seq: s };
    return this.apply({ type: "message", pi, text: JSON.stringify(payload) });
  }

  ts(offsetMs = 0): string {
    return new Date(this.now + offsetMs).toISOString();
  }

  register(username: string) {
    return this.ev(1, { event: "player_register", username, timestamp: this.ts() });
  }
  start(pi: PiId) {
    return this.ev(pi, { event: "game_start", timestamp: this.ts() });
  }
  finish(pi: PiId) {
    return this.ev(pi, { event: "game_finish", timestamp: this.ts() });
  }
  leave(pi: PiId) {
    return this.ev(pi, { event: "player_leave" });
  }
  share(pi: PiId, key: string, value: unknown, target: unknown = null) {
    return this.ev(pi, { event: "share", key, value, pi: target, timestamp: this.ts() });
  }
  incomingOk(pi: PiId) {
    return this.ev(pi, { event: "player_incoming_ok" });
  }
  leftOk(pi: PiId) {
    return this.ev(pi, { event: "player_left_ok" });
  }

  /** outbox.ts wrote all open entries for a Pi (or all Pis). Returns the messages. */
  deliver(pi?: PiId): ServerMessage[] {
    const entries = this.state.outbox.filter((e) => pi === undefined || e.pi === pi);
    if (entries.length === 0) return [];
    this.apply({ type: "outbox_sent", ids: entries.map((e) => e.id) });
    return entries.map((e) => e.payload);
  }

  /** Delivers the player_incoming to `pi` and acks it, like the Godot client. */
  accept(pi: PiId): void {
    this.deliver(pi);
    this.incomingOk(pi);
  }

  advance(ms: number): void {
    this.now += ms;
  }

  slot(room: number): Slot {
    const s = this.state.slots[room - 1];
    if (!s) throw new Error("no slot");
    return s;
  }

  outboxFor(pi: PiId): OutboxEntry[] {
    return this.state.outbox.filter((e) => e.pi === pi);
  }

  username(room: number): string | null {
    const id = this.slot(room).playerId;
    return id === null ? null : (this.state.runs[id]?.username ?? null);
  }
}

export function sends(effects: Effect[], pi?: PiId): ServerMessage[] {
  const out: ServerMessage[] = [];
  for (const e of effects) {
    if (e.type === "send" && (pi === undefined || e.pi === pi)) out.push(e.msg);
  }
  return out;
}

/** The sends without the trailing ack. */
export function replies(effects: Effect[], pi?: PiId): ServerMessage[] {
  return sends(effects, pi).filter((m) => m.event !== "ack");
}

export function logs(effects: Effect[], level?: "info" | "warn"): string[] {
  const out: string[] = [];
  for (const e of effects) {
    if (e.type === "log" && (level === undefined || e.level === level)) out.push(e.message);
  }
  return out;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
