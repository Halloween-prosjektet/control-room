import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEffects,
  createQueries,
  getSession,
  loadState,
  openDb,
  SCHEMA_VERSION,
  schemaVersion,
  setSession,
} from "../src/db.ts";
import { emptyState } from "../src/game.ts";
import type { PiId } from "../src/protocol.ts";
import { rng, Sim } from "./harness.ts";

const dirs: string[] = [];
function tempDb(): { path: string; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), "cr-db-"));
  dirs.push(dir);
  const path = join(dir, "sub", "test.sqlite");
  return { path, db: openDb(path) };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A Sim that writes each step to a real database. */
class DbSim extends Sim {
  constructor(readonly sqlite: Database) {
    super();
  }
  override apply(input: Parameters<Sim["apply"]>[0]) {
    const effects = super.apply(input);
    applyEffects(this.sqlite, effects);
    return effects;
  }
}

/** Plays one run through all five rooms. */
function fullRun(sim: Sim, name: string, roomMs: number[]): void {
  sim.register(name);
  for (let room = 1 as PiId; room <= 5; room = (room + 1) as PiId) {
    if (room > 1) sim.accept(room);
    sim.start(room);
    sim.advance(roomMs[room - 1] ?? 1000);
    sim.finish(room);
    sim.deliver(room);
  }
}

describe("schema", () => {
  test("new database: version, empty state", () => {
    const { db } = tempDb();
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(loadState(db)).toEqual(emptyState());
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  });

  test("open again: migrations do not run again, data stays", () => {
    const { path, db } = tempDb();
    const sim = new DbSim(db);
    sim.register("Ola");
    db.close();
    const db2 = openDb(path);
    expect(schemaVersion(db2)).toBe(SCHEMA_VERSION);
    expect(loadState(db2)).toEqual(sim.state);
    db2.close();
  });

  test("a newer schema version is refused", () => {
    const { path, db } = tempDb();
    db.run("UPDATE schema_version SET version = 99");
    db.close();
    expect(() => openDb(path)).toThrow(/newer/);
  });

  test("session is stored and pi_upsert does not change it", () => {
    const { db } = tempDb();
    expect(getSession(db, 2)).toBeNull();
    setSession(db, 2, "abc");
    applyEffects(db, [{ type: "pi_upsert", pi: 2, delivery: { lastSeq: 7, staleIncomingOks: 1 } }]);
    expect(getSession(db, 2)).toBe("abc");
    expect(loadState(db).pis[1]).toEqual({ lastSeq: 7, staleIncomingOks: 1 });
  });

  test("applyEffects is one transaction: an error writes nothing", () => {
    const { db } = tempDb();
    expect(() =>
      applyEffects(db, [
        { type: "pi_upsert", pi: 1, delivery: { lastSeq: 5, staleIncomingOks: 0 } },
        // A room time for an unknown run breaks the foreign key.
        {
          type: "room_time_upsert",
          playerId: "nope",
          room: 1,
          time: { startedAt: 1, finishedAt: null, durationMs: null },
        },
      ]),
    ).toThrow();
    expect(loadState(db).pis[0]?.lastSeq).toBe(0);
  });
});

describe("outbox rows of an older version", () => {
  test("a player_incoming payload without id gets the row id on load", () => {
    const { db } = tempDb();
    const sim = new DbSim(db);
    sim.register("A");
    sim.start(1);
    sim.finish(1);
    const entry = sim.state.outbox.find((e) => e.event === "player_incoming");
    if (!entry) throw new Error("no player_incoming");
    db.run("UPDATE outbox SET payload = ? WHERE id = ?", [
      JSON.stringify({ event: "player_incoming", username: "A", player_data: {} }),
      entry.id,
    ]);
    expect(loadState(db).outbox.find((e) => e.id === entry.id)?.payload).toEqual({
      event: "player_incoming",
      id: entry.id,
      username: "A",
      player_data: {},
    });
    expect(loadState(db)).toEqual(sim.state);
  });
});

