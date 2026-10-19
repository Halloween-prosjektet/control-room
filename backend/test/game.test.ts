import { describe, expect, test } from "bun:test";
import { emptyState, MIN_WAIT_MS, roomOfRun, step } from "../src/game.ts";
import type { PiId } from "../src/protocol.ts";
import { formatInZone } from "../src/time.ts";
import { BASE, logs, replies, Sim, sends } from "./harness.ts";

const OSLO = "Europe/Oslo";
/** The outbox id in a player_incoming / player_left payload. */
const anyId = expect.any(Number) as unknown as number;

/** Registers a player and moves it to `room` in state `incoming` (all handovers acked). */
function toRoom(sim: Sim, username: string, room: PiId, roomMs = 1000): string {
  sim.register(username);
  const id = sim.slot(1).playerId as string;
  for (let r = 1; r < room; r++) {
    sim.start(r as PiId);
    sim.advance(roomMs);
    sim.finish(r as PiId);
    sim.deliver(r as PiId);
    sim.accept((r + 1) as PiId);
  }
  return id;
}

function fullRun(sim: Sim, username: string, roomMs: number[]): string {
  const id = toRoom(sim, username, 1);
  for (let r = 1 as PiId; r <= 5; r++) {
    sim.start(r);
    sim.advance(roomMs[r - 1] ?? 1000);
    sim.finish(r);
    sim.deliver(r);
    if (r < 5) sim.accept((r + 1) as PiId);
  }
  return id;
}

describe("register (8.3)", () => {
  test("room 1 empty: new run, incoming, player_register_ok then ack", () => {
    const sim = new Sim();
    const fx = sim.register("Ola");
    expect(sends(fx, 1)).toEqual([{ event: "player_register_ok" }, { event: "ack", seq: 1 }]);
    expect(sim.slot(1)).toMatchObject({ state: "incoming", playerId: "run-1" });
    expect(sim.state.runs["run-1"]).toMatchObject({ username: "Ola", createdAt: BASE });
    expect(sim.db.runs.get("run-1")).toMatchObject({ status: "active", username: "Ola" });
  });

  test("alias register works", () => {
    const sim = new Sim();
    const fx = sim.ev(1, { event: "register", username: "Kari", timestamp: sim.ts() });
    expect(replies(fx)).toEqual([{ event: "player_register_ok" }]);
    expect(sim.username(1)).toBe("Kari");
  });

  test("username is trimmed", () => {
    const sim = new Sim();
    sim.register("  Per  ");
    expect(sim.username(1)).toBe("Per");
  });

  test("repeated register (same username, incoming) gives ok and no new run", () => {
    const sim = new Sim();
    sim.register("Ola");
    const fx = sim.register("Ola");
    expect(replies(fx)).toEqual([{ event: "player_register_ok" }]);
    expect(Object.keys(sim.state.runs)).toEqual(["run-1"]);
  });

  test("different run in room 1 gives room_busy", () => {
    const sim = new Sim();
    sim.register("Ola");
    expect(replies(sim.register("Kari"))).toEqual([
      {
        event: "error",
        code: "room_busy",
        message: "room 1 has a player",
        event_name: "player_register",
      },
    ]);
    // Same username, but the player already plays: also room_busy.
    sim.start(1);
    expect(replies(sim.register("Ola"))[0]).toMatchObject({ code: "room_busy" });
  });

  test("Pi 2-5 gives wrong_pi", () => {
    const sim = new Sim();
    for (const pi of [2, 3, 4, 5] as PiId[]) {
      const fx = sim.ev(pi, { event: "player_register", username: "x" });
      expect(replies(fx)[0]).toMatchObject({
        event: "error",
        code: "wrong_pi",
        event_name: "player_register",
      });
    }
    expect(sim.slot(1).state).toBe("empty");
  });

  test("bad username gives bad_request and still acks", () => {
    const sim = new Sim();
    const fx = sim.ev(1, { event: "player_register", username: "   " });
    expect(sends(fx)).toEqual([
      expect.objectContaining({
        event: "error",
        code: "bad_request",
        event_name: "player_register",
      }),
      { event: "ack", seq: 1 },
    ]);
  });

  test("room 1 is free again when the previous player is in room 2", () => {
    const sim = new Sim();
    toRoom(sim, "A", 2);
    expect(replies(sim.register("B"))).toEqual([{ event: "player_register_ok" }]);
    expect(sim.username(1)).toBe("B");
    expect(sim.username(2)).toBe("A");
  });
});

