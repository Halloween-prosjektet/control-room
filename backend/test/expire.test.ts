import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { ControlRoom } from "../src/index.ts";
import type { PiId } from "../src/protocol.ts";
import { logs, Sim } from "./harness.ts";

/** Registers a player and moves it to `room` in state `incoming` (all handovers acked). */
function toRoom(sim: Sim, username: string, room: PiId): string {
  sim.register(username);
  const id = sim.slot(1).playerId as string;
  for (let r = 1; r < room; r++) {
    sim.start(r as PiId);
    sim.advance(1000);
    sim.finish(r as PiId);
    sim.deliver(r as PiId);
    sim.accept((r + 1) as PiId);
  }
  return id;
}

describe("expire input", () => {
  test("a no-show in room 4 is removed, the waiting run moves in, the Pi gets player_left", () => {
    const sim = new Sim();
    const a = toRoom(sim, "A", 4); // incoming in room 4, acked
    const b = toRoom(sim, "B", 3);
    sim.start(3);
    sim.advance(1000);
    sim.finish(3);
    expect(sim.slot(3).state).toBe("waiting");

    const fx = sim.apply({ type: "expire", room: 4, playerId: a, reason: "test" });

    expect(sim.db.runs.get(a)?.status).toBe("left");
    expect(sim.state.runs[a]).toBeUndefined();
    expect(sim.slot(4)).toMatchObject({ state: "incoming", playerId: b });
    expect(sim.slot(3).state).toBe("empty");
    expect(logs(fx, "warn")[0]).toContain(`run ${a} expired in room 4 (incoming): test`);
    // Pi 4 knew run A (acked), so it gets player_left for A, then player_incoming for B.
    const events = sim.outboxFor(4).map((e) => [e.event, e.playerId]);
    expect(events).toEqual([
      ["player_left", a],
      ["player_incoming", b],
    ]);
  });

  test("a playing run expires and frees the room", () => {
    const sim = new Sim();
    const a = toRoom(sim, "A", 2);
    sim.start(2);
    sim.apply({ type: "expire", room: 2, playerId: a, reason: "test" });
    expect(sim.slot(2)).toMatchObject({ state: "empty", playerId: null, lastLeft: a });
    expect(sim.db.runs.get(a)?.status).toBe("left");
  });

  test("nothing happens for another run, a waiting run, or an empty room", () => {
    const sim = new Sim();
    const a = toRoom(sim, "A", 1);
    sim.start(1);
    sim.advance(1000);
    const before = JSON.stringify(sim.state);
    sim.apply({ type: "expire", room: 1, playerId: "other", reason: "test" });
    sim.apply({ type: "expire", room: 2, playerId: a, reason: "test" });
    expect(JSON.stringify(sim.state)).toBe(before);
  });
});

describe("ControlRoom.expireStale", () => {
  function makeRoom(limits: { incoming: number; playing: number }) {
    let now = Date.UTC(2026, 9, 31, 18, 0, 0, 0);
    let n = 0;
    const lines: string[] = [];
    const room = new ControlRoom(
      openDb(":memory:"),
      {
        ...DEFAULT_CONFIG,
        logFile: null,
        incomingTimeoutMs: limits.incoming,
        playingTimeoutMs: limits.playing,
      },
      { now: () => now, newId: () => `run-${++n}`, log: (_l, m) => lines.push(m) },
    );
    let seq = 0;
    const send = (pi: PiId, data: Record<string, unknown>) =>
      room.process({
        type: "message",
        pi,
        text: JSON.stringify({ ...data, seq: ++seq, timestamp: new Date(now).toISOString() }),
      });
    return {
      room,
      lines,
      send,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  test("room 1 incoming never expires", () => {
    const t = makeRoom({ incoming: 1000, playing: 0 });
    t.send(1, { event: "player_register", username: "A" });
    t.room.expireStale();
    t.advance(1_000_000);
    t.room.expireStale();
    expect(t.room.state.slots[0]?.state).toBe("incoming");
  });

  test("incoming in room 2 expires after the limit, not before; first sighting starts the clock", () => {
    const t = makeRoom({ incoming: 10_000, playing: 0 });
    t.send(1, { event: "player_register", username: "A" });
    t.send(1, { event: "game_start" });
    t.send(1, { event: "game_finish" }); // hand over to room 2 (incoming)
    expect(t.room.state.slots[1]?.state).toBe("incoming");
    t.room.expireStale(); // first sighting
    t.advance(9_000);
    t.room.expireStale();
    expect(t.room.state.slots[1]?.state).toBe("incoming");
    t.advance(1_000);
    t.room.expireStale();
    expect(t.room.state.slots[1]?.state).toBe("empty");
    expect(t.lines.some((l) => l.includes("expired in room 2 (incoming)"))).toBe(true);
  });

  test("a new run in the same room restarts the clock", () => {
    const t = makeRoom({ incoming: 10_000, playing: 0 });
    for (const name of ["A", "B"]) {
      t.send(1, { event: "player_register", username: name });
      t.send(1, { event: "game_start" });
      t.send(1, { event: "game_finish" });
      t.room.expireStale();
      t.advance(6_000);
      t.room.expireStale();
      t.send(2, { event: "player_leave" });
    }
    expect(t.room.state.slots[1]?.state).toBe("empty");
    expect(t.lines.some((l) => l.includes("expired"))).toBe(false);
  });

  test("playing expires; limit 0 disables", () => {
    const t = makeRoom({ incoming: 0, playing: 5_000 });
    t.send(1, { event: "player_register", username: "A" });
    t.send(1, { event: "game_start" });
    t.room.expireStale();
    t.advance(5_000);
    t.room.expireStale();
    expect(t.room.state.slots[0]?.state).toBe("empty");

    const off = makeRoom({ incoming: 0, playing: 0 });
    off.send(1, { event: "player_register", username: "A" });
    off.send(1, { event: "game_start" });
    off.room.expireStale();
    off.advance(1e9);
    off.room.expireStale();
    expect(off.room.state.slots[0]?.state).toBe("playing");
  });
});
