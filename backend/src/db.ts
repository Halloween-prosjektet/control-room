// SQLite storage (plan section 9). bun:sqlite in WAL mode.
//
// - openDb() opens the file and runs the migrations from `schema_version`.
// - applyEffects() writes the db effects of one game.step() in ONE transaction
//   ("send" and "log" effects are ignored here).
// - loadState() rebuilds the game State from the tables. loadState() after the
//   effects of each step gives a state equal to the in-memory state.
// - createQueries() gives the read-only queries for http.ts.
//
// Time values are stored as ISO 8601 text in UTC ("2026-10-31T18:56:21.624Z"),
// so that they sort as text and give the same epoch ms back.
//
// Additions to the schema in the plan:
// - outbox: `player_id` (the run of the message) and `sent` (0 or 1).
// - room_slots: `notified` (0 or 1).
// - pi_delivery: delivery data of each Pi (last seq, stale player_incoming_ok count,
//   and the session of the client app).

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Effect,
  emptyState,
  type OutboxEntry,
  type OutboxEvent,
  type PiDelivery,
  type Run,
  type Share,
  type SlotState,
  type State,
} from "./game.ts";
import { type Json, PI_IDS, type PiId, type ServerMessage } from "./protocol.ts";
import type { LeaderboardRow, Queries } from "./queries-interface.ts";
import { formatInZone } from "./time.ts";

// ---------------------------------------------------------------- schema