describe("start (8.4)", () => {
  test("empty room gives no_player", () => {
    const sim = new Sim();
    expect(replies(sim.start(3))[0]).toMatchObject({
      code: "no_player",
      event_name: "game_start",
    });
  });

  test("incoming goes to playing with the client start time", () => {
    const sim = new Sim();
    sim.register("Ola");
    const ts = sim.ts(-1500);
    const fx = sim.ev(1, { event: "game_start", timestamp: ts });
    expect(replies(fx)).toEqual([{ event: "game_start_ok" }]);
    expect(sim.slot(1).state).toBe("playing");
    expect(sim.state.runs["run-1"]?.rooms[0]?.startedAt).toBe(BASE - 1500);
    expect(sim.db.roomTimes.get("run-1:1")?.startedAt).toBe(BASE - 1500);
  });

  test("repeated start keeps the first start time", () => {
    const sim = new Sim();
    sim.register("Ola");
    sim.start(1);
    sim.advance(5000);
    expect(replies(sim.start(1))).toEqual([{ event: "game_start_ok" }]);
    expect(sim.state.runs["run-1"]?.rooms[0]?.startedAt).toBe(BASE);
  });

  test("start while waiting gives ok and changes nothing", () => {
    const sim = new Sim();
    toRoom(sim, "A", 2);
    sim.start(2);
    sim.register("B");
    sim.start(1);
    sim.finish(1);
    expect(sim.slot(1).state).toBe("waiting");
    expect(replies(sim.start(1))).toEqual([{ event: "game_start_ok" }]);
    expect(sim.slot(1).state).toBe("waiting");
  });

  test("bad timestamp: server time and a warning", () => {
    const sim = new Sim();
    sim.register("Ola");
    const fx = sim.ev(1, { event: "game_start", timestamp: "yesterday" });
    expect(sim.state.runs["run-1"]?.rooms[0]?.startedAt).toBe(BASE);
    expect(logs(fx, "warn")[0]).toContain("not valid");
  });

  test("6 digit fraction with +02:00 offset", () => {
    const sim = new Sim();
    sim.register("Ola");
    sim.ev(1, { event: "game_start", timestamp: "2026-10-31T20:00:01.250999+02:00" });
    expect(sim.state.runs["run-1"]?.rooms[0]?.startedAt).toBe(BASE + 1250);
  });
});

