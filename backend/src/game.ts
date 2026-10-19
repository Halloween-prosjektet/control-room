// The room state machine (plan sections 8.2 to 8.11). Pure logic.
//
// `step(state, input, now, options)` returns the new state and a list of effects.
// It does not use sockets, timers, SQLite, or the clock. It does not change the
// input state. The state is plain JSON data (JSON.parse(JSON.stringify(s)) gives
// an equal state), so that db.ts can store it.
//
// Effect contract for the caller (index.ts / db.ts / outbox.ts):
//
// 1. Apply all effects that are not "send" or "log" in ONE SQLite transaction,
//    in list order.
// 2. After the commit, do the "send" effects in list order on the current
//    connection of that Pi. If the Pi is not connected, drop the "send". The
//    last "send" of a message with a seq is the "ack", so that the client gets
//    the ack only after the event is durable.
// 3. Then give the new outbox entries to outbox.ts. When outbox.ts writes outbox
//    entries to a socket, it calls step() with {type: "outbox_sent", ids}.
//    That removes entries with needsAck = false, and marks the others as sent.
// 4. `auth` is not an input of this module: the connection layer handles it
//    (section 8.1), and sends the outbox of the Pi again after auth_ok.

import {
  type AppEvent,
  type ErrorCode,
  type GameFinishEvent,
  type GameStartEvent,
  type Json,
  msg,
  type ParseResult,
  type PiId,
  type PlayerRegisterEvent,
  parseClientMessage,
  parseClientObject,
  type ServerMessage,
  type ShareEvent,
} from "./protocol.ts";
import { formatInZone, resolveClientTime } from "./time.ts";

// ---------------------------------------------------------------- state

export type SlotState = "empty" | "incoming" | "playing" | "waiting";

/** Times are epoch milliseconds. */
export interface RoomTime {
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
}

export interface Share {
  key: string;
  value: Json;
  /** null = all Pis. */
  targets: PiId[] | null;
  fromPi: PiId;
  createdAt: number;
}

/** An active run. Completed and left runs are removed from the state (they are in the db). */
export interface Run {
  playerId: string;
  username: string;
  createdAt: number;
  /** Index 0..4 = room 1..5. */
  rooms: RoomTime[];
  shares: Share[];
}

export interface Slot {
  room: PiId;
  state: SlotState;
  playerId: string | null;
  /** player_id of the last run that left this room (hand over, finish in room 5, or quit). */
  lastLeft: string | null;
  /** True when the Pi of this room possibly knows the run (player_incoming was sent at least once, or room 1). */
  notified: boolean;
}

export interface RoomStat {
  /** Number of completed runs. */
  count: number;
  /** Sum of the room times of the completed runs. */
  sumMs: number;
}

export type OutboxEvent = "player_incoming" | "player_left" | "game_finish_ok";

export interface OutboxEntry {
  id: number;
  pi: PiId;
  event: OutboxEvent;
  payload: ServerMessage;
  /** true: stays until the Pi acks (player_incoming, player_left). false: removed after one send. */
  needsAck: boolean;
  /** The run that the message is about. */
  playerId: string;
  createdAt: number;
  /** True after outbox.ts wrote it to a socket at least once. */
  sent: boolean;
}

export interface PiDelivery {
  /** Highest seq processed for this Pi (0 = none). Events with seq <= lastSeq are ignored but acked. */
  lastSeq: number;
  /**
   * Number of player_incoming_ok messages without `id` (old clients) to ignore.
   * Increments when a sent but not acked player_incoming is deleted because the
   * player quit (the late ok must not remove the player_incoming of the next run).
   * An ok with `id` sets it to 0: that client does not send oks without `id`.
   */
  staleIncomingOks: number;
}

export interface State {
  version: 1;
  /** Index 0..4 = room 1..5. */
  slots: Slot[];
  /** Active runs by player_id. */
  runs: Record<string, Run>;
  /** Index 0..4 = room 1..5. From completed runs only. */
  roomStats: RoomStat[];
  /** In creation order (oldest first). */
  outbox: OutboxEntry[];
  nextOutboxId: number;
  /** Index 0..4 = Pi 1..5. */
  pis: PiDelivery[];
}

const ROOMS: readonly PiId[] = [1, 2, 3, 4, 5];

