// Regression tests for the design findings F2 to F8 in verification/server/README.md.
// Each test follows the counterexample trace of the finding (shortened).

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEffects, loadState, openDb } from "../src/db.ts";
import type { PiId } from "../src/protocol.ts";
import { logs, replies, Sim, sends } from "./harness.ts";

const anyId = expect.any(Number) as unknown as number;

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

/**
 * F2 trace: A plays room 2. B plays room 1, finishes and waits. A finishes room 2:
 * A goes to room 3 (incoming) and the chain moves B to room 2 (incoming).
 */
function f2Setup(sim: Sim): void {
  toRoom(sim, "A", 2);
  sim.start(2);
  sim.register("B");
  sim.start(1);
  sim.finish(1);
  expect(sim.slot(1).state).toBe("waiting");
  sim.finish(2);
  expect(sim.username(2)).toBe("B");
  expect(sim.username(3)).toBe("A");
  expect(sim.slot(3).state).toBe("incoming");
}

describe("F2: Pi events carry the username of the player", () => {
  test("player_leave with username removes that run, not the next player in the room", () => {
    const sim = new Sim();
    f2Setup(sim);
    const fx = sim.ev(2, { event: "player_leave", username: "A" });
    expect(replies(fx, 2)).toEqual([{ event: "player_leave_ok" }]);
    expect(sim.db.runs.get("run-1")?.status).toBe("left");
    expect(sim.db.runs.get("run-2")?.status).toBe("active");
    expect(sim.username(2)).toBe("B");
    expect(sim.slot(3).state).toBe("empty");
  });

  test("player_leave without username keeps the old rule (the run in room N)", () => {
    const sim = new Sim();
    f2Setup(sim);
    sim.leave(2);
    expect(sim.db.runs.get("run-2")?.status).toBe("left");
    expect(sim.username(3)).toBe("A");
  });

  test("player_leave with a username of no candidate: wrong_player, acked, no change", () => {
    const sim = new Sim();
    f2Setup(sim);
    const before = JSON.stringify(sim.state.slots);
    const fx = sim.ev(2, { event: "player_leave", username: "Zed" });
    expect(sends(fx, 2)).toEqual([
      expect.objectContaining({ event: "error", code: "wrong_player", event_name: "player_leave" }),
      { event: "ack", seq: sim.seq[1] as number },
    ]);
    expect(JSON.stringify(sim.state.slots)).toBe(before);
    expect(Object.keys(sim.state.runs).sort()).toEqual(["run-1", "run-2"]);
  });

  test("player_leave with a username when Pi N has no candidate: ok (repeated message)", () => {
    const sim = new Sim();
    expect(replies(sim.ev(4, { event: "player_leave", username: "A" }))).toEqual([
      { event: "player_leave_ok" },
    ]);
  });

  test("game_start with the username of another player: wrong_player, no start", () => {
    const sim = new Sim();
    f2Setup(sim);
    const fx = sim.ev(2, { event: "game_start", username: "A", timestamp: sim.ts() });
    expect(replies(fx, 2)).toEqual([
      expect.objectContaining({ event: "error", code: "wrong_player", event_name: "game_start" }),
    ]);
    expect(sim.slot(2).state).toBe("incoming");
    expect(replies(sim.ev(2, { event: "game_start", username: "B", timestamp: sim.ts() }))).toEqual(
      [{ event: "game_start_ok" }],
    );
    expect(sim.slot(2).state).toBe("playing");
  });

  test("game_finish with the username of another player: wrong_player, no finish", () => {
    const sim = new Sim();
    toRoom(sim, "A", 1);
    sim.start(1);
    const fx = sim.ev(1, { event: "game_finish", username: "B", timestamp: sim.ts() });
    expect(replies(fx)[0]).toMatchObject({ code: "wrong_player", event_name: "game_finish" });
    expect(sim.slot(1).state).toBe("playing");
    sim.ev(1, { event: "game_finish", username: "A", timestamp: sim.ts() });
    expect(sim.slot(2).state).toBe("incoming");
  });

  test("the username is trimmed like in player_register", () => {
    const sim = new Sim();
    sim.register("  Ola ");
    expect(
      replies(sim.ev(1, { event: "game_start", username: " Ola", timestamp: sim.ts() })),
    ).toEqual([{ event: "game_start_ok" }]);
  });

  test("a username that is not a string is a bad_request", () => {
    const sim = new Sim();
    sim.register("A");
    for (const username of [5, "", "   ", "x".repeat(65)]) {
      const fx = sim.ev(1, { event: "game_start", username });
      expect(replies(fx)[0]).toMatchObject({ code: "bad_request", event_name: "game_start" });
    }
    expect(sim.slot(1).state).toBe("incoming");
    // null is the same as no username.
    expect(replies(sim.ev(1, { event: "game_start", username: null }))).toEqual([
      { event: "game_start_ok" },
    ]);
  });

  test("share with username after finish goes to that run, not to the next player in room N", () => {
    const sim = new Sim();
    f2Setup(sim); // A incoming in room 3, B incoming in room 2
    const fx = sim.ev(2, { event: "share", key: "late", value: 1, pi: 4, username: "A" });
    expect(replies(fx)).toEqual([{ event: "share_ok" }]);
    expect(sim.state.runs["run-1"]?.shares.map((s) => s.key)).toEqual(["late"]);
    expect(sim.state.runs["run-2"]?.shares).toEqual([]);
    // A username of no candidate: wrong_player.
    const bad = sim.ev(2, { event: "share", key: "x", value: 1, username: "Zed" });
    expect(replies(bad)[0]).toMatchObject({ code: "wrong_player", event_name: "share" });
  });
});