describe("finish (8.5) and hand over (8.6)", () => {
  test("not playing gives not_playing", () => {
    const sim = new Sim();
    expect(replies(sim.finish(1))[0]).toMatchObject({
      code: "not_playing",
      event_name: "game_finish",
    });
    sim.register("Ola");
    expect(replies(sim.finish(1))[0]).toMatchObject({ code: "not_playing" });
  });

  test("next room empty: hand over", () => {
    const sim = new Sim();
    sim.register("Ola");
    sim.share(1, "color", "red", 2);
    sim.share(1, "secret", 42, 3);
    sim.start(1);
    sim.advance(4500);
    const fx = sim.finish(1);
    // Direct replies: only the ack. game_finish_ok goes through the outbox.
    expect(sends(fx, 1)).toEqual([{ event: "ack", seq: 5 }]);
    expect(sim.slot(1)).toMatchObject({ state: "empty", playerId: null, lastLeft: "run-1" });
    expect(sim.slot(2)).toMatchObject({ state: "incoming", playerId: "run-1", notified: false });
    expect(sim.state.runs["run-1"]?.rooms[0]).toEqual({
      startedAt: BASE,
      finishedAt: BASE + 4500,
      durationMs: 4500,
    });
    expect(sim.outboxFor(1).map((e) => [e.event, e.needsAck])).toEqual([["game_finish_ok", true]]);
    expect(sim.outboxFor(2).map((e) => e.payload)).toEqual([
      { event: "player_incoming", id: anyId, username: "Ola", player_data: { color: "red" } },
    ]);
  });

  test("game_finish_ok to a client without game_finish_ack is removed after one send", () => {
    const sim = new Sim();
    toRoom(sim, "A", 1);
    sim.start(1);
    sim.finish(1);
    expect(sim.deliver(1)).toEqual([{ event: "game_finish_ok", id: anyId, username: "A" }]);
    expect(sim.outboxFor(1)).toEqual([]);
  });

  test("player_incoming stays until player_incoming_ok, and is marked sent", () => {
    const sim = new Sim();
    toRoom(sim, "A", 1);
    sim.start(1);
    sim.finish(1);
    sim.deliver(2);
    sim.deliver(2);
    expect(sim.outboxFor(2)).toMatchObject([{ event: "player_incoming", sent: true }]);
    expect(sim.slot(2).notified).toBe(true);
    sim.incomingOk(2);
    expect(sim.outboxFor(2)).toEqual([]);
    // A second ok is harmless.
    expect(replies(sim.incomingOk(2))).toEqual([]);
  });

  test("next room busy: waiting and game_finish_wait; hand over when it is free", () => {
    const sim = new Sim();
    toRoom(sim, "A", 2);
    sim.start(2);
    sim.register("B");
    sim.start(1);
    sim.advance(1000);
    const fx = sim.finish(1);
    expect(replies(fx, 1)).toEqual([
      { event: "game_finish_wait", max_wait: expect.any(String) as unknown as string },
    ]);
    expect(sim.slot(1).state).toBe("waiting");
    expect(sim.outboxFor(1)).toEqual([]);

    // Repeated finish while waiting: wait again, the finish time stays.
    sim.advance(5000);
    expect(replies(sim.finish(1))[0]?.event).toBe("game_finish_wait");
    expect(sim.state.runs["run-2"]?.rooms[0]?.durationMs).toBe(1000);

    // A finishes room 2: A goes to 3, B goes to 2.
    sim.finish(2);
    expect(sim.username(3)).toBe("A");
    expect(sim.username(2)).toBe("B");
    expect(sim.slot(1).state).toBe("empty");
    expect(sim.outboxFor(1).map((e) => e.payload)).toEqual([
      { event: "game_finish_ok", id: anyId, username: "B" },
    ]);
    expect(sim.outboxFor(2).map((e) => e.payload.event)).toEqual([
      "game_finish_ok",
      "player_incoming",
    ]);
    // The wait time is not part of the room time.
    expect(sim.state.runs["run-2"]?.rooms[0]?.durationMs).toBe(1000);
  });

  test("hand-over chain from room 5 back to room 1", () => {
    const sim = new Sim();
    const names = ["A", "B", "C", "D", "E"];
    // A in room 5 playing, B..E waiting in rooms 4..1.
    for (let i = 0; i < 5; i++) {
      const name = names[i] as string;
      toRoom(sim, name, (5 - i) as PiId);
      sim.start((5 - i) as PiId);
    }
    for (let room = 4 as PiId; room >= 1; room--) {
      sim.advance(1000);
      expect(replies(sim.finish(room))[0]?.event).toBe("game_finish_wait");
    }
    expect(sim.state.slots.map((s) => s.state)).toEqual([
      "waiting",
      "waiting",
      "waiting",
      "waiting",
      "playing",
    ]);
    sim.deliver();
    sim.advance(1000);
    sim.finish(5);
    expect(sim.state.slots.map((s) => [s.state, sim.username(s.room)])).toEqual([
      ["empty", null],
      ["incoming", "E"],
      ["incoming", "D"],
      ["incoming", "C"],
      ["incoming", "B"],
    ]);
    expect(sim.state.outbox.map((e) => [e.pi, e.event])).toEqual([
      [5, "game_finish_ok"],
      [4, "game_finish_ok"],
      [5, "player_incoming"],
      [3, "game_finish_ok"],
      [4, "player_incoming"],
      [2, "game_finish_ok"],
      [3, "player_incoming"],
      [1, "game_finish_ok"],
      [2, "player_incoming"],
    ]);
    expect(sim.db.runs.get("run-1")?.status).toBe("completed");
  });

  test("room 5: completed, total is the sum, run leaves the state", () => {
    const sim = new Sim();
    const id = fullRun(sim, "John Doe", [4500, 4800, 4200, 3100, 4500]);
    const row = sim.db.runs.get(id);
    expect(row).toMatchObject({ status: "completed", totalTimeMs: 21100 });
    expect(row?.completedAt).toBe(sim.now);
    expect(sim.state.runs[id]).toBeUndefined();
    expect(sim.slot(5)).toMatchObject({ state: "empty", lastLeft: id });
    expect(sim.state.roomStats.map((s) => s.sumMs)).toEqual([4500, 4800, 4200, 3100, 4500]);
    expect(sim.state.roomStats.every((s) => s.count === 1)).toBe(true);
    expect([1, 2, 3, 4, 5].map((r) => sim.db.roomTimes.get(`${id}:${r}`)?.durationMs)).toEqual([
      4500, 4800, 4200, 3100, 4500,
    ]);
    // Finish after completion: not_playing.
    expect(replies(sim.finish(5))[0]).toMatchObject({ code: "not_playing" });
  });

  test("finish before start (clock skew) gives room time 0 and a warning", () => {
    const sim = new Sim();
    sim.register("A");
    sim.start(1);
    const fx = sim.ev(1, { event: "game_finish", timestamp: sim.ts(-5000) });
    expect(sim.state.runs["run-1"]?.rooms[0]?.durationMs).toBe(0);
    expect(logs(fx, "warn").join()).toContain("finish before start");
  });
});