export function emptyState(): State {
  return {
    version: 1,
    slots: ROOMS.map((room) => ({
      room,
      state: "empty",
      playerId: null,
      lastLeft: null,
      notified: false,
    })),
    runs: {},
    roomStats: ROOMS.map(() => ({ count: 0, sumMs: 0 })),
    outbox: [],
    nextOutboxId: 1,
    pis: ROOMS.map(() => ({ lastSeq: 0, staleIncomingOks: 0 })),
  };
}

// ---------------------------------------------------------------- inputs and effects

export type Input =
  /** A text frame from an authenticated Pi. */
  | { type: "message"; pi: PiId; text: string }
  /** An already decoded JSON value from an authenticated Pi. */
  | { type: "event"; pi: PiId; data: unknown }
  /** outbox.ts wrote these outbox entries to a socket. */
  | { type: "outbox_sent"; ids: number[] }
  /** Operator action: forget the seq of a Pi (use after the Godot app restarts with seq 1). */
  | { type: "reset_seq"; pi: PiId };

export type RunStatus = "active" | "completed" | "left";

/** One row of the `runs` table. */
export interface RunRow {
  playerId: string;
  username: string;
  status: RunStatus;
  createdAt: number;
  completedAt: number | null;
  totalTimeMs: number | null;
}

export type Effect =
  /** Send now on the open connection of the Pi. Drop if the Pi is not connected. */
  | { type: "send"; pi: PiId; msg: ServerMessage }
  | { type: "outbox_add"; entry: OutboxEntry }
  | { type: "outbox_remove"; id: number }
  | { type: "outbox_mark_sent"; id: number }
  | { type: "run_upsert"; run: RunRow }
  | { type: "room_time_upsert"; playerId: string; room: PiId; time: RoomTime }
  | { type: "share_upsert"; playerId: string; share: Share }
  | { type: "slot_upsert"; slot: Slot }
  | { type: "pi_upsert"; pi: PiId; delivery: PiDelivery }
  | { type: "log"; level: "info" | "warn"; message: string };

export interface StepResult {
  state: State;
  effects: Effect[];
}

export interface StepOptions {
  /** Room time estimate when no run has completed the room (DEFAULT_ROOM_MS). */
  defaultRoomMs: number;
  /** Time zone for max_wait (TZ_NAME). */
  tzName: string;
  /** Makes a new player_id. */
  newId: () => string;
}

export const DEFAULT_STEP_OPTIONS: StepOptions = {
  defaultRoomMs: 300_000,
  tzName: "Europe/Oslo",
  newId: () => crypto.randomUUID(),
};

export const MIN_WAIT_MS = 30_000;

// ---------------------------------------------------------------- step

/** Applies one input. Does not change `state`. */
export function step(
  state: State,
  input: Input,
  now: number,
  options: Partial<StepOptions> = {},
): StepResult {
  const opt: StepOptions = {
    defaultRoomMs: options.defaultRoomMs ?? DEFAULT_STEP_OPTIONS.defaultRoomMs,
    tzName: options.tzName ?? DEFAULT_STEP_OPTIONS.tzName,
    newId: options.newId ?? DEFAULT_STEP_OPTIONS.newId,
  };
  const ctx = new Ctx(structuredClone(state), now, opt);
  switch (input.type) {
    case "message":
      ctx.onMessage(input.pi, parseClientMessage(input.text));
      break;
    case "event":
      ctx.onMessage(input.pi, parseClientObject(input.data));
      break;
    case "outbox_sent":
      ctx.onOutboxSent(input.ids);
      break;
    case "reset_seq":
      ctx.pi(input.pi).lastSeq = 0;
      ctx.log("info", `seq of pi ${input.pi} reset`);
      break;
  }
  return ctx.finish(state);
}

class Ctx {
  private readonly db: Effect[] = [];
  private readonly sends: Effect[] = [];

  constructor(
    readonly s: State,
    readonly now: number,
    readonly opt: StepOptions,
  ) {}

  // ------------------------------------------------------------ helpers

  slot(room: number): Slot {
    const slot = this.s.slots[room - 1];
    if (!slot) throw new Error(`no room ${room}`);
    return slot;
  }

  pi(pi: PiId): PiDelivery {
    const d = this.s.pis[pi - 1];
    if (!d) throw new Error(`no pi ${pi}`);
    return d;
  }

  run(playerId: string): Run {
    const run = this.s.runs[playerId];
    if (!run) throw new Error(`no active run ${playerId}`);
    return run;
  }

  roomTime(run: Run, room: PiId): RoomTime {
    const rt = run.rooms[room - 1];
    if (!rt) throw new Error(`no room time ${room}`);
    return rt;
  }