const MIGRATIONS: readonly string[] = [
  // Version 1
  `
  CREATE TABLE runs (
    player_id     TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('active', 'completed', 'left')),
    created_at    TEXT NOT NULL,
    completed_at  TEXT,
    total_time_ms INTEGER
  );
  CREATE INDEX runs_leaderboard ON runs (status, total_time_ms, completed_at);

  CREATE TABLE room_times (
    player_id   TEXT NOT NULL REFERENCES runs(player_id),
    room        INTEGER NOT NULL CHECK (room BETWEEN 1 AND 5),
    started_at  TEXT,
    finished_at TEXT,
    duration_ms INTEGER,
    PRIMARY KEY (player_id, room)
  );

  CREATE TABLE shares (
    player_id  TEXT NOT NULL REFERENCES runs(player_id),
    key        TEXT NOT NULL,
    value_json TEXT NOT NULL,
    targets    TEXT,
    from_pi    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (player_id, key)
  );

  CREATE TABLE room_slots (
    room      INTEGER PRIMARY KEY CHECK (room BETWEEN 1 AND 5),
    player_id TEXT REFERENCES runs(player_id),
    state     TEXT NOT NULL CHECK (state IN ('empty', 'incoming', 'playing', 'waiting')),
    last_left TEXT,
    notified  INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO room_slots (room, state) VALUES (1, 'empty'), (2, 'empty'), (3, 'empty'),
    (4, 'empty'), (5, 'empty');

  CREATE TABLE outbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pi         INTEGER NOT NULL,
    event      TEXT NOT NULL,
    payload    TEXT NOT NULL,
    needs_ack  INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    player_id  TEXT NOT NULL,
    sent       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE pi_delivery (
    pi                 INTEGER PRIMARY KEY CHECK (pi BETWEEN 1 AND 5),
    last_seq           INTEGER NOT NULL DEFAULT 0,
    stale_incoming_oks INTEGER NOT NULL DEFAULT 0,
    session            TEXT
  );
  INSERT INTO pi_delivery (pi) VALUES (1), (2), (3), (4), (5);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Opens (and makes, if necessary) the database file and runs the migrations. */
export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  db.transaction(() => {
    const row = db.query<{ version: number }, []>("SELECT version FROM schema_version").get();
    let version = row?.version ?? 0;
    if (row === null) db.run("INSERT INTO schema_version (version) VALUES (0)");
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `database schema version ${version} is newer than this server (${SCHEMA_VERSION})`,
      );
    }
    while (version < SCHEMA_VERSION) {
      db.run(MIGRATIONS[version] as string);
      version += 1;
      db.run("UPDATE schema_version SET version = ?", [version]);
    }
  })();
}

export function schemaVersion(db: Database): number {
  return (
    db.query<{ version: number }, []>("SELECT version FROM schema_version").get()?.version ?? 0
  );
}

// ---------------------------------------------------------------- time

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function ms(text: string | null): number | null {
  if (text === null) return null;
  const v = Date.parse(text);
  if (Number.isNaN(v)) throw new Error(`bad time in database: ${text}`);
  return v;
}

function msNotNull(text: string): number {
  return ms(text) as number;
}

// ---------------------------------------------------------------- write

/** Writes the db effects of one step in one transaction. `extra` runs in the same transaction. */
export function applyEffects(db: Database, effects: readonly Effect[], extra?: () => void): void {
  db.transaction(() => {
    for (const e of effects) applyOne(db, e);
    extra?.();
  })();
}

function applyOne(db: Database, e: Effect): void {
  switch (e.type) {
    case "run_upsert":
      db.run(
        `INSERT INTO runs (player_id, username, status, created_at, completed_at, total_time_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (player_id) DO UPDATE SET username = excluded.username,
           status = excluded.status, created_at = excluded.created_at,
           completed_at = excluded.completed_at, total_time_ms = excluded.total_time_ms`,
        [
          e.run.playerId,
          e.run.username,
          e.run.status,
          iso(e.run.createdAt),
          iso(e.run.completedAt),
          e.run.totalTimeMs,
        ],
      );
      break;
    case "room_time_upsert":
      db.run(
        `INSERT INTO room_times (player_id, room, started_at, finished_at, duration_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (player_id, room) DO UPDATE SET started_at = excluded.started_at,
           finished_at = excluded.finished_at, duration_ms = excluded.duration_ms`,
        [e.playerId, e.room, iso(e.time.startedAt), iso(e.time.finishedAt), e.time.durationMs],
      );
      break;
    case "share_upsert":
      db.run(
        `INSERT INTO shares (player_id, key, value_json, targets, from_pi, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (player_id, key) DO UPDATE SET value_json = excluded.value_json,
           targets = excluded.targets, from_pi = excluded.from_pi, created_at = excluded.created_at`,
        [
          e.playerId,
          e.share.key,
          JSON.stringify(e.share.value),
          e.share.targets === null ? null : JSON.stringify(e.share.targets),
          e.share.fromPi,
          iso(e.share.createdAt),
        ],
      );
      break;
    case "slot_upsert":
      db.run(
        `UPDATE room_slots SET player_id = ?, state = ?, last_left = ?, notified = ? WHERE room = ?`,
        [e.slot.playerId, e.slot.state, e.slot.lastLeft, e.slot.notified ? 1 : 0, e.slot.room],
      );
      break;
    case "pi_upsert":
      db.run("UPDATE pi_delivery SET last_seq = ?, stale_incoming_oks = ? WHERE pi = ?", [
        e.delivery.lastSeq,
        e.delivery.staleIncomingOks,
        e.pi,
      ]);
      break;
    case "outbox_add":
      db.run(
        `INSERT INTO outbox (id, pi, event, payload, needs_ack, created_at, player_id, sent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          e.entry.id,
          e.entry.pi,
          e.entry.event,
          JSON.stringify(e.entry.payload),
          e.entry.needsAck ? 1 : 0,
          iso(e.entry.createdAt),
          e.entry.playerId,
          e.entry.sent ? 1 : 0,
        ],
      );
      break;
    case "outbox_remove":
      db.run("DELETE FROM outbox WHERE id = ?", [e.id]);
      break;
    case "outbox_mark_sent":
      db.run("UPDATE outbox SET sent = 1 WHERE id = ?", [e.id]);
      break;
    case "send":
    case "log":
      break;
  }
}

// ---------------------------------------------------------------- sessions

/** The stored client session of a Pi, or null. */
export function getSession(db: Database, pi: PiId): string | null {
  return (
    db
      .query<{ session: string | null }, [number]>("SELECT session FROM pi_delivery WHERE pi = ?")
      .get(pi)?.session ?? null
  );
}

export function setSession(db: Database, pi: PiId, session: string): void {
  db.run("UPDATE pi_delivery SET session = ? WHERE pi = ?", [session, pi]);
}

// ---------------------------------------------------------------- load

interface SlotRow {
  room: number;
  player_id: string | null;
  state: string;
  last_left: string | null;
  notified: number;
}
interface RunDbRow {
  player_id: string;
  username: string;
  created_at: string;
}
interface RoomTimeRow {
  player_id: string;
  room: number;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}
interface ShareRow {
  player_id: string;
  key: string;
  value_json: string;
  targets: string | null;
  from_pi: number;
  created_at: string;
}
interface OutboxRow {
  id: number;
  pi: number;
  event: string;
  payload: string;
  needs_ack: number;
  created_at: string;
  player_id: string;
  sent: number;
}

/** Rebuilds the game state from the tables. */
export function loadState(db: Database): State {
  const s = emptyState();

  for (const r of db.query<SlotRow, []>("SELECT * FROM room_slots ORDER BY room").all()) {
    const slot = s.slots[r.room - 1];
    if (!slot) continue;
    slot.playerId = r.player_id;
    slot.state = r.state as SlotState;
    slot.lastLeft = r.last_left;
    slot.notified = r.notified === 1;
  }

  const runs = db
    .query<RunDbRow, []>(
      "SELECT player_id, username, created_at FROM runs WHERE status = 'active' ORDER BY rowid",
    )
    .all();
  for (const r of runs) {
    const run: Run = {
      playerId: r.player_id,
      username: r.username,
      createdAt: msNotNull(r.created_at),
      rooms: PI_IDS.map(() => ({ startedAt: null, finishedAt: null, durationMs: null })),
      shares: [],
    };
    s.runs[run.playerId] = run;
  }
  const times = db
    .query<RoomTimeRow, []>(
      `SELECT t.* FROM room_times t JOIN runs r ON r.player_id = t.player_id
       WHERE r.status = 'active'`,
    )
    .all();
  for (const t of times) {
    const run = s.runs[t.player_id];
    if (!run) continue;
    run.rooms[t.room - 1] = {
      startedAt: ms(t.started_at),
      finishedAt: ms(t.finished_at),
      durationMs: t.duration_ms,
    };
  }
  // rowid keeps the order of the first insert; an upsert keeps the rowid (like game.ts).
  const shares = db
    .query<ShareRow, []>(
      `SELECT s.* FROM shares s JOIN runs r ON r.player_id = s.player_id
       WHERE r.status = 'active' ORDER BY s.rowid`,
    )
    .all();
  for (const r of shares) {
    const run = s.runs[r.player_id];
    if (!run) continue;
    const share: Share = {
      key: r.key,
      value: JSON.parse(r.value_json) as Json,
      targets: r.targets === null ? null : (JSON.parse(r.targets) as PiId[]),
      fromPi: r.from_pi as PiId,
      createdAt: msNotNull(r.created_at),
    };
    run.shares.push(share);
  }

  // Room statistics from completed runs (8.7).
  const count =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs WHERE status = 'completed'").get()
      ?.n ?? 0;
  const sums = db
    .query<{ room: number; total: number }, []>(
      `SELECT t.room AS room, COALESCE(SUM(t.duration_ms), 0) AS total
       FROM room_times t JOIN runs r ON r.player_id = t.player_id
       WHERE r.status = 'completed' GROUP BY t.room`,
    )
    .all();
  s.roomStats = PI_IDS.map((room) => ({
    count,
    sumMs: sums.find((x) => x.room === room)?.total ?? 0,
  }));

  s.outbox = db
    .query<OutboxRow, []>("SELECT * FROM outbox ORDER BY id")
    .all()
    .map(
      (r): OutboxEntry => ({
        id: r.id,
        pi: r.pi as PiId,
        event: r.event as OutboxEvent,
        payload: JSON.parse(r.payload) as ServerMessage,
        needsAck: r.needs_ack === 1,
        playerId: r.player_id,
        createdAt: msNotNull(r.created_at),
        sent: r.sent === 1,
      }),
    );
  const seq =
    db.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'outbox'").get()
      ?.seq ?? 0;
  s.nextOutboxId = seq + 1;

  for (const r of db
    .query<{ pi: number; last_seq: number; stale_incoming_oks: number }, []>(
      "SELECT pi, last_seq, stale_incoming_oks FROM pi_delivery ORDER BY pi",
    )
    .all()) {
    const d: PiDelivery = { lastSeq: r.last_seq, staleIncomingOks: r.stale_incoming_oks };
    s.pis[r.pi - 1] = d;
  }
  return s;
}

// ---------------------------------------------------------------- queries

interface LeaderboardDbRow {
  rank: number;
  player_id: string;
  username: string;
  total_time_ms: number;
  completed_at: string;
  r1: number | null;
  r2: number | null;
  r3: number | null;
  r4: number | null;
  r5: number | null;
}

const LEADERBOARD_SELECT = `
  SELECT r.player_id, r.username, r.total_time_ms, r.completed_at,
    (SELECT duration_ms FROM room_times t WHERE t.player_id = r.player_id AND t.room = 1) AS r1,
    (SELECT duration_ms FROM room_times t WHERE t.player_id = r.player_id AND t.room = 2) AS r2,
    (SELECT duration_ms FROM room_times t WHERE t.player_id = r.player_id AND t.room = 3) AS r3,
    (SELECT duration_ms FROM room_times t WHERE t.player_id = r.player_id AND t.room = 4) AS r4,
    (SELECT duration_ms FROM room_times t WHERE t.player_id = r.player_id AND t.room = 5) AS r5`;

export interface StateSnapshotSource {
  /** Pis with an authenticated connection now. */
  connectedPis(): PiId[];
}

/** The read-only queries for http.ts. */
export function createQueries(db: Database, tzName: string, source: StateSnapshotSource): Queries {
  const toRow = (r: LeaderboardDbRow): LeaderboardRow => ({
    rank: r.rank,
    player_id: r.player_id,
    username: r.username,
    total_time_ms: r.total_time_ms,
    room_times_ms: {
      room_1: r.r1 ?? 0,
      room_2: r.r2 ?? 0,
      room_3: r.r3 ?? 0,
      room_4: r.r4 ?? 0,
      room_5: r.r5 ?? 0,
    },
    completed_at: formatInZone(msNotNull(r.completed_at), tzName),
  });

  const listQuery = db.query<LeaderboardDbRow, [number, number]>(
    `${LEADERBOARD_SELECT},
       RANK() OVER (ORDER BY r.total_time_ms ASC) AS rank
     FROM runs r WHERE r.status = 'completed'
     ORDER BY r.total_time_ms ASC, r.completed_at ASC, r.player_id ASC
     LIMIT ? OFFSET ?`,
  );
  const oneQuery = db.query<LeaderboardDbRow, [string]>(
    `${LEADERBOARD_SELECT},
       1 + (SELECT COUNT(*) FROM runs o WHERE o.status = 'completed'
            AND o.total_time_ms < r.total_time_ms) AS rank
     FROM runs r WHERE r.status = 'completed' AND r.player_id = ?`,
  );

  return {
    leaderboard(limit: number, offset: number): LeaderboardRow[] {
      return listQuery.all(limit, offset).map(toRow);
    },
    leaderboardOne(playerId: string): LeaderboardRow | null {
      const r = oneQuery.get(playerId);
      return r === null ? null : toRow(r);
    },
    state(): unknown {
      return stateSnapshot(db, tzName, source.connectedPis());
    },
  };
}

/** Operator view of the room slots, the connected Pis and the outbox (GET /state). */
export function stateSnapshot(db: Database, tzName: string, connected: PiId[]) {
  const slots = db
    .query<
      SlotRow & { username: string | null; started_at: string | null; finished_at: string | null },
      []
    >(
      `SELECT s.*, r.username AS username, t.started_at AS started_at,
         t.finished_at AS finished_at
       FROM room_slots s
       LEFT JOIN runs r ON r.player_id = s.player_id
       LEFT JOIN room_times t ON t.player_id = s.player_id AND t.room = s.room
       ORDER BY s.room`,
    )
    .all();
  const outbox = db
    .query<{ pi: number; event: string; n: number }, []>(
      "SELECT pi, event, COUNT(*) AS n FROM outbox GROUP BY pi, event ORDER BY pi, event",
    )
    .all();
  const fmt = (t: string | null) => (t === null ? null : formatInZone(msNotNull(t), tzName));
  return {
    rooms: slots.map((s) => ({
      room: s.room,
      state: s.state,
      player_id: s.player_id,
      username: s.username,
      started_at: fmt(s.started_at),
      finished_at: fmt(s.finished_at),
    })),
    connected_pis: [...connected].sort((a, b) => a - b),
    outbox_size: outbox.reduce((sum, r) => sum + r.n, 0),
    outbox: outbox.map((r) => ({ pi: r.pi, event: r.event, count: r.n })),
  };
}