describe("max_wait (8.7)", () => {
  function waitMs(sim: Sim, room: PiId): number {
    const fx = sim.finish(room);
    const m = replies(fx, room)[0];
    if (m?.event !== "game_finish_wait") throw new Error(`no wait: ${JSON.stringify(m)}`);
    expect(m.max_wait).toBe(formatInZone(Date.parse(m.max_wait), OSLO));
    return Date.parse(m.max_wait) - sim.now;
  }

  test("next room incoming: full default average", () => {
    const sim = new Sim();
    toRoom(sim, "A", 2); // A incoming in room 2
    sim.register("B");
    sim.start(1);
    expect(waitMs(sim, 1)).toBe(300_000);
  });

  test("next room playing: start + average - now", () => {
    const sim = new Sim();
    toRoom(sim, "A", 2);
    sim.start(2);
    sim.register("B");
    sim.start(1);
    sim.advance(100_000);
    expect(waitMs(sim, 1)).toBe(200_000);
  });

  test("minimum is 30 seconds", () => {
    const sim = new Sim({ defaultRoomMs: 10_000 });
    toRoom(sim, "A", 2);
    sim.start(2);
    sim.register("B");
    sim.start(1);
    sim.advance(60_000);
    expect(waitMs(sim, 1)).toBe(MIN_WAIT_MS);
  });

  test("next room waiting: add the room after it", () => {
    const sim = new Sim();
    toRoom(sim, "A", 3);
    sim.start(3); // A playing in 3, started at t0
    const t0 = sim.now;
    toRoom(sim, "B", 2);
    sim.start(2);
    sim.advance(50_000);
    expect(waitMs(sim, 2)).toBe(t0 + 300_000 - sim.now); // B waits in room 2
    sim.register("C");
    sim.start(1);
    // Room 2 is waiting, so the estimate is the estimate of room 3.
    expect(waitMs(sim, 1)).toBe(t0 + 300_000 - sim.now);
  });

  test("uses the average room time of completed runs", () => {
    const sim = new Sim();
    fullRun(sim, "X", [1000, 60_000, 1000, 1000, 1000]);
    fullRun(sim, "Y", [1000, 80_000, 1000, 1000, 1000]);
    toRoom(sim, "A", 2); // incoming in 2
    sim.register("B");
    sim.start(1);
    expect(waitMs(sim, 1)).toBe(70_000);
  });

  test("max_wait is written in Europe/Oslo with offset", () => {
    const sim = new Sim();
    toRoom(sim, "A", 2);
    sim.register("B");
    sim.start(1);
    const m = replies(sim.finish(1))[0];
    expect(m).toEqual({
      event: "game_finish_wait",
      max_wait: formatInZone(sim.now + 300_000, OSLO),
    });
    expect((m as { max_wait: string }).max_wait).toEndWith("+01:00");
  });
});

describe("share (8.8)", () => {
  test("share from Pi 1 to Pi 3 comes in player_data of room 3 only", () => {
    const sim = new Sim();
    sim.register("A");
    expect(replies(sim.share(1, "secret", { code: [1, 2] }, 3))).toEqual([{ event: "share_ok" }]);
    sim.share(1, "all", true, null);
    sim.share(1, "two_and_four", "x", [2, 4]);
    sim.start(1);
    sim.finish(1);
    expect(sim.outboxFor(2)[0]?.payload).toMatchObject({
      player_data: { all: true, two_and_four: "x" },
    });
    sim.accept(2);
    sim.start(2);
    sim.finish(2);
    expect(sim.outboxFor(3)[0]?.payload).toEqual({
      event: "player_incoming",
      id: anyId,
      username: "A",
      player_data: { secret: { code: [1, 2] }, all: true },
    });
  });

  test("last value wins", () => {
    const sim = new Sim();
    sim.register("A");
    sim.share(1, "k", 1, 2);
    sim.share(1, "k", 2, 2);
    sim.start(1);
    sim.finish(1);
    expect(sim.outboxFor(2)[0]?.payload).toMatchObject({ player_data: { k: 2 } });
    expect(sim.db.shares.get("run-1:k")?.value).toBe(2);
  });

  test("key __proto__ is a normal key", () => {
    const sim = new Sim();
    sim.register("A");
    sim.share(1, "__proto__", { a: 1 }, 2);
    sim.start(1);
    sim.finish(1);
    const payload = sim.outboxFor(2)[0]?.payload;
    expect(JSON.parse(JSON.stringify(payload))).toEqual(
      JSON.parse(
        '{"event":"player_incoming","id":2,"username":"A","player_data":{"__proto__":{"a":1}}}',
      ),
    );
  });

  test("empty room with no run gives no_player", () => {
    const sim = new Sim();
    expect(replies(sim.share(2, "k", 1))[0]).toMatchObject({
      code: "no_player",
      event_name: "share",
    });
  });

  test("after finish: share goes to the run that is incoming in the next room", () => {
    const sim = new Sim();
    toRoom(sim, "A", 2);
    expect(sim.slot(1).state).toBe("empty");
    expect(replies(sim.share(1, "late", 7, 3))).toEqual([{ event: "share_ok" }]);
    expect(sim.state.runs["run-1"]?.shares.map((s) => s.key)).toEqual(["late"]);
    // When the next room has started the run: no_player.
    sim.start(2);
    expect(replies(sim.share(1, "later", 8, 3))[0]).toMatchObject({ code: "no_player" });
  });

  test("a target that the player already passed: saved, with a warning", () => {
    const sim = new Sim();
    toRoom(sim, "A", 3);
    const fx = sim.share(3, "back", 1, [1, 2, 5]);
    expect(replies(fx)).toEqual([{ event: "share_ok" }]);
    expect(logs(fx, "warn").join()).toContain("already passed");
    expect(sim.db.shares.get("run-1:back")?.targets).toEqual([1, 2, 5]);
  });

  test("share while waiting goes to the waiting run", () => {
    const sim = new Sim();
    toRoom(sim, "A", 2);
    sim.register("B");
    sim.start(1);
    sim.finish(1);
    expect(sim.slot(1).state).toBe("waiting");
    sim.share(1, "k", "v", 2);
    expect(sim.state.runs["run-2"]?.shares).toHaveLength(1);
  });

  test("bad share gives bad_request", () => {
    const sim = new Sim();
    sim.register("A");
    expect(replies(sim.ev(1, { event: "share", key: "k", value: 1, pi: 7 }))[0]).toMatchObject({
      code: "bad_request",
      event_name: "share",
    });
  });
});