  log(level: "info" | "warn", message: string): void {
    this.db.push({ type: "log", level, message });
  }

  send(pi: PiId, m: ServerMessage): void {
    this.sends.push({ type: "send", pi, msg: m });
  }

  error(pi: PiId, code: ErrorCode, message: string, eventName: string): void {
    this.send(pi, msg.error(code, message, eventName));
  }

  time(pi: PiId, eventName: string, timestamp: unknown): number {
    const t = resolveClientTime(timestamp, this.now);
    if (t.warning) this.log("warn", `pi ${pi} ${eventName}: ${t.warning}`);
    return t.ms;
  }

  /** `payload` gets the id of the new entry (player_incoming and player_left carry it). */
  outboxAdd(
    pi: PiId,
    event: OutboxEvent,
    payload: (id: number) => ServerMessage,
    playerId: string,
  ): void {
    const id = this.s.nextOutboxId++;
    const entry: OutboxEntry = {
      id,
      pi,
      event,
      payload: payload(id),
      needsAck: event !== "game_finish_ok",
      playerId,
      createdAt: this.now,
      sent: false,
    };
    this.s.outbox.push(entry);
    this.db.push({ type: "outbox_add", entry: structuredClone(entry) });
  }

  outboxRemove(id: number): void {
    this.s.outbox = this.s.outbox.filter((e) => e.id !== id);
    this.db.push({ type: "outbox_remove", id });
  }

  upsertRun(run: Run, status: RunStatus, completedAt: number | null, total: number | null): void {
    this.db.push({
      type: "run_upsert",
      run: {
        playerId: run.playerId,
        username: run.username,
        status,
        createdAt: run.createdAt,
        completedAt,
        totalTimeMs: total,
      },
    });
  }

  upsertRoomTime(run: Run, room: PiId): void {
    this.db.push({
      type: "room_time_upsert",
      playerId: run.playerId,
      room,
      time: { ...this.roomTime(run, room) },
    });
  }

  /** The room that has the run now, or null. */
  roomOf(playerId: string): PiId | null {
    for (const slot of this.s.slots) if (slot.playerId === playerId) return slot.room;
    return null;
  }

  /**
   * The run that "belongs" to Pi N for share and player_leave (8.8.3, 8.9.2):
   * the run in room N, else the last run that left room N if it is `incoming` in room N+1.
   */
  runForPi(pi: PiId): { playerId: string; room: PiId } | null {
    const slot = this.slot(pi);
    if (slot.playerId !== null) return { playerId: slot.playerId, room: pi };
    const last = slot.lastLeft;
    if (last === null || pi === 5 || !this.s.runs[last]) return null;
    const next = this.slot(pi + 1);
    if (next.playerId === last && next.state === "incoming") {
      return { playerId: last, room: next.room };
    }
    return null;
  }

  averageRoomMs(room: PiId): number {
    const st = this.s.roomStats[room - 1];
    return st && st.count > 0 ? Math.round(st.sumMs / st.count) : this.opt.defaultRoomMs;
  }

  /** 8.7: estimate of the time until room `room + 1` is free, for a run that waits in `room`. */
  waitEstimateMs(room: PiId): number {
    let total = 0;
    for (let r = room + 1; r <= 5; r++) {
      const slot = this.slot(r);
      const avg = this.averageRoomMs(slot.room);
      if (slot.state === "waiting") continue; // done here; it waits for the next room
      if (slot.state === "incoming") total += avg;
      if (slot.state === "playing" && slot.playerId !== null) {
        const started = this.roomTime(this.run(slot.playerId), slot.room).startedAt ?? this.now;
        total += Math.max(0, started + avg - this.now);
      }
      break;
    }
    return Math.max(total, MIN_WAIT_MS);
  }

  playerData(run: Run, pi: PiId): { [key: string]: Json } {
    return Object.fromEntries(
      run.shares
        .filter((sh) => sh.targets === null || sh.targets.includes(pi))
        .map((sh) => [sh.key, sh.value]),
    );
  }

  // ------------------------------------------------------------ room changes