describe("restart gives the same state", () => {
  test("pipeline with shares, wait, quit and outbox", () => {
    const { path, db } = tempDb();
    const sim = new DbSim(db);
    sim.register("A");
    sim.share(1, "colour", { r: 1 }, [3, 5]);
    sim.share(1, "all", [1, 2], null);
    sim.start(1);
    sim.advance(5000);
    sim.finish(1); // A -> room 2 (incoming, not delivered)
    sim.register("B");
    sim.start(1);
    sim.share(1, "colour", "blue", 3); // B's share
    sim.share(1, "colour", "red", 3); // last value wins, same position
    sim.advance(4000);
    sim.finish(1); // B waits in room 1
    sim.deliver(1);
    expect(sim.slot(1).state).toBe("waiting");
    db.close();
    const db2 = openDb(path);
    expect(loadState(db2)).toEqual(sim.state);
    db2.close();
  });

  test.each([1, 2, 3, 4, 5, 6])(
    "random steps, seed %d: loadState equals state after each step",
    (seed) => {
      const { db } = tempDb();
      const sim = new DbSim(db);
      const r = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
      const pis: PiId[] = [1, 2, 3, 4, 5];
      for (let i = 0; i < 600; i++) {
        const pi = pick(pis);
        const x = r();
        sim.advance(Math.floor(r() * 5000));
        if (x < 0.12) sim.register(pick(["Ola", "Kari", "Per"]));
        else if (x < 0.3) sim.start(pi);
        else if (x < 0.5) sim.finish(pi);
        else if (x < 0.55) sim.leave(pi);
        else if (x < 0.65) sim.share(pi, pick(["a", "b"]), r(), pick([null, 3, [2, 5]]));
        else if (x < 0.8) sim.deliver(pi);
        else if (x < 0.9) sim.incomingOk(pi);
        else if (x < 0.95) sim.leftOk(pi);
        else if (x < 0.97) sim.apply({ type: "reset_seq", pi });
        else sim.ev(pi, { event: "game_start" }, 1); // repeated seq
        expect(loadState(db)).toEqual(sim.state);
      }
    },
  );

  test("room statistics are rebuilt from completed runs", () => {
    const { db } = tempDb();
    const sim = new DbSim(db);
    fullRun(sim, "A", [1000, 2000, 3000, 4000, 5000]);
    fullRun(sim, "B", [3000, 2000, 1000, 2000, 1000]);
    expect(sim.state.roomStats[0]).toEqual({ count: 2, sumMs: 4000 });
    expect(loadState(db)).toEqual(sim.state);
  });
});

describe("queries", () => {
  test("leaderboard: order, competition rank, format", () => {
    const { db } = tempDb();
    const sim = new DbSim(db);
    fullRun(sim, "Slow", [5000, 5000, 5000, 5000, 5000]); // 25000
    fullRun(sim, "Fast", [1000, 1000, 1000, 1000, 1000]); // 5000
    fullRun(sim, "TieLate", [1000, 1000, 1000, 1000, 6000]); // 10000, completed first
    fullRun(sim, "TieEarly", [2000, 2000, 2000, 2000, 2000]); // 10000, completed after TieLate
    sim.register("Active"); // not on the leaderboard
    const q = createQueries(db, "Europe/Oslo", { connectedPis: () => [3, 1] });
    const rows = q.leaderboard(50, 0);
    expect(rows.map((r) => [r.rank, r.username])).toEqual([
      [1, "Fast"],
      [2, "TieLate"],
      [2, "TieEarly"],
      [4, "Slow"],
    ]);
    const fast = rows[0];
    expect(fast?.room_times_ms).toEqual({
      room_1: 1000,
      room_2: 1000,
      room_3: 1000,
      room_4: 1000,
      room_5: 1000,
    });
    expect(fast?.total_time_ms).toBe(5000);
    // BASE is 2026-10-31T18:00Z; Oslo is +01:00 on that day.
    expect(fast?.completed_at).toMatch(/^2026-10-31T\d{2}:\d{2}:\d{2}\.\d{3}\+01:00$/);
    expect(q.leaderboard(2, 1).map((r) => [r.rank, r.username])).toEqual([
      [2, "TieLate"],
      [2, "TieEarly"],
    ]);
    expect(q.leaderboardOne(rows[2]?.player_id ?? "")).toEqual(rows[2] ?? null);
    expect(q.leaderboardOne(rows[3]?.player_id ?? "")?.rank).toBe(4);
    expect(q.leaderboardOne(sim.slot(1).playerId ?? "")).toBeNull();
    expect(q.leaderboardOne("unknown")).toBeNull();
  });

  test("state snapshot", () => {
    const { db } = tempDb();
    const sim = new DbSim(db);
    sim.register("Ola");
    sim.start(1);
    sim.finish(1);
    const q = createQueries(db, "Europe/Oslo", { connectedPis: () => [3, 1] });
    const s = q.state() as {
      rooms: { room: number; state: string; username: string | null }[];
      connected_pis: number[];
      outbox_size: number;
    };
    expect(s.rooms.map((r) => [r.room, r.state, r.username])).toEqual([
      [1, "empty", null],
      [2, "incoming", "Ola"],
      [3, "empty", null],
      [4, "empty", null],
      [5, "empty", null],
    ]);
    expect(s.connected_pis).toEqual([1, 3]);
    expect(s.outbox_size).toBe(2); // game_finish_ok to Pi 1, player_incoming to Pi 2
  });
});