describe("player quits (8.9)", () => {
  test("registered (incoming in room 1)", () => {
    const sim = new Sim();
    sim.register("A");
    expect(replies(sim.leave(1))).toEqual([{ event: "player_leave_ok" }]);
    expect(sim.slot(1)).toMatchObject({ state: "empty", playerId: null, lastLeft: "run-1" });
    expect(sim.db.runs.get("run-1")?.status).toBe("left");
    expect(sim.state.runs).toEqual({});
    expect(sim.state.outbox).toEqual([]);
  });

  test("playing: keeps the room times that it has", () => {
    const sim = new Sim();
    toRoom(sim, "A", 2, 4000);
    sim.start(2);
    sim.leave(2);
    expect(sim.db.runs.get("run-1")).toMatchObject({ status: "left", totalTimeMs: null });
    expect(sim.db.roomTimes.get("run-1:1")?.durationMs).toBe(4000);
    expect(sim.db.roomTimes.get("run-1:2")?.startedAt).not.toBeNull();
    expect(sim.slot(2).state).toBe("empty");
  });

  test("waiting: room empties and the run waiting before it moves in", () => {
    const sim = new Sim();
    toRoom(sim, "A", 3);
    sim.start(3);
    toRoom(sim, "B", 2);
    sim.start(2);
    sim.finish(2); // B waits in 2
    sim.register("C");
    sim.start(1);
    sim.finish(1); // C waits in 1
    sim.deliver();
    const fx = sim.leave(2); // B quits while waiting
    expect(replies(fx, 2)).toEqual([{ event: "player_leave_ok" }]);
    expect(sim.username(2)).toBe("C");
    expect(sim.slot(2).state).toBe("incoming");
    expect(sim.slot(1).state).toBe("empty");
    expect(sim.db.runs.get("run-2")?.status).toBe("left");
  });

  test("after finish, player_incoming not sent yet: deleted, no player_left", () => {
    const sim = new Sim();
    sim.register("A");
    sim.start(1);
    sim.finish(1);
    sim.leave(1);
    expect(sim.slot(2).state).toBe("empty");
    expect(sim.outboxFor(2)).toEqual([]);
    expect(sim.db.runs.get("run-1")?.status).toBe("left");
    // The pending game_finish_ok for Pi 1 is not necessary now.
    expect(sim.outboxFor(1)).toEqual([]);
  });

  test("after finish, player_incoming sent: deleted, player_left to the next Pi", () => {
    const sim = new Sim();
    sim.register("A");
    sim.start(1);
    sim.finish(1);
    sim.deliver();
    sim.leave(1);
    expect(sim.slot(2).state).toBe("empty");
    expect(sim.outboxFor(2).map((e) => e.payload)).toEqual([
      { event: "player_left", id: anyId, username: "A" },
    ]);
    sim.leftOk(2);
    expect(sim.outboxFor(2)).toEqual([]);
  });

  test("after finish, player_incoming acked: player_left to the next Pi", () => {
    const sim = new Sim();
    toRoom(sim, "A", 2);
    sim.leave(1);
    expect(sim.outboxFor(2).map((e) => e.payload)).toEqual([
      { event: "player_left", id: anyId, username: "A" },
    ]);
  });

  test("late player_incoming_ok after a quit does not ack the next run", () => {
    const sim = new Sim();
    sim.register("A");
    sim.start(1);
    sim.finish(1);
    sim.deliver(2); // Pi 2 got player_incoming(A), its ok is late
    sim.leave(1);
    expect(sim.state.pis[1]?.staleIncomingOks).toBe(1);
    sim.register("B");
    sim.start(1);
    sim.finish(1);
    sim.incomingOk(2); // late ok for A
    expect(sim.outboxFor(2).map((e) => e.payload)).toEqual([
      { event: "player_left", id: anyId, username: "A" },
      { event: "player_incoming", id: anyId, username: "B", player_data: {} },
    ]);
    sim.leftOk(2);
    sim.incomingOk(2);
    expect(sim.outboxFor(2)).toEqual([]);
    expect(sim.state.pis[1]?.staleIncomingOks).toBe(0);
  });

  test("Pi N+1 sends player_leave for its incoming player: no player_left to itself", () => {
    const sim = new Sim();
    sim.register("A");
    sim.start(1);
    sim.finish(1);
    sim.deliver();
    expect(replies(sim.leave(2))).toEqual([{ event: "player_leave_ok" }]);
    expect(sim.state.outbox).toEqual([]);
    expect(sim.slot(2).state).toBe("empty");
    expect(sim.db.runs.get("run-1")?.status).toBe("left");
  });

  test("quit in room 2 lets a waiting run in room 1 move in", () => {
    const sim = new Sim();
    toRoom(sim, "A", 2);
    sim.register("B");
    sim.start(1);
    sim.finish(1);
    expect(sim.slot(1).state).toBe("waiting");
    sim.leave(2); // A (incoming in 2) quits from Pi 2
    expect(sim.username(2)).toBe("B");
    expect(sim.outboxFor(1).map((e) => e.event)).toEqual(["game_finish_ok"]);
  });

  test("repeated player_leave: ok and nothing more", () => {
    const sim = new Sim();
    toRoom(sim, "P", 2); // P is incoming in 2, lastLeft of room 1
    sim.register("A");
    sim.leave(1);
    const slotsBefore = JSON.stringify(sim.state.slots);
    const outboxBefore = JSON.stringify(sim.state.outbox);
    // A second leave must not kick P (lastLeft of room 1 is now A).
    expect(replies(sim.leave(1))).toEqual([{ event: "player_leave_ok" }]);
    expect(sim.username(2)).toBe("P");
    expect(JSON.stringify(sim.state.slots)).toBe(slotsBefore);
    expect(JSON.stringify(sim.state.outbox)).toBe(outboxBefore);
    // Leave in an empty system.
    const sim2 = new Sim();
    expect(replies(sim2.leave(4))).toEqual([{ event: "player_leave_ok" }]);
  });

  test("player_leave from Pi N when the run already started in room N+1: no change", () => {
    const sim = new Sim();
    toRoom(sim, "A", 2);
    sim.start(2);
    expect(replies(sim.leave(1))).toEqual([{ event: "player_leave_ok" }]);
    expect(sim.slot(2).state).toBe("playing");
    expect(sim.state.runs["run-1"]).toBeDefined();
  });
});