  /** 8.6: hand over the run in room `room` to room `room + 1` (that must be empty). */
  handOver(room: PiId): void {
    const from = this.slot(room);
    const to = this.slot(room + 1);
    const playerId = from.playerId;
    if (playerId === null || to.state !== "empty") throw new Error("bad hand over");
    const run = this.run(playerId);
    // Pi `room` sent game_finish, so a player_incoming_ok from it came before (seq order).
    this.dropIncoming(room, playerId, false);
    to.state = "incoming";
    to.playerId = playerId;
    to.notified = false;
    from.state = "empty";
    from.playerId = null;
    from.lastLeft = playerId;
    from.notified = false;
    this.outboxAdd(room, "game_finish_ok", () => msg.gameFinishOk(), playerId);
    const data = this.playerData(run, to.room);
    this.outboxAdd(
      to.room,
      "player_incoming",
      (id) => msg.playerIncoming(id, run.username, data),
      playerId,
    );
    this.roomEmptied(room);
  }

  /**
   * Removes the open player_incoming messages of a run for Pi `room` (8.9.6). The run
   * leaves the room, so the message is stale. If `staleIfSent`, a sent message can still
   * get a late player_incoming_ok, which must not ack the message of the next run.
   */
  dropIncoming(room: PiId, playerId: string, staleIfSent: boolean): void {
    for (const entry of this.s.outbox.filter(
      (x) => x.pi === room && x.event === "player_incoming" && x.playerId === playerId,
    )) {
      this.outboxRemove(entry.id);
      if (entry.sent && staleIfSent) this.pi(room).staleIncomingOks += 1;
    }
  }

  /** 8.6.5: room `room` is now empty. A run that waits in the room before it moves in. */
  roomEmptied(room: PiId): void {
    if (room === 1) return;
    const before = this.slot(room - 1);
    if (before.state === "waiting") this.handOver(before.room);
  }

  // ------------------------------------------------------------ messages

  onMessage(pi: PiId, parsed: ParseResult): void {
    const seq = parsed.ok
      ? parsed.event.event === "auth"
        ? undefined
        : parsed.event.seq
      : parsed.seq;
    const delivery = this.pi(pi);

    // Dedupe: ignore an event that was processed before, but ack it again.
    if (seq !== undefined && seq <= delivery.lastSeq) {
      this.log("info", `pi ${pi}: ignored repeated seq ${seq} (last ${delivery.lastSeq})`);
      this.send(pi, msg.ack(delivery.lastSeq));
      return;
    }

    if (!parsed.ok) {
      this.error(pi, parsed.code, parsed.message, parsed.eventName);
    } else if (parsed.event.event === "auth") {
      this.log("warn", `pi ${pi}: auth must go to the connection layer, not to step()`);
      return;
    } else {
      this.onEvent(pi, parsed.event);
    }

    if (seq !== undefined) {
      delivery.lastSeq = seq;
      this.send(pi, msg.ack(seq));
    }
  }

  onEvent(pi: PiId, e: AppEvent): void {
    switch (e.event) {
      case "player_register":
        this.onRegister(pi, e);
        break;
      case "game_start":
        this.onStart(pi, e);
        break;
      case "game_finish":
        this.onFinish(pi, e);
        break;
      case "player_leave":
        this.onLeave(pi);
        break;
      case "share":
        this.onShare(pi, e);
        break;
      case "player_incoming_ok":
        this.onIncomingOk(pi, e.id);
        break;
      case "player_left_ok":
        this.onLeftOk(pi, e.id);
        break;
    }
  }

  /** 8.3 */
  onRegister(pi: PiId, e: PlayerRegisterEvent): void {
    const name = "player_register";
    if (pi !== 1) {
      this.error(pi, "wrong_pi", "only pi 1 can register a player", name);
      return;
    }
    const slot = this.slot(1);
    if (slot.state === "empty") {
      const createdAt = this.time(pi, name, e.timestamp);
      const run: Run = {
        playerId: this.opt.newId(),
        username: e.username,
        createdAt,
        rooms: ROOMS.map(() => ({ startedAt: null, finishedAt: null, durationMs: null })),
        shares: [],
      };
      this.s.runs[run.playerId] = run;
      slot.state = "incoming";
      slot.playerId = run.playerId;
      slot.notified = true;
      this.upsertRun(run, "active", null, null);
      this.log("info", `run ${run.playerId} registered (${run.username})`);
      this.send(pi, msg.playerRegisterOk());
      return;
    }
    if (
      slot.state === "incoming" &&
      slot.playerId !== null &&
      this.run(slot.playerId).username === e.username
    ) {
      this.send(pi, msg.playerRegisterOk()); // repeated message
      return;
    }
    this.error(pi, "room_busy", "room 1 has a player", name);
  }

