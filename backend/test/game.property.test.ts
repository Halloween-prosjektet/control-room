// Randomised property test: five Pis send random event sequences (fixed seeds).
// After every step the invariants below must hold. At the end, a "drain" phase
// plays all remaining runs to the end, to show that no run gets stuck.
//
// The Pis echo the `id` of player_incoming / player_left in most oks. They also send
// random duplicate and late oks for ids they received before. Such an ok must never
// remove an outbox entry other than the one with that id.
//
// Some Pis ack game_finish_ok (game_finish_ack {id}); for the others the server removes
// it after one send. Events carry no username, the right username, or a wrong one.

import { describe, expect, test } from "bun:test";
import type { Effect } from "../src/game.ts";
import type { PiId } from "../src/protocol.ts";
import { rng, Sim } from "./harness.ts";

const SEEDS = Array.from({ length: 24 }, (_, i) => 1000 + i * 7919);
const STEPS = 1500;
const NAMES = ["Ola", "Kari", "Per", "Ola", "Åse 🎃", "x"];
const KEYS = ["a", "b", "c", "__proto__"];

type Ctx = {
  sim: Sim;
  /** Last room seen for each run (path check). */
  lastRoom: Map<string, number>;
  /** Final status of runs that ended. */
  ended: Map<string, string>;
};

function fail(ctx: Ctx, why: string): never {
  throw new Error(`${why}\nstate: ${JSON.stringify(ctx.sim.state, null, 1)}`);
}