describe("delivery: seq, ack and dedupe", () => {
  test("ack is the last send, after the reply", () => {
    const sim = new Sim();
    const fx = sim.register("A");
    expect(fx.at(-1)).toEqual({ type: "send", pi: 1, msg: { event: "ack", seq: 1 } });
  });

  test("repeated seq is ignored but acked with the highest seq", () => {
    const sim = new Sim();
    sim.register("A"); // seq 1
    sim.start(1); // seq 2
    const before = JSON.stringify(sim.state);
    const fx = sim.ev(1, { event: "game_start", timestamp: sim.ts() }, 1);
    expect(sends(fx)).toEqual([{ event: "ack", seq: 2 }]);
    expect(JSON.stringify(sim.state)).toBe(before);
    expect(fx.filter((e) => e.type !== "send" && e.type !== "log")).toEqual([]);
  });

  test("a resent game_finish is not processed two times", () => {
    const sim = new Sim();
    toRoom(sim, "A", 2);
    sim.start(2);
    sim.register("B"); // seq n
    sim.start(1);
    sim.finish(1); // waits
    const seq = sim.seq[0] as number;
    sim.finish(2); // B moves to room 2
    const fx = sim.ev(1, { event: "game_finish", timestamp: sim.ts() }, seq);
    expect(sends(fx)).toEqual([{ event: "ack", seq }]);
    expect(sim.slot(1).state).toBe("empty");
  });

  test("a repeated share does not overwrite a newer value", () => {
    const sim = new Sim();
    sim.register("A");
    sim.share(1, "k", "old");
    const oldSeq = sim.seq[0] as number;
    sim.share(1, "k", "new");
    sim.ev(1, { event: "share", key: "k", value: "old", pi: null }, oldSeq);
    expect(sim.state.runs["run-1"]?.shares[0]?.value).toBe("new");
  });

  test("seq is per Pi", () => {
    const sim = new Sim();
    sim.register("A");
    const fx = sim.ev(2, { event: "game_start" }, 1);
    expect(replies(fx)[0]).toMatchObject({ code: "no_player" });
    expect(sim.state.pis.map((p) => p.lastSeq)).toEqual([1, 1, 0, 0, 0]);
    expect(sim.db.pis.get(2)?.lastSeq).toBe(1);
  });

  test("a duplicate player_incoming_ok does not remove the next message", () => {
    const sim = new Sim();
    sim.register("A");
    sim.start(1);
    sim.finish(1);
    sim.deliver(2);
    sim.incomingOk(2);
    const seq = sim.seq[1] as number;
    sim.ev(2, { event: "player_incoming_ok" }, seq);
    sim.ev(2, { event: "player_incoming_ok" }, seq);
    expect(sim.state.outbox.length).toBe(1); // game_finish_ok for Pi 1
  });

  test("no seq (old client): processed every time, no ack", () => {
    const sim = new Sim();
    const fx = sim.ev(1, { event: "register", username: "A" }, false);
    expect(sends(fx)).toEqual([{ event: "player_register_ok" }]);
    expect(sim.state.pis[0]?.lastSeq).toBe(0);
  });

  test("errors with a seq advance the seq and are acked", () => {
    const sim = new Sim();
    const fx = sim.ev(3, { event: "dance" });
    expect(sends(fx)).toEqual([
      {
        event: "error",
        code: "unknown_event",
        message: "unknown event 'dance'",
        event_name: "dance",
      },
      { event: "ack", seq: 1 },
    ]);
    expect(sends(sim.ev(3, { event: "dance" }, 1))).toEqual([{ event: "ack", seq: 1 }]);
  });

  test("bad JSON: error bad_json, no ack, no change", () => {
    const sim = new Sim();
    const before = JSON.stringify(sim.state);
    const fx = sim.apply({ type: "message", pi: 2, text: "{oops" });
    expect(sends(fx)).toEqual([
      { event: "error", code: "bad_json", message: "message is not valid JSON", event_name: "" },
    ]);
    expect(JSON.stringify(sim.state)).toBe(before);
  });

  test("decoded input (type event) works like text", () => {
    const sim = new Sim();
    const fx = sim.apply({
      type: "event",
      pi: 1,
      data: { event: "register", username: "A", seq: 1 },
    });
    expect(sends(fx)).toEqual([{ event: "player_register_ok" }, { event: "ack", seq: 1 }]);
  });

  test("auth is not handled by step", () => {
    const sim = new Sim();
    const fx = sim.apply({ type: "message", pi: 1, text: '{"event":"auth","pi":1}' });
    expect(sends(fx)).toEqual([]);
    expect(logs(fx, "warn")).toHaveLength(1);
  });

  test("reset_seq lets a restarted client start at seq 1", () => {
    const sim = new Sim();
    sim.register("A");
    sim.leave(1);
    sim.apply({ type: "reset_seq", pi: 1 });
    expect(sim.db.pis.get(1)?.lastSeq).toBe(0);
    const fx = sim.ev(1, { event: "register", username: "B" }, 1);
    expect(replies(fx)).toEqual([{ event: "player_register_ok" }]);
  });
});