describe("F3: game_start deletes the open player_incoming of that run", () => {
  test("old client (ok without id, ok lost): no player_incoming stays after the start", () => {
    const sim = new Sim();
    sim.register("A");
    sim.start(1);
    sim.finish(1);
    sim.deliver(2); // Pi 2 got it; the ok is lost
    expect(sim.outboxFor(2).map((e) => e.event)).toEqual(["player_incoming"]);
    sim.start(2);
    expect(sim.outboxFor(2)).toEqual([]);
    expect([...sim.db.outbox.values()].filter((e) => e.pi === 2)).toEqual([]);
    // A late ok without id (from a second copy) must not ack the next run.
    expect(sim.state.pis[1]?.staleIncomingOks).toBe(1);
  });

  test("not sent yet (Pi started with a copy from an earlier connection): deleted, no stale count", () => {
    const sim = new Sim();
    sim.register("A");
    sim.start(1);
    sim.finish(1);
    sim.start(2);
    expect(sim.outboxFor(2)).toEqual([]);
    expect(sim.state.pis[1]?.staleIncomingOks).toBe(0);
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A Sim that writes each step to a real database. */
class DbSim extends Sim {
  readonly sqlite: Database;
  constructor() {
    super();
    const dir = mkdtempSync(join(tmpdir(), "cr-findings-"));
    dirs.push(dir);
    this.sqlite = openDb(join(dir, "test.sqlite"));
  }
  override apply(input: Parameters<Sim["apply"]>[0]) {
    const effects = super.apply(input);
    applyEffects(this.sqlite, effects);
    return effects;
  }
  /** A server restart: the state comes from the database only. */
  restart(): void {
    this.state = loadState(this.sqlite);
  }
}

describe("F3/F4 across a server restart", () => {
  test("F3: after a restart the outbox has no player_incoming for a run that started or left", () => {
    const sim = new DbSim();
    sim.register("A");
    sim.start(1);
    sim.finish(1);
    sim.deliver(2);
    sim.start(2); // ok lost, then the start
    sim.restart();
    expect(sim.state.outbox.filter((e) => e.event === "player_incoming")).toEqual([]);
    sim.finish(2);
    sim.deliver(3);
    sim.leave(2); // A quits after room 2, player_incoming(A) to Pi 3 was sent
    sim.restart();
    expect(
      sim.state.outbox.filter((e) => e.event !== "game_finish_ok").map((e) => [e.pi, e.event]),
    ).toEqual([[3, "player_left"]]);
  });

  test("F4: the 'sent' mark survives a restart, so a quit still sends player_left", () => {
    const sim = new DbSim();
    sim.register("A");
    sim.start(1);
    sim.finish(1);
    sim.deliver(); // Pi 2 got player_incoming(A); no ok yet
    sim.restart();
    expect(sim.slot(2).notified).toBe(true);
    expect(sim.outboxFor(2)[0]?.sent).toBe(true);
    sim.leave(1); // A quits at Pi 1 after the restart
    expect(sim.outboxFor(2).map((e) => e.payload)).toEqual([
      { event: "player_left", id: anyId, username: "A" },
    ]);
  });
});

describe("F5: a share after game_finish reaches the next Pi", () => {
  test("player_data of the open player_incoming is rebuilt with the late share", () => {
    const sim = new Sim();
    sim.register("A");
    sim.share(1, "early", 1, 2);
    sim.start(1);
    sim.finish(1);
    expect(sim.outboxFor(2)[0]?.payload).toMatchObject({ player_data: { early: 1 } });
    const fx = sim.share(1, "late", { score: 7 }, [2, 4]);
    expect(replies(fx)).toEqual([{ event: "share_ok" }]);
    const want = {
      event: "player_incoming" as const,
      id: anyId,
      username: "A",
      player_data: { early: 1, late: { score: 7 } },
    };
    expect(sim.outboxFor(2)[0]?.payload).toEqual(want);
    // The database has the same payload (the resend after a restart uses it).
    expect([...sim.db.outbox.values()].find((e) => e.pi === 2)?.payload).toEqual(want);
    expect(sim.deliver(2)).toEqual([want]);
  });

  test("also when the message was sent before (a resend carries the new data)", () => {
    const sim = new Sim();
    sim.register("A");
    sim.start(1);
    sim.finish(1);
    sim.deliver(2);
    sim.share(1, "late", true);
    expect(sim.deliver(2)).toEqual([
      { event: "player_incoming", id: anyId, username: "A", player_data: { late: true } },
    ]);
  });

  test("a share for a later room only does not change this player_incoming", () => {
    const sim = new Sim();
    sim.register("A");
    sim.start(1);
    sim.finish(1);
    const fx = sim.share(1, "for4", 1, 4);
    expect(fx.filter((e) => e.type === "outbox_update")).toEqual([]);
    expect(sim.outboxFor(2)[0]?.payload).toMatchObject({ player_data: {} });
  });

  test("a share for a room that the run passed: saved and logged only", () => {
    const sim = new Sim();
    sim.register("A");
    sim.start(1);
    sim.finish(1);
    const fx = sim.share(1, "back", 1, 1);
    expect(replies(fx)).toEqual([{ event: "share_ok" }]);
    expect(logs(fx, "warn").join()).toContain("already passed");
    expect(sim.outboxFor(2)[0]?.payload).toMatchObject({ player_data: {} });
  });
});

describe("F8: game_finish_ok stays in the outbox until the Pi acks it", () => {
  /** A finished room 1. Returns the game_finish_ok entry for Pi 1. */
  function finishA(sim: Sim) {
    sim.register("A");
    sim.start(1);
    sim.finish(1);
    const e = sim.outboxFor(1)[0];
    if (e?.event !== "game_finish_ok") throw new Error("no game_finish_ok");
    return e;
  }

  test("game_finish_ok has the outbox id and the username", () => {
    const sim = new Sim();
    const e = finishA(sim);
    expect(e.payload).toEqual({ event: "game_finish_ok", id: e.id, username: "A" });
    expect(e.needsAck).toBe(true);
  });

  test("a client that acks game_finish_ok: kept after the send, removed by game_finish_ack", () => {
    const sim = new Sim();
    const e = finishA(sim);
    sim.apply({ type: "outbox_sent", ids: [e.id], finishAckPis: [1] });
    sim.apply({ type: "outbox_sent", ids: [e.id], finishAckPis: [1] });
    expect(sim.outboxFor(1)).toMatchObject([{ id: e.id, sent: true }]);
    // An ack with another id, or from another Pi, has no effect.
    sim.ev(1, { event: "game_finish_ack", id: e.id + 100 });
    sim.ev(2, { event: "game_finish_ack", id: e.id });
    sim.ev(1, { event: "player_incoming_ok", id: e.id });
    expect(sim.outboxFor(1).map((x) => x.id)).toEqual([e.id]);
    const fx = sim.ev(1, { event: "game_finish_ack", id: e.id });
    expect(sends(fx, 1)).toEqual([{ event: "ack", seq: sim.seq[0] as number }]);
    expect(sim.outboxFor(1)).toEqual([]);
    expect([...sim.db.outbox.values()].filter((x) => x.pi === 1)).toEqual([]);
  });

  test("an old client (no game_finish_ack): removed after one send, as before", () => {
    const sim = new Sim();
    const e = finishA(sim);
    sim.apply({ type: "outbox_sent", ids: [e.id], finishAckPis: [2, 3] });
    expect(sim.outboxFor(1)).toEqual([]);
  });

  test("game_finish_ack needs a valid id", () => {
    const sim = new Sim();
    finishA(sim);
    for (const data of [{ event: "game_finish_ack" }, { event: "game_finish_ack", id: "x" }]) {
      expect(replies(sim.ev(1, data))[0]).toMatchObject({
        code: "bad_request",
        event_name: "game_finish_ack",
      });
    }
    expect(sim.outboxFor(1)).toHaveLength(1);
  });

  test("completion in room 5 also sends game_finish_ok with id and username", () => {
    const sim = new Sim();
    toRoom(sim, "A", 5);
    sim.start(5);
    sim.finish(5);
    const e = sim.outboxFor(5)[0];
    expect(e?.payload).toEqual({ event: "game_finish_ok", id: e?.id, username: "A" });
  });
});