function checkInvariants(ctx: Ctx, effects: Effect[], hadSeq: number | undefined, dup: boolean) {
  const { sim } = ctx;
  const s = sim.state;
  const check = (cond: boolean, why: string) => {
    if (!cond) fail(ctx, why);
  };

  // Slots: max one run per room, and a consistent playerId.
  for (const slot of s.slots) {
    if (slot.state === "empty") check(slot.playerId === null, `room ${slot.room} empty with run`);
    else {
      check(slot.playerId !== null, `room ${slot.room} ${slot.state} without run`);
      check(s.runs[slot.playerId as string] !== undefined, `room ${slot.room} has unknown run`);
    }
    if (slot.state === "waiting") {
      check(slot.room < 5, "room 5 waiting");
      check(
        s.slots[slot.room]?.state !== "empty",
        `room ${slot.room} waits but next room is empty`,
      );
    }
  }

  // A run is in exactly one room. Its room times agree with its room. It never skips a room.
  for (const run of Object.values(s.runs)) {
    const rooms = s.slots.filter((sl) => sl.playerId === run.playerId);
    check(rooms.length === 1, `run ${run.playerId} is in ${rooms.length} rooms`);
    const slot = rooms[0];
    if (!slot) continue;
    const r = slot.room;
    run.rooms.forEach((rt, i) => {
      const room = i + 1;
      if (room < r)
        check(rt.durationMs !== null && rt.finishedAt !== null, `room ${room} not done`);
      if (room > r)
        check(rt.startedAt === null && rt.finishedAt === null, `future room ${room} set`);
    });
    const rt = run.rooms[r - 1];
    if (slot.state === "incoming") check(rt?.startedAt === null, "incoming with start time");
    if (slot.state === "playing")
      check(rt?.startedAt !== null && rt?.finishedAt === null, "playing times");
    if (slot.state === "waiting") check(rt?.durationMs !== null, "waiting without room time");
    const prev = ctx.lastRoom.get(run.playerId);
    if (prev === undefined) check(r === 1, `new run starts in room ${r}`);
    else check(r === prev || r === prev + 1, `run moved from room ${prev} to ${r}`);
    ctx.lastRoom.set(run.playerId, r);
  }

  // No run lost: each run row is active and in the state, or completed/left and not in the state.
  let completed = 0;
  const sums = [0, 0, 0, 0, 0];
  for (const row of sim.db.runs.values()) {
    const inState = s.runs[row.playerId] !== undefined;
    if (row.status === "active") check(inState, `active run ${row.playerId} lost`);
    else {
      check(!inState, `ended run ${row.playerId} still in the state`);
      const before = ctx.ended.get(row.playerId);
      check(before === undefined || before === row.status, `status changed after end`);
      ctx.ended.set(row.playerId, row.status);
    }
    if (row.status === "completed") {
      completed++;
      const times = [1, 2, 3, 4, 5].map((r) => sim.db.roomTimes.get(`${row.playerId}:${r}`));
      check(
        times.every((t) => t?.durationMs != null),
        "completed run without 5 room times",
      );
      const total = times.reduce((a, t) => a + (t?.durationMs ?? 0), 0);
      check(row.totalTimeMs === total, `total ${row.totalTimeMs} != sum ${total}`);
      check(row.completedAt === times[4]?.finishedAt, "completed_at != finish of room 5");
      times.forEach((t, i) => {
        sums[i] = (sums[i] ?? 0) + (t?.durationMs ?? 0);
      });
    }
  }
  for (const id of Object.keys(s.runs)) {
    check(sim.db.runs.get(id)?.status === "active", `state run ${id} has no active row`);
  }
  s.roomStats.forEach((st, i) => {
    check(st.count === completed && st.sumMs === sums[i], `roomStats ${i + 1} wrong`);
  });

  // Outbox: references existing runs; ids increase; payload agrees with the entry.
  let lastId = 0;
  for (const e of s.outbox) {
    check(e.id > lastId && e.id < s.nextOutboxId, "outbox id order");
    lastId = e.id;
    check(sim.db.runs.has(e.playerId), `outbox entry for unknown run ${e.playerId}`);
    check(e.payload.event === e.event, "payload event");
    check(e.needsAck, "needsAck");
    check("id" in e.payload && e.payload.id === e.id, "payload id is not the outbox id");
    if (e.event === "player_incoming") {
      check(s.runs[e.playerId] !== undefined, "player_incoming for a run that is not active");
      check(
        s.slots[e.pi - 1]?.playerId === e.playerId,
        "player_incoming for a run not in that room",
      );
      // F3 (OutboxCurrent): only while the run is incoming in that room.
      check(s.slots[e.pi - 1]?.state === "incoming", "player_incoming after the start");
      // F5: player_data is the current data of the run.
      const run = s.runs[e.playerId];
      if (run && e.payload.event === "player_incoming") {
        const want = Object.fromEntries(
          run.shares
            .filter((sh) => sh.targets === null || sh.targets.includes(e.pi))
            .map((sh) => [sh.key, sh.value]),
        );
        check(
          JSON.stringify(e.payload.player_data) === JSON.stringify(want),
          "player_data is not the current data",
        );
      }
    }
    if (e.event === "game_finish_ok") {
      const username = sim.db.runs.get(e.playerId)?.username;
      check(e.payload.event === "game_finish_ok" && e.payload.username === username, "finish ok");
    }
    if (e.event === "player_left")
      check(sim.db.runs.get(e.playerId)?.status === "left", "player_left");
  }

  // The mirror db (db effects only) agrees with the state.
  expect([...sim.db.slots.values()].sort((a, b) => a.room - b.room)).toEqual(s.slots);
  expect([...sim.db.outbox.values()]).toEqual(s.outbox);
  expect([...sim.db.pis.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1])).toEqual(s.pis);

  // JSON round trip.
  expect(JSON.parse(JSON.stringify(s))).toEqual(s);

  // Acks: a message with a seq gets exactly one ack, as the last send. A repeated seq has no db effect.
  const acks = effects.filter((e) => e.type === "send" && e.msg.event === "ack");
  if (hadSeq === undefined) check(acks.length === 0, "ack without seq");
  else {
    check(acks.length === 1, `${acks.length} acks`);
    const lastSend = effects.filter((e) => e.type === "send").at(-1);
    check(lastSend === acks[0], "ack is not the last send");
  }
  if (dup) {
    check(
      effects.every((e) => e.type === "send" || e.type === "log"),
      "repeated seq changed the db",
    );
  }
}