describe("ok with id (outbox message id)", () => {
  /** A in room 1 finished: player_incoming(A) for Pi 2 is open. Returns its id. */
  function incomingA(sim: Sim): number {
    sim.register("A");
    sim.start(1);
    sim.finish(1);
    sim.deliver(1);
    const e = sim.outboxFor(2)[0];
    if (e?.payload.event !== "player_incoming") throw new Error("no player_incoming");
    expect(e.payload.id).toBe(e.id);
    return e.id;
  }

  test("player_incoming and player_left carry the outbox id", () => {
    const sim = new Sim();
    const id = incomingA(sim);
    expect(sim.deliver(2)).toEqual([
      { event: "player_incoming", id, username: "A", player_data: {} },
    ]);
    sim.leave(1);
    const left = sim.outboxFor(2)[0];
    expect(left?.payload).toEqual({ event: "player_left", id: left?.id ?? 0, username: "A" });
  });

  // Regression: the Pi got two copies of player_incoming(A) (resend after reconnect)
  // and acks each copy. The second ok comes after player_incoming(B) is open. With
  // the old rule (remove the oldest open player_incoming), it removed B's message.
  test("a late duplicate ok does not remove a newer player_incoming", () => {
    const sim = new Sim();
    const idA = incomingA(sim);
    sim.deliver(2);
    sim.deliver(2); // second copy
    sim.incomingOk(2, idA);
    expect(sim.outboxFor(2)).toEqual([]);
    sim.start(2);
    sim.finish(2);
    sim.deliver();
    sim.accept(3);
    sim.register("B");
    sim.start(1);
    sim.finish(1);
    const b = sim.outboxFor(2);
    expect(b.map((e) => e.payload)).toEqual([
      { event: "player_incoming", id: b[0]?.id ?? 0, username: "B", player_data: {} },
    ]);
    const fx = sim.incomingOk(2, idA); // late ok for the second copy of A
    expect(fx.filter((e) => e.type === "outbox_remove")).toEqual([]);
    expect(sends(fx, 2)).toEqual([{ event: "ack", seq: sim.seq[1] ?? 0 }]);
    expect(sim.outboxFor(2)).toEqual(b);
    sim.incomingOk(2, b[0]?.id ?? 0);
    expect(sim.outboxFor(2)).toEqual([]);
  });

  test("a late duplicate player_left_ok does not remove a newer player_left", () => {
    const sim = new Sim();
    incomingA(sim);
    sim.deliver(2);
    sim.leave(1); // player_left(A) to Pi 2
    const idA = sim.outboxFor(2)[0]?.id as number;
    sim.deliver(2);
    sim.deliver(2);
    sim.leftOk(2, idA);
    sim.register("B");
    sim.start(1);
    sim.finish(1);
    sim.deliver();
    sim.leave(1); // player_left(B) to Pi 2
    const b = sim.outboxFor(2);
    expect(b.map((e) => e.payload)).toEqual([
      { event: "player_left", id: b[0]?.id ?? 0, username: "B" },
    ]);
    sim.leftOk(2, idA); // late ok for the second copy of A
    expect(sim.outboxFor(2)).toEqual(b);
    sim.leftOk(2, b[0]?.id ?? 0);
    expect(sim.outboxFor(2)).toEqual([]);
  });

  test("an id of another Pi or of the other event has no effect", () => {
    const sim = new Sim();
    const id = incomingA(sim);
    sim.deliver(2);
    expect(sim.incomingOk(3, id).filter((e) => e.type === "outbox_remove")).toEqual([]);
    expect(sim.leftOk(2, id).filter((e) => e.type === "outbox_remove")).toEqual([]);
    expect(sim.incomingOk(2, 999).filter((e) => e.type === "outbox_remove")).toEqual([]);
    expect(sim.outboxFor(2).map((e) => e.id)).toEqual([id]);
    sim.incomingOk(2, id);
    expect(sim.outboxFor(2)).toEqual([]);
    expect(sim.slot(2).notified).toBe(true);
  });

  test("an ok with id ignores the stale count of old clients and sets it to 0", () => {
    const sim = new Sim();
    const idA = incomingA(sim);
    sim.deliver(2);
    sim.leave(1); // A quits: the sent player_incoming(A) is deleted
    expect(sim.state.pis[1]?.staleIncomingOks).toBe(1);
    sim.incomingOk(2, idA); // the late ok: unknown id, no effect
    expect(sim.state.pis[1]?.staleIncomingOks).toBe(0);
    sim.register("B");
    sim.start(1);
    sim.finish(1);
    const idB = sim.outboxFor(2).find((e) => e.event === "player_incoming")?.id as number;
    sim.incomingOk(2, idB);
    expect(sim.outboxFor(2).map((e) => e.event)).toEqual(["player_left"]);
  });

  test("an ok with a bad id is a bad_request, and the seq is acked", () => {
    const sim = new Sim();
    incomingA(sim);
    const fx = sim.ev(2, { event: "player_incoming_ok", id: "x" });
    expect(sends(fx)).toEqual([
      {
        event: "error",
        code: "bad_request",
        message: "id must be a positive integer",
        event_name: "player_incoming_ok",
      },
      { event: "ack", seq: 1 },
    ]);
    expect(sim.outboxFor(2).length).toBe(1);
  });
});