  /** 8.4 */
  onStart(pi: PiId, e: GameStartEvent): void {
    const slot = this.slot(pi);
    if (slot.state === "empty" || slot.playerId === null) {
      this.error(pi, "no_player", `room ${pi} has no player`, "game_start");
      return;
    }
    if (slot.state === "incoming") {
      const run = this.run(slot.playerId);
      this.roomTime(run, pi).startedAt = this.time(pi, "game_start", e.timestamp);
      slot.state = "playing";
      slot.notified = true;
      this.upsertRoomTime(run, pi);
    }
    // playing (repeated message) or waiting (already finished): keep the first start time.
    this.send(pi, msg.gameStartOk());
  }

  /** 8.5 */
  onFinish(pi: PiId, e: GameFinishEvent): void {
    const slot = this.slot(pi);
    if ((slot.state !== "playing" && slot.state !== "waiting") || slot.playerId === null) {
      this.error(pi, "not_playing", `room ${pi} has no player that plays`, "game_finish");
      return;
    }
    const run = this.run(slot.playerId);
    const rt = this.roomTime(run, pi);
    if (rt.finishedAt === null) {
      const finishedAt = this.time(pi, "game_finish", e.timestamp);
      const startedAt = rt.startedAt ?? finishedAt;
      let duration = finishedAt - startedAt;
      if (duration < 0) {
        this.log("warn", `run ${run.playerId} room ${pi}: finish before start; room time 0`);
        duration = 0;
      }
      rt.finishedAt = finishedAt;
      rt.durationMs = duration;
      this.upsertRoomTime(run, pi);
    }

    if (pi === 5) {
      const total = run.rooms.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
      run.rooms.forEach((r, i) => {
        const st = this.s.roomStats[i];
        if (st) {
          st.count += 1;
          st.sumMs += r.durationMs ?? 0;
        }
      });
      this.upsertRun(run, "completed", rt.finishedAt, total);
      delete this.s.runs[run.playerId];
      this.dropIncoming(5, run.playerId, false);
      slot.state = "empty";
      slot.playerId = null;
      slot.lastLeft = run.playerId;
      slot.notified = false;
      this.log("info", `run ${run.playerId} completed in ${total} ms`);
      this.outboxAdd(5, "game_finish_ok", () => msg.gameFinishOk(), run.playerId);
      this.roomEmptied(5);
      return;
    }

    if (this.slot(pi + 1).state === "empty") {
      this.handOver(pi);
      return;
    }

    slot.state = "waiting";
    const maxWait = this.now + this.waitEstimateMs(pi);
    this.send(pi, msg.gameFinishWait(formatInZone(maxWait, this.opt.tzName)));
  }

  /** 8.9 */
  onLeave(pi: PiId): void {
    const found = this.runForPi(pi);
    if (found === null) {
      // No run: a repeated message. Reply ok and do nothing more.
      this.send(pi, msg.playerLeaveOk());
      return;
    }
    const { playerId, room } = found;
    const run = this.run(playerId);
    const slot = this.slot(room);
    const wasIncoming = slot.state === "incoming";

    this.upsertRun(run, "left", null, null);
    delete this.s.runs[playerId];
    this.log("info", `run ${playerId} left in room ${room} (${slot.state}), from pi ${pi}`);

    // A late player_incoming_ok from another Pi can still come for a sent message.
    this.dropIncoming(room, playerId, pi !== room);
    if (wasIncoming && room >= 2) {
      if (slot.notified && pi !== room) {
        const username = run.username;
        this.outboxAdd(room, "player_left", (id) => msg.playerLeft(id, username), playerId);
      }
    }
    // The Pi that sends player_leave does not need a pending game_finish_ok for this run.
    for (const entry of this.s.outbox.filter(
      (x) => x.pi === pi && x.event === "game_finish_ok" && x.playerId === playerId,
    )) {
      this.outboxRemove(entry.id);
    }

    slot.state = "empty";
    slot.playerId = null;
    slot.lastLeft = playerId;
    slot.notified = false;
    this.roomEmptied(room);
    this.send(pi, msg.playerLeaveOk());
  }