function runSeed(seed: number) {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  let ids = 0;
  const sim = new Sim({ newId: () => `s${seed}-r${++ids}` });
  const ctx: Ctx = { sim, lastRoom: new Map(), ended: new Map() };
  const pis: PiId[] = [1, 2, 3, 4, 5];
  const stats = { completed: 0, left: 0, waits: 0 };
  /** Pis whose client acks game_finish_ok. */
  const finishAck = pis.filter(() => rand() < 0.5);
  /** The username field of an event: none, the player of the Pi, or a wrong one. */
  const who = (pi: PiId): Record<string, unknown> => {
    const r = rand();
    if (r < 0.4) return {};
    if (r < 0.85) {
      const slot = sim.slot(pi);
      const id = slot.playerId ?? slot.lastLeft;
      const name = id === null ? undefined : sim.state.runs[id]?.username;
      return name === undefined ? {} : { username: name };
    }
    return { username: pick(NAMES) };
  };
  const OK_EVENT: Record<string, string> = {
    player_incoming: "player_incoming_ok",
    player_left: "player_left_ok",
    game_finish_ok: "game_finish_ack",
  };

  const doStep = (fn: () => Effect[], hadSeq: number | undefined, dup = false) => {
    const fx = fn();
    for (const e of fx) if (e.type === "send" && e.msg.event === "game_finish_wait") stats.waits++;
    checkInvariants(ctx, fx, hadSeq, dup);
  };
  const app = (pi: PiId, data: Record<string, unknown>) => {
    const noSeq = rand() < 0.03; // old client
    const seq = noSeq ? undefined : (sim.seq[pi - 1] as number) + 1;
    doStep(() => sim.ev(pi, data, noSeq ? false : undefined), seq);
  };
  /** Every copy of player_incoming / player_left that each Pi got (in order). */
  const received: { id: number; event: string }[][] = [[], [], [], [], []];
  const sendOut = (ids: number[]) => {
    for (const e of sim.state.outbox) {
      if (ids.includes(e.id)) received[e.pi - 1]?.push({ id: e.id, event: e.event });
    }
    doStep(() => sim.apply({ type: "outbox_sent", ids, finishAckPis: finishAck }), undefined);
    for (const e of sim.state.outbox) {
      if (ids.includes(e.id) && e.event === "game_finish_ok" && !finishAck.includes(e.pi))
        fail(ctx, "game_finish_ok kept for a Pi without game_finish_ack");
    }
  };
  /** An ok with `id`: it can only remove the entry with that id. */
  const idOk = (pi: PiId, event: string, id: number) => {
    const ok = OK_EVENT[event] as string;
    const target = sim.state.outbox.find((x) => x.id === id);
    const seq = (sim.seq[pi - 1] as number) + 1;
    doStep(() => {
      const fx = sim.ev(pi, { event: ok, id });
      const removed = fx.flatMap((x) => (x.type === "outbox_remove" ? [x.id] : []));
      for (const rid of removed) {
        if (rid !== id) fail(ctx, `${ok} id ${id} removed entry ${rid}`);
      }
      const match = target !== undefined && target.pi === pi && target.event === event;
      if (removed.length !== (match ? 1 : 0)) fail(ctx, `${ok} id ${id} removed ${removed}`);
      return fx;
    }, seq);
  };
  /** Acks an open entry like the Godot client: mostly with `id`, sometimes without. */
  const ackEntry = (pi: PiId, e: { id: number; event: string }) => {
    if (rand() < 0.15 && e.event !== "game_finish_ok")
      app(pi, { event: e.event === "player_left" ? "player_left_ok" : "player_incoming_ok" });
    else idOk(pi, e.event, e.id);
  };

  for (let i = 0; i < STEPS; i++) {
    if (rand() < 0.3) sim.advance(Math.floor(rand() * 120_000));
    const pi = pick(pis);
    const slot = sim.slot(pi);
    const smart = rand() < 0.5;
    const r = rand();
    if (smart && slot.state === "incoming" && r < 0.6) {
      app(pi, { event: "game_start", timestamp: sim.ts(), ...who(pi) });
    } else if (smart && slot.state === "playing" && r < 0.6) {
      app(pi, {
        event: "game_finish",
        timestamp: sim.ts(-Math.floor(rand() * 1000)),
        ...who(pi),
      });
    } else if (smart && pi === 1 && slot.state === "empty" && r < 0.7) {
      app(1, { event: "player_register", username: pick(NAMES), timestamp: sim.ts() });
    } else if (smart && sim.outboxFor(pi).some((e) => e.sent && e.needsAck)) {
      const e = sim.outboxFor(pi).find((x) => x.sent && x.needsAck);
      if (e) ackEntry(pi, e);
    } else {
      const kind = rand();
      if (kind < 0.12)
        app(pi, { event: "player_register", username: pick(NAMES), timestamp: sim.ts() });
      else if (kind < 0.24) app(pi, { event: "game_start", timestamp: sim.ts(), ...who(pi) });
      else if (kind < 0.36)
        app(pi, {
          event: "game_finish",
          timestamp: rand() < 0.1 ? "bad" : sim.ts(),
          ...who(pi),
        });
      else if (kind < 0.42) app(pi, { event: "player_leave", ...who(pi) });
      else if (kind < 0.54) {
        const t = rand();
        const target = t < 0.3 ? null : t < 0.6 ? pick(pis) : pis.filter(() => rand() < 0.4);
        app(pi, {
          event: "share",
          key: pick(KEYS),
          value: { n: i },
          pi: target,
          timestamp: sim.ts(),
          ...who(pi),
        });
      } else if (kind < 0.56) app(pi, { event: "player_incoming_ok" });
      else if (kind < 0.58) app(pi, { event: "player_left_ok" });
      else if (kind < 0.64) {
        // A duplicate or late ok for a copy that the Pi got before (or a random id,
        // or the wrong ok event for the id).
        const got = received[pi - 1] ?? [];
        const old = got.length > 0 && rand() < 0.85 ? pick(got) : undefined;
        if (old && rand() < 0.9) idOk(pi, old.event, old.id);
        else if (old)
          idOk(pi, old.event === "player_left" ? "player_incoming" : "player_left", old.id);
        else
          idOk(
            pi,
            pick(["player_left", "player_incoming", "game_finish_ok"]),
            1 + Math.floor(rand() * 40),
          );
      } else if (kind < 0.82) {
        // outbox.ts sends a random part of the outbox
        sendOut(sim.state.outbox.filter(() => rand() < 0.6).map((e) => e.id));
      } else if (kind < 0.92) {
        // The client sends an event again with an old seq (lost ack).
        const last = sim.seq[pi - 1] as number;
        if (last > 0) {
          const old = 1 + Math.floor(rand() * last);
          const data = pick([
            { event: "game_finish" },
            { event: "player_leave" },
            { event: "player_register", username: "Ola" },
            { event: "player_incoming_ok" },
          ]);
          doStep(() => sim.ev(pi, data, old), old, true);
        }
      } else if (kind < 0.96) {
        doStep(() => sim.apply({ type: "message", pi, text: "{not json" }), undefined);
      } else {
        app(pi, { event: "teleport" });
      }
    }
  }

  // Drain: act like well-behaved Pis until every run has ended.
  for (let i = 0; i < 2000; i++) {
    const s = sim.state;
    if (s.slots.every((x) => x.state === "empty") && s.outbox.length === 0) break;
    sim.advance(1000);
    if (s.outbox.length > 0) sendOut(s.outbox.map((e) => e.id));
    for (const pi of pis) {
      for (const e of sim.outboxFor(pi).filter((x) => x.needsAck)) ackEntry(pi, e);
      // A late duplicate ok for an old copy.
      const got = received[pi - 1] ?? [];
      const old = got.length > 0 && rand() < 0.3 ? pick(got) : undefined;
      if (old) idOk(pi, old.event, old.id);
    }
    for (let room = 5 as PiId; room >= 1; room--) {
      const st = sim.slot(room).state;
      if (st === "incoming") app(room, { event: "game_start", timestamp: sim.ts() });
      else if (st === "playing") app(room, { event: "game_finish", timestamp: sim.ts() });
    }
  }
  expect(sim.state.slots.every((x) => x.state === "empty")).toBe(true);
  expect(sim.state.outbox).toEqual([]);
  expect(Object.keys(sim.state.runs)).toEqual([]);
  for (const row of sim.db.runs.values()) expect(["completed", "left"]).toContain(row.status);
  for (const row of sim.db.runs.values()) {
    if (row.status === "completed") stats.completed++;
    else stats.left++;
  }
  return stats;
}

describe("random event sequences from 5 Pis", () => {
  const totals = { completed: 0, left: 0, waits: 0 };
  test.each(SEEDS)("seed %d", (seed) => {
    const st = runSeed(seed);
    totals.completed += st.completed;
    totals.left += st.left;
    totals.waits += st.waits;
  });
  test("the random runs reach the interesting states", () => {
    // Make sure the generator is not trivial.
    expect(totals.completed).toBeGreaterThan(SEEDS.length * 3);
    expect(totals.left).toBeGreaterThan(SEEDS.length);
    expect(totals.waits).toBeGreaterThan(SEEDS.length);
  });
});