describe("outbox_sent", () => {
  test("unknown ids are ignored; marking twice gives one db effect", () => {
    const sim = new Sim();
    sim.register("A");
    sim.start(1);
    sim.finish(1);
    const id = sim.outboxFor(2)[0]?.id as number;
    const fx1 = sim.apply({ type: "outbox_sent", ids: [id, 999] });
    expect(fx1.filter((e) => e.type === "outbox_mark_sent")).toEqual([
      { type: "outbox_mark_sent", id },
    ]);
    const fx2 = sim.apply({ type: "outbox_sent", ids: [id] });
    expect(fx2.filter((e) => e.type === "outbox_mark_sent")).toEqual([]);
  });
});

describe("state", () => {
  test("JSON round trip gives the same state and the same behaviour", () => {
    const sim = new Sim();
    toRoom(sim, "A", 3);
    sim.share(3, "k", { x: [1, null] }, 5);
    const copy = JSON.parse(JSON.stringify(sim.state));
    expect(copy).toEqual(sim.state);
    const a = step(
      sim.state,
      { type: "message", pi: 3, text: '{"event":"game_start","seq":99}' },
      sim.now,
    );
    const b = step(
      copy,
      { type: "message", pi: 3, text: '{"event":"game_start","seq":99}' },
      sim.now,
    );
    expect(b).toEqual(a);
  });

  test("step does not change its input (frozen state)", () => {
    const s = emptyState();
    const freeze = (o: unknown): void => {
      if (o && typeof o === "object") {
        Object.freeze(o);
        for (const v of Object.values(o)) freeze(v);
      }
    };
    freeze(s);
    const r = step(
      s,
      { type: "message", pi: 1, text: '{"event":"register","username":"A"}' },
      BASE,
      {
        newId: () => "id-1",
      },
    );
    expect(r.state.slots[0]?.playerId).toBe("id-1");
    expect(s.slots[0]?.playerId).toBeNull();
  });

  test("roomOfRun", () => {
    const sim = new Sim();
    toRoom(sim, "A", 4);
    expect(roomOfRun(sim.state, "run-1")).toBe(4);
    expect(roomOfRun(sim.state, "nope")).toBeNull();
  });

  test("mirror db agrees with the state", () => {
    const sim = new Sim();
    fullRun(sim, "A", [1, 2, 3, 4, 5]);
    toRoom(sim, "B", 3);
    sim.leave(3);
    toRoom(sim, "C", 2);
    expect([...sim.db.slots.values()]).toEqual(sim.state.slots);
    expect([...sim.db.outbox.values()]).toEqual(sim.state.outbox);
  });
});