  /** 8.8 */
  onShare(pi: PiId, e: ShareEvent): void {
    const found = this.runForPi(pi);
    if (found === null) {
      this.error(pi, "no_player", `room ${pi} has no player`, "share");
      return;
    }
    const run = this.run(found.playerId);
    const share: Share = {
      key: e.key,
      value: e.value,
      targets: e.targets,
      fromPi: pi,
      createdAt: this.time(pi, "share", e.timestamp),
    };
    const i = run.shares.findIndex((sh) => sh.key === e.key);
    if (i >= 0) run.shares[i] = share;
    else run.shares.push(share);
    this.db.push({ type: "share_upsert", playerId: run.playerId, share: structuredClone(share) });
    const passed = (e.targets ?? []).filter((t) => t <= found.room);
    if (passed.length > 0) {
      this.log(
        "warn",
        `run ${run.playerId} share '${e.key}' from pi ${pi}: target pi ${passed.join(", ")} already passed`,
      );
    }
    this.send(pi, msg.shareOk());
  }

  /**
   * 8.10: an ok with `id` removes only the outbox entry with that id (if it is an open
   * message of this event for this Pi). An ok for an unknown id has no effect. An ok
   * without `id` (old client) removes the oldest open message of this event for the Pi.
   */
  ackedEntry(pi: PiId, event: OutboxEvent, id: number): OutboxEntry | null {
    const entry = this.s.outbox.find((x) => x.id === id);
    if (!entry || entry.pi !== pi || entry.event !== event) {
      this.log("info", `pi ${pi}: ${event}_ok for id ${id} with no open ${event}`);
      return null;
    }
    return entry;
  }

  onIncomingOk(pi: PiId, id: number | undefined): void {
    const d = this.pi(pi);
    if (id !== undefined) {
      d.staleIncomingOks = 0;
      const entry = this.ackedEntry(pi, "player_incoming", id);
      if (!entry) return;
      this.outboxRemove(entry.id);
      const slot = this.slot(pi);
      if (slot.playerId === entry.playerId) slot.notified = true;
      return;
    }
    if (d.staleIncomingOks > 0) {
      d.staleIncomingOks -= 1;
      this.log("info", `pi ${pi}: ignored player_incoming_ok for a run that quit`);
      return;
    }
    const entry = this.s.outbox.find((x) => x.pi === pi && x.event === "player_incoming");
    if (!entry) {
      this.log("info", `pi ${pi}: player_incoming_ok with no open player_incoming`);
      return;
    }
    this.outboxRemove(entry.id);
    const slot = this.slot(pi);
    if (slot.playerId === entry.playerId) slot.notified = true;
  }

  onLeftOk(pi: PiId, id: number | undefined): void {
    if (id !== undefined) {
      const entry = this.ackedEntry(pi, "player_left", id);
      if (entry) this.outboxRemove(entry.id);
      return;
    }
    const entry = this.s.outbox.find((x) => x.pi === pi && x.event === "player_left");
    if (!entry) {
      this.log("info", `pi ${pi}: player_left_ok with no open player_left`);
      return;
    }
    this.outboxRemove(entry.id);
  }

  onOutboxSent(ids: number[]): void {
    for (const id of ids) {
      const entry = this.s.outbox.find((x) => x.id === id);
      if (!entry) continue;
      if (!entry.needsAck) {
        this.outboxRemove(id);
        continue;
      }
      if (entry.event === "player_incoming") {
        const slot = this.slot(entry.pi);
        if (slot.playerId === entry.playerId) slot.notified = true;
      }
      if (!entry.sent) {
        entry.sent = true;
        this.db.push({ type: "outbox_mark_sent", id });
      }
    }
  }

  // ------------------------------------------------------------ result

  finish(before: State): StepResult {
    const effects: Effect[] = [];
    // Order: run rows first (other rows refer to runs), then the other db
    // effects, then the slot and Pi rows that changed, then the sends.
    const runEffects = this.db.filter((e) => e.type === "run_upsert");
    const otherDb = this.db.filter((e) => e.type !== "run_upsert");
    effects.push(...runEffects, ...otherDb);
    this.s.slots.forEach((slot, i) => {
      if (JSON.stringify(slot) !== JSON.stringify(before.slots[i])) {
        effects.push({ type: "slot_upsert", slot: { ...slot } });
      }
    });
    this.s.pis.forEach((d, i) => {
      if (JSON.stringify(d) !== JSON.stringify(before.pis[i])) {
        effects.push({ type: "pi_upsert", pi: (i + 1) as PiId, delivery: { ...d } });
      }
    });
    effects.push(...this.sends);
    return { state: this.s, effects };
  }
}

// ---------------------------------------------------------------- read helpers

/** The room that has the run now, or null. */
export function roomOfRun(state: State, playerId: string): PiId | null {
  return state.slots.find((s) => s.playerId === playerId)?.room ?? null;
}
