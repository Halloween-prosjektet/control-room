// Integration tests (plan step 7): the real server on a random port with a temp
// SQLite file, and five clients that act like the Godot client.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { type LogLevel, type RunningServer, startServer } from "../src/index.ts";
import type { LeaderboardRow } from "../src/queries-interface.ts";
import { rng } from "./harness.ts";
import { PiClient, waitUntil } from "./pi-client.ts";

interface Env {
  dir: string;
  dbPath: string;
  srv: RunningServer;
  url: string;
  http: string;
  pis: PiClient[];
  logs: { level: LogLevel; message: string }[];
}

const envs: Env[] = [];

function config(dbPath: string, ackRetryMs = 100): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    dbPath,
    logFile: null,
    ackRetryMs,
    wsIdleTimeoutS: 120,
    defaultRoomMs: 300_000,
    incomingTimeoutMs: 0,
    playingTimeoutMs: 0,
    tzName: "Europe/Oslo",
  };
}

function boot(env: Partial<Env> & { dbPath: string }, ackRetryMs = 100): Env {
  const logs = env.logs ?? [];
  const srv = startServer(config(env.dbPath, ackRetryMs), {
    log: (level, message) => {
      logs.push({ level, message });
    },
  });
  const url = `ws://127.0.0.1:${srv.port}`;
  return {
    dir: env.dir ?? "",
    dbPath: env.dbPath,
    srv,
    url,
    http: `http://127.0.0.1:${srv.port}`,
    pis: env.pis ?? [],
    logs,
  };
}

async function setup(ackRetryMs = 100): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "cr-server-"));
  const env = boot({ dir, dbPath: join(dir, "test.sqlite") }, ackRetryMs);
  envs.push(env);
  env.pis = [1, 2, 3, 4, 5].map((n) => new PiClient(env.url, n));
  await Promise.all(env.pis.map((p) => p.online()));
  return env;
}

afterEach(async () => {
  for (const env of envs.splice(0)) {
    for (const p of env.pis) await p.disconnect();
    await env.srv.stop();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

function pi(env: Env, n: number): PiClient {
  const p = env.pis[n - 1];
  if (!p) throw new Error(`no pi ${n}`);
  return p;
}

function slots(env: Env): [string, string | null][] {
  const st = env.srv.room.state;
  return st.slots.map((s) => [
    s.state,
    s.playerId === null ? null : (st.runs[s.playerId]?.username ?? "?"),
  ]);
}

/** Waits until Pi `n` has the player_incoming for `username` (and acked it). */
async function incoming(env: Env, n: number, username: string): Promise<void> {
  const p = pi(env, n);
  await waitUntil(
    () => p.events("player_incoming").some((m) => "username" in m && m.username === username),
    `pi ${n} player_incoming ${username}`,
  );
  await waitUntil(() => p.allAcked(), `pi ${n} acks`);
}

/** Plays the room of Pi `n` (start and finish) and waits for the acks. */
async function play(env: Env, n: number): Promise<void> {
  const p = pi(env, n);
  p.start();
  const seq = p.finish();
  await p.waitAck(seq);
}

/** Plays one player through all five rooms, alone in the pipeline. */
async function fullRun(env: Env, username: string): Promise<void> {
  await pi(env, 1).waitAck(pi(env, 1).register(username));
  await play(env, 1);
  for (let n = 2; n <= 5; n++) {
    await incoming(env, n, username);
    await play(env, n);
  }
}

async function getJson<T>(env: Env, path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${env.http}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

describe("server", () => {
  test("two players in the pipeline at the same time", async () => {
    const env = await setup();
    const [p1, p2] = [pi(env, 1), pi(env, 2)];
    await p1.waitAck(p1.register("Ada"));
    await play(env, 1);
    await p1.waitCount("game_finish_ok", 1);
    await incoming(env, 2, "Ada");
    p2.start();
    await p1.waitAck(p1.register("Bob"));
    expect(p1.count("player_register_ok")).toBe(2);
    expect(slots(env).slice(0, 2)).toEqual([
      ["incoming", "Bob"],
      ["playing", "Ada"],
    ]);
    await play(env, 1);
    expect(slots(env).slice(0, 2)).toEqual([
      ["waiting", "Bob"],
      ["playing", "Ada"],
    ]);
    await p2.waitAck(p2.finish());
    await incoming(env, 2, "Bob");
    await incoming(env, 3, "Ada");
    // Ada is one room in front of Bob: both play at the same time.
    for (let n = 3; n <= 5; n++) {
      await play(env, n); // Ada in room n
      await play(env, n - 1); // Bob in room n - 1
      if (n < 5) await incoming(env, n + 1, "Ada");
      await incoming(env, n, "Bob");
    }
    await play(env, 5); // Bob
    await waitUntil(() => Object.keys(env.srv.room.state.runs).length === 0, "all done");
    const lb = await getJson<LeaderboardRow[]>(env, "/leaderboard");
    expect(lb.body.map((r) => r.username).sort()).toEqual(["Ada", "Bob"]);
  });

  test("wait in room 2 and the hand-over chain", async () => {
    const env = await setup();
    const [p1, p2, p3] = [pi(env, 1), pi(env, 2), pi(env, 3)];
    // A to room 3 (playing).
    await p1.waitAck(p1.register("A"));
    await play(env, 1);
    await incoming(env, 2, "A");
    await play(env, 2);
    await incoming(env, 3, "A");
    await p3.waitAck(p3.start());
    // B to room 2, finishes, waits.
    await p1.waitAck(p1.register("B"));
    await play(env, 1);
    await incoming(env, 2, "B");
    await play(env, 2);
    await p2.waitCount("game_finish_wait", 1);
    // C in room 1, finishes, waits.
    await p1.waitAck(p1.register("C"));
    await play(env, 1);
    await p1.waitCount("game_finish_wait", 1);
    expect(slots(env).slice(0, 3)).toEqual([
      ["waiting", "C"],
      ["waiting", "B"],
      ["playing", "A"],
    ]);
    const wait = p2.events("game_finish_wait")[0];
    expect(wait && "max_wait" in wait ? wait.max_wait : "").toMatch(/[+-]\d{2}:\d{2}$/);
    const okBefore = [p1.count("game_finish_ok"), p2.count("game_finish_ok")];
    // A finishes room 3: the chain moves B to 3 and C to 2.
    await p3.waitAck(p3.finish());
    await incoming(env, 4, "A");
    await incoming(env, 3, "B");
    await incoming(env, 2, "C");
    await p1.waitCount("game_finish_ok", (okBefore[0] ?? 0) + 1);
    await p2.waitCount("game_finish_ok", (okBefore[1] ?? 0) + 1);
    expect(slots(env).slice(0, 4)).toEqual([
      ["empty", null],
      ["incoming", "C"],
      ["incoming", "B"],
      ["incoming", "A"],
    ]);
  });

  test("share from Pi 1 to Pi 3 comes in player_data", async () => {
    const env = await setup();
    const p1 = pi(env, 1);
    await p1.waitAck(p1.register("Sam"));
    p1.share("colour", { r: 255 }, 3);
    p1.share("all", [1, 2], null);
    await p1.waitCount("share_ok", 2);
    await play(env, 1);
    await incoming(env, 2, "Sam");
    expect(pi(env, 2).current).toEqual({ username: "Sam", data: { all: [1, 2] } });
    await play(env, 2);
    await incoming(env, 3, "Sam");
    expect(pi(env, 3).current).toEqual({
      username: "Sam",
      data: { colour: { r: 255 }, all: [1, 2] },
    });
  });

  test("player quits after room 1: player_left to Pi 2", async () => {
    const env = await setup();
    const [p1, p2] = [pi(env, 1), pi(env, 2)];
    await p1.waitAck(p1.register("Quitter"));
    await play(env, 1);
    await incoming(env, 2, "Quitter");
    await p1.waitAck(p1.leave());
    await p1.waitCount("player_leave_ok", 1);
    await p2.waitCount("player_left", 1);
    expect(p2.events("player_left")[0]).toEqual({
      event: "player_left",
      id: expect.any(Number),
      username: "Quitter",
    });
    await waitUntil(() => p2.allAcked(), "player_left_ok acked");
    await waitUntil(() => env.srv.room.state.outbox.length === 0, "outbox empty");
    expect(slots(env)[1]).toEqual(["empty", null]);
    expect((await getJson<LeaderboardRow[]>(env, "/leaderboard")).body).toEqual([]);
  });

  test("a late duplicate ok with an old id does not remove a newer player_incoming", async () => {
    const env = await setup();
    const [p1, p2] = [pi(env, 1), pi(env, 2)];
    await p1.waitAck(p1.register("A"));
    await play(env, 1);
    await incoming(env, 2, "A");
    const first = p2.events("player_incoming")[0];
    const idA = first && "id" in first ? first.id : 0;
    expect(idA).toBeGreaterThan(0);
    await play(env, 2);
    p2.autoOk = false;
    await p1.waitAck(p1.register("B"));
    await play(env, 1);
    await waitUntil(
      () => p2.events("player_incoming").some((m) => "username" in m && m.username === "B"),
      "pi 2 player_incoming B",
    );
    const entry = env.srv.room.state.outbox.find((e) => e.pi === 2);
    expect(entry?.payload).toMatchObject({ event: "player_incoming", username: "B" });
    // A second copy of player_incoming(A) gets its ok late: no effect.
    await p2.waitAck(p2.sendEvent({ event: "player_incoming_ok", id: idA }));
    expect(env.srv.room.state.outbox.find((e) => e.pi === 2)).toEqual(entry);
    await p2.waitAck(p2.sendEvent({ event: "player_incoming_ok", id: entry?.id }));
    expect(env.srv.room.state.outbox.filter((e) => e.pi === 2)).toEqual([]);
  });

  test("F8: game_finish_ok is sent again until game_finish_ack, also after a reconnect", async () => {
    const env = await setup();
    const p1 = pi(env, 1);
    p1.autoOk = false;
    await p1.waitAck(p1.register("A"));
    await play(env, 1);
    await p1.waitCount("game_finish_ok", 2); // resent (ACK_RETRY_MS = 100)
    const ok = p1.events("game_finish_ok")[0];
    expect(ok).toEqual({ event: "game_finish_ok", id: expect.any(Number), username: "A" });
    await p1.disconnect();
    const n = p1.count("game_finish_ok");
    await p1.online();
    await p1.waitCount("game_finish_ok", n + 1);
    expect(p1.received.filter((r) => r.conn === 2).map((r) => r.msg.event)[1]).toBe(
      "game_finish_ok",
    );
    expect(env.srv.room.state.outbox.some((e) => e.pi === 1)).toBe(true);
    await p1.waitAck(p1.sendEvent({ event: "game_finish_ack", id: ok && "id" in ok ? ok.id : 0 }));
    expect(env.srv.room.state.outbox.some((e) => e.pi === 1)).toBe(false);
    // F6: the client acted on game_finish_ok one time only.
    expect(p1.signals.filter((s) => s.event === "game_finish_ok")).toEqual([
      { event: "game_finish_ok", username: "A" },
    ]);
  });

  test("F8: an old client (no game_finish_ack feature) gets game_finish_ok one time", async () => {
    const env = await setup();
    const p1 = pi(env, 1);
    await p1.disconnect();
    p1.finishAck = false;
    await p1.online();
    await p1.waitAck(p1.register("A"));
    await play(env, 1);
    await p1.waitCount("game_finish_ok", 1);
    await waitUntil(() => !env.srv.room.state.outbox.some((e) => e.pi === 1), "removed");
    await Bun.sleep(250);
    expect(p1.count("game_finish_ok")).toBe(1);
    expect(p1.received.some((r) => r.msg.event === "error")).toBe(false);
  });

  test("F2: player_leave with username removes the player that quit, not the next one", async () => {
    const env = await setup();
    const [p1, p2] = [pi(env, 1), pi(env, 2)];
    await p1.waitAck(p1.register("A"));
    await play(env, 1);
    await incoming(env, 2, "A");
    await p2.waitAck(p2.start());
    await p1.waitAck(p1.register("B"));
    await play(env, 1);
    await p1.waitCount("game_finish_wait", 1);
    await p2.waitAck(p2.finish()); // A to room 3, B to room 2
    expect(slots(env).slice(0, 3)).toEqual([
      ["empty", null],
      ["incoming", "B"],
      ["incoming", "A"],
    ]);
    // A says "I stop" at Pi 2.
    await p2.waitAck(p2.sendEvent({ event: "player_leave", username: "A" }));
    expect(slots(env).slice(0, 3)).toEqual([
      ["empty", null],
      ["incoming", "B"],
      ["empty", null],
    ]);
    // A wrong username gets wrong_player and changes nothing.
    await p2.waitAck(p2.sendEvent({ event: "game_start", username: "A" }));
    expect(p2.events("error").at(-1)).toMatchObject({ code: "wrong_player" });
    expect(slots(env)[1]).toEqual(["incoming", "B"]);
  });

  test("F6: copies of player_incoming give one signal; player_left of another player is ignored", async () => {
    const env = await setup();
    const [p1, p2] = [pi(env, 1), pi(env, 2)];
    p2.autoOk = false;
    await p1.waitAck(p1.register("A"));
    await play(env, 1);
    await p2.waitCount("player_incoming", 3); // resent until the ok
    const m = p2.events("player_incoming")[0];
    const id = m && "id" in m ? m.id : 0;
    await p2.waitAck(p2.sendEvent({ event: "player_incoming_ok", id }));
    expect(p2.signals.filter((s) => s.event === "player_incoming")).toHaveLength(1);
    // A player_left for another player (a late copy): no change at the Pi.
    p2.autoOk = true;
    const raw = { event: "player_left", id: 999, username: "Other" };
    (p2 as unknown as { onFrame: (ws: unknown, c: number, t: string) => void }).onFrame(
      p2.ws,
      p2.conn,
      JSON.stringify(raw),
    );
    expect(p2.current?.username).toBe("A");
    expect(p2.signals.filter((s) => s.event === "player_left")).toEqual([]);
  });

  test("Pi disconnects and connects again: the outbox is sent again", async () => {
    const env = await setup();
    const [p1, p2] = [pi(env, 1), pi(env, 2)];
    await p2.disconnect();
    await p1.waitAck(p1.register("A"));
    await play(env, 1);
    await Bun.sleep(250); // more than ACK_RETRY_MS: no resend to an offline Pi
    expect(p2.count("player_incoming")).toBe(0);
    expect(env.srv.room.state.outbox.map((e) => [e.pi, e.event])).toEqual([[2, "player_incoming"]]);
    // Pi 2 comes back: it gets the player_incoming after auth_ok.
    await p2.online();
    await incoming(env, 2, "A");
    const afterAuth = p2.received.filter((r) => r.conn === 2).map((r) => r.msg.event);
    expect(afterAuth[0]).toBe("auth_ok");
    await waitUntil(() => env.srv.room.state.outbox.length === 0, "outbox empty");
    p2.start();

    // B waits in room 1, Pi 1 goes offline, Pi 2 finishes: game_finish_ok waits in the outbox.
    await p1.waitAck(p1.register("B"));
    await play(env, 1);
    await p1.waitCount("game_finish_wait", 1);
    await p1.disconnect();
    const okCount = p1.count("game_finish_ok");
    await p2.waitAck(p2.finish());
    await waitUntil(
      () => env.srv.room.state.outbox.some((e) => e.pi === 1 && e.event === "game_finish_ok"),
      "game_finish_ok in outbox",
    );
    // Events while offline go in the queue of the client.
    const leaveSeq = p1.share("note", "offline");
    await p1.online();
    await p1.waitCount("game_finish_ok", okCount + 1);
    await p1.waitAck(leaveSeq);
    await waitUntil(
      () => !env.srv.room.state.outbox.some((e) => e.pi === 1),
      "game_finish_ok removed after game_finish_ack",
    );
  });

  test("server restart in the middle of a run: same state, the run completes", async () => {
    const env = await setup();
    const [p1, p3] = [pi(env, 1), pi(env, 3)];
    await p1.waitAck(p1.register("Rita"));
    p1.share("k", "v", [4]);
    await play(env, 1);
    await incoming(env, 2, "Rita");
    await p3.disconnect(); // the player_incoming for Pi 3 stays in the outbox
    await play(env, 2);
    await p1.waitAck(p1.register("Tor"));
    await play(env, 1);
    await incoming(env, 2, "Tor");
    const before = structuredClone(env.srv.room.state);
    const lbBefore = (await getJson<LeaderboardRow[]>(env, "/leaderboard")).body;
    expect(before.outbox.map((e) => [e.pi, e.event])).toEqual([[3, "player_incoming"]]);

    for (const p of env.pis) await p.disconnect();
    await env.srv.stop();
    const env2 = boot({ dir: env.dir, dbPath: env.dbPath, pis: env.pis, logs: env.logs });
    env.srv = env2.srv;
    env.http = env2.http;
    expect(env2.srv.room.state).toEqual(before);
    expect((await getJson<LeaderboardRow[]>(env, "/leaderboard")).body).toEqual(lbBefore);

    for (const p of env.pis) {
      p.url = env2.url;
      await p.online();
    }
    await incoming(env, 3, "Rita");
    await play(env, 3);
    await incoming(env, 4, "Rita");
    expect(pi(env, 4).current?.data).toEqual({ k: "v" });
    await play(env, 4);
    await incoming(env, 5, "Rita");
    await play(env, 5);
    await waitUntil(() => env.srv.room.state.slots[4]?.state === "empty", "room 5 empty");
    const lb = (await getJson<LeaderboardRow[]>(env, "/leaderboard")).body;
    expect(lb.map((r) => r.username)).toEqual(["Rita"]);
  });

  test("duplicate seq is ignored but acked", async () => {
    const env = await setup();
    const p1 = pi(env, 1);
    const seq = p1.register("Once");
    await p1.waitAck(seq);
    const acksBefore = p1.events("ack").length;
    p1.raw({
      event: "player_register",
      username: "Twice",
      seq,
      timestamp: new Date().toISOString(),
    });
    await p1.waitCount("ack", acksBefore + 1);
    expect(p1.events("ack").at(-1)).toEqual({ event: "ack", seq });
    expect(p1.count("player_register_ok")).toBe(1);
    expect(slots(env)[0]).toEqual(["incoming", "Once"]);
  });

  test("a new session resets the seq; the same session keeps it", async () => {
    const env = await setup();
    const p1 = pi(env, 1);
    await p1.waitAck(p1.register("First"));
    await play(env, 1);
    // The game_finish_ack of game_finish_ok is the 4th event.
    await waitUntil(() => env.srv.room.state.outbox.length === 0, "outbox empty");
    await waitUntil(() => p1.allAcked(), "pi 1 all acked");
    const last = p1.nextSeq - 1;
    expect(last).toBe(4);
    expect(env.srv.room.state.pis[0]?.lastSeq).toBe(last);

    // Same session after a reconnect: seq 1 is a repeated event.
    await p1.disconnect();
    await p1.online();
    const acks = p1.events("ack").length;
    p1.raw({ event: "game_start", seq: 1 });
    await p1.waitCount("ack", acks + 1);
    expect(p1.events("ack").at(-1)).toEqual({ event: "ack", seq: last });

    // App restart: new session, seq starts at 1 again and is processed.
    await p1.restartApp();
    await p1.online();
    expect(env.srv.room.state.pis[0]?.lastSeq).toBe(0);
    const seq = p1.register("Second");
    expect(seq).toBe(1);
    await p1.waitAck(seq);
    expect(p1.count("player_register_ok")).toBe(2);
    expect(slots(env)[0]).toEqual(["incoming", "Second"]);
  });

  test("leaderboard order and format over HTTP", async () => {
    const env = await setup();
    const base = Date.now();
    const at = (ms: number) => new Date(base + ms).toISOString();
    const runs: [string, number[]][] = [
      ["Slow", [3000, 3000, 3000, 3000, 3000]],
      ["Fast", [1000, 1000, 1000, 1000, 1000]],
      ["Mid", [1000, 2000, 3000, 2000, 2000]],
      ["MidToo", [2000, 2000, 2000, 2000, 2000]],
    ];
    let t = 0;
    for (const [name, times] of runs) {
      const p1 = pi(env, 1);
      await p1.waitAck(p1.register(name));
      for (let n = 1; n <= 5; n++) {
        const p = pi(env, n);
        if (n > 1) await incoming(env, n, name);
        p.sendEvent({ event: "game_start", timestamp: at(t) });
        t += times[n - 1] ?? 0;
        await p.waitAck(p.sendEvent({ event: "game_finish", timestamp: at(t) }));
        t += 10;
      }
    }
    await waitUntil(() => env.srv.room.state.slots[4]?.state === "empty", "done");
    const lb = await getJson<LeaderboardRow[]>(env, "/leaderboard");
    expect(lb.status).toBe(200);
    expect(lb.body.map((r) => [r.rank, r.username, r.total_time_ms])).toEqual([
      [1, "Fast", 5000],
      [2, "Mid", 10000],
      [2, "MidToo", 10000],
      [4, "Slow", 15000],
    ]);
    const fast = lb.body[0] as LeaderboardRow;
    expect(Object.keys(fast)).toEqual([
      "rank",
      "player_id",
      "username",
      "total_time_ms",
      "room_times_ms",
      "completed_at",
    ]);
    expect(fast.room_times_ms).toEqual({
      room_1: 1000,
      room_2: 1000,
      room_3: 1000,
      room_4: 1000,
      room_5: 1000,
    });
    expect(fast.completed_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/,
    );
    expect(fast.player_id).toMatch(/^[0-9a-f-]{36}$/);
    const one = await getJson<LeaderboardRow>(env, `/leaderboard/${lb.body[2]?.player_id}`);
    expect(one.body).toEqual(lb.body[2] as LeaderboardRow);
    expect((await getJson(env, "/leaderboard/nope")).status).toBe(404);
    expect((await getJson<LeaderboardRow[]>(env, "/leaderboard?limit=1&offset=1")).body).toEqual([
      lb.body[1] as LeaderboardRow,
    ]);
    expect((await getJson(env, "/health")).body).toEqual({ ok: true });
    const state = (await getJson<{ connected_pis: number[]; outbox_size: number }>(env, "/state"))
      .body;
    expect(state.connected_pis).toEqual([1, 2, 3, 4, 5]);
    const res = await fetch(`${env.http}/leaderboard`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("bad JSON and unknown events do not close an authenticated connection", async () => {
    const env = await setup();
    const p1 = pi(env, 1);
    p1.raw("{not json");
    p1.raw("[1,2]");
    p1.raw({ event: "dance" });
    p1.raw({ event: "game_start", seq: "x" });
    await p1.waitCount("error", 4);
    expect(p1.events("error").map((m) => ("code" in m ? m.code : ""))).toEqual([
      "bad_json",
      "bad_json",
      "unknown_event",
      "bad_request",
    ]);
    const err = p1.events("error")[2];
    expect(err && "event_name" in err ? err.event_name : "").toBe("dance");
    await p1.waitAck(p1.register("StillHere"));
    expect(p1.closes).toEqual([]);
    expect(p1.count("player_register_ok")).toBe(1);
  });

  test("invalid auth closes with 4001 and sends no reply", async () => {
    const env = await setup();
    for (const bad of [{ event: "auth", pi: 9 }, { event: "auth" }, { event: "auth", pi: "1" }]) {
      const c = new PiClient(env.url, 9);
      c.manualAuth = true;
      await c.connect();
      c.raw(bad);
      await waitUntil(() => c.closes.length === 1, "close");
      expect(c.closes[0]?.code).toBe(4001);
      expect(c.received).toEqual([]);
    }
    expect(env.srv.room.connections.connectedPis()).toEqual([1, 2, 3, 4, 5]);
  });

  test("a second connection for a Pi closes the old one with 4000", async () => {
    const env = await setup();
    const old = pi(env, 3);
    const fresh = new PiClient(env.url, 3);
    fresh.session = old.session;
    await fresh.online();
    await waitUntil(() => old.closes.length === 1, "old closed");
    expect(old.closes[0]?.code).toBe(4000);
    // The close log says who closed the connection, and where the client was.
    await waitUntil(
      () => env.logs.some((l) => /closed: 4000 .*closed by server\)/.test(l.message)),
      "close log with the closer",
    );
    expect(env.logs.some((l) => /connection \d+ open from 127\.0\.0\.1/.test(l.message))).toBe(
      true,
    );
    env.pis[2] = fresh;
    expect(env.srv.room.connections.connectedPis()).toEqual([1, 2, 3, 4, 5]);
    // The new connection works for a full run.
    await fullRun(env, "AfterReplace");
    expect((await getJson<LeaderboardRow[]>(env, "/leaderboard")).body.length).toBe(1);
  });

  test("messages before auth are kept and processed in order after auth_ok", async () => {
    const env = await setup();
    await pi(env, 1).disconnect();
    const c = new PiClient(env.url, 1);
    c.manualAuth = true;
    await c.connect();
    c.raw({ event: "player_register", username: "Early", seq: 1 });
    c.raw({ event: "game_start", seq: 2 });
    await Bun.sleep(30);
    expect(c.received).toEqual([]);
    c.sendAuth();
    await waitUntil(() => c.received.length >= 5, "replies");
    expect(c.received.map((r) => r.msg.event)).toEqual([
      "auth_ok",
      "player_register_ok",
      "ack",
      "game_start_ok",
      "ack",
    ]);
    env.pis[0] = c;
    expect(slots(env)[0]).toEqual(["playing", "Early"]);
  });

  test("auth_ok for each auth, also on an authenticated connection", async () => {
    const env = await setup();
    const p2 = pi(env, 2);
    const n = p2.count("auth_ok");
    p2.sendAuth();
    await p2.waitCount("auth_ok", n + 1);
    expect(p2.closes).toEqual([]);
  });
});

describe("soak", () => {
  const seeds = process.env.SOAK_SEEDS
    ? Array.from({ length: Number(process.env.SOAK_SEEDS) }, (_, i) => 100 + i)
    : [11, 22];
  test.each(seeds)(
    "seed %d: 20 runs, five Pis, random disconnects, no lost messages",
    async (seed) => {
      const env = await setup(50);
      const r = rng(seed);
      const RUNS = 20;
      const names = Array.from({ length: RUNS }, (_, i) => `P${String(i + 1).padStart(2, "0")}`);
      type Local = {
        username: string | null;
        phase: "idle" | "playing" | "done";
        finishAt: number;
      };
      const local: Local[] = env.pis.map(() => ({ username: null, phase: "done", finishAt: 0 }));
      const offlineUntil = env.pis.map(() => 0);
      let registered = 0;
      const shared = new Set<string>();
      let disconnects = 0;
      const completedQuery = env.srv.room.db.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM runs WHERE status = 'completed'",
      );
      const completed = () => (completedQuery.get()?.n ?? 0) === RUNS;

      for (let tick = 0; !completed(); tick++) {
        if (tick > 20_000) throw new Error(`soak stuck: ${JSON.stringify(slots(env))}`);
        await Bun.sleep(1 + Math.floor(r() * 3));

        // Random disconnects and reconnects.
        for (let i = 0; i < 5; i++) {
          const p = env.pis[i] as PiClient;
          if (p.ws === null && tick >= (offlineUntil[i] ?? 0)) {
            await p.connect();
          } else if (
            p.ws !== null &&
            p.authenticated &&
            r() < Number(process.env.SOAK_RATE ?? 0.02)
          ) {
            disconnects++;
            await p.disconnect();
            offlineUntil[i] = tick + 5 + Math.floor(r() * 40);
          }
        }

        for (let i = 0; i < 5; i++) {
          const p = env.pis[i] as PiClient;
          const l = local[i] as Local;
          if (i === 0) {
            // Pi 1: a new player when the room is free (the real game shows this on screen).
            // It waits for the ack of its last event, so that it does not register two players.
            if (
              l.phase === "done" &&
              registered < RUNS &&
              p.allAcked() &&
              env.srv.room.state.slots[0]?.state === "empty"
            ) {
              const name = names[registered++] as string;
              p.register(name);
              if (r() < 0.5) {
                p.share("from1", { n: registered }, [3, 5]);
                shared.add(name);
              }
              l.username = name;
              l.phase = "idle";
            }
          } else if (p.current && p.current.username !== l.username && l.phase === "done") {
            l.username = p.current.username;
            l.phase = "idle";
          }
          if (l.phase === "idle" && r() < 0.5) {
            p.start();
            l.phase = "playing";
            l.finishAt = tick + 1 + Math.floor(r() * 10);
          } else if (l.phase === "playing" && tick >= l.finishAt) {
            if (r() < 0.2) p.share(`k${i + 1}`, r(), null);
            p.finish();
            l.phase = "done";
          }
        }
      }

      // Every Pi gets all events acked, and the outbox drains.
      for (const p of env.pis) if (p.ws === null) await p.online();
      for (const p of env.pis) await waitUntil(() => p.allAcked(), `pi ${p.pi} all acked`, 5000);
      await waitUntil(() => env.srv.room.state.outbox.length === 0, "outbox empty", 5000);

      // No lost player_incoming: Pi 2..5 got every player.
      for (let n = 2; n <= 5; n++) {
        const got = new Set(
          pi(env, n)
            .events("player_incoming")
            .map((m) => ("username" in m ? m.username : "")),
        );
        expect([...got].sort()).toEqual(names);
      }
      // Shares from Pi 1 to Pi 3 and 5 arrived in player_data.
      for (const n of [2, 3, 4, 5]) {
        const withShare = pi(env, n)
          .events("player_incoming")
          .filter((m) => m.event === "player_incoming" && "from1" in m.player_data)
          .map((m) => ("username" in m ? m.username : ""));
        expect([...new Set(withShare)].sort()).toEqual(
          n === 3 || n === 5 ? [...shared].sort() : [],
        );
      }
      const lb = await getJson<LeaderboardRow[]>(env, "/leaderboard?limit=500");
      expect(lb.body.map((x) => x.username).sort()).toEqual(names);
      expect(lb.body.map((x) => x.rank)).toEqual(
        lb.body.map((x) => 1 + lb.body.filter((y) => y.total_time_ms < x.total_time_ms).length),
      );
      expect(env.srv.room.state.slots.every((s) => s.state === "empty")).toBe(true);
      expect(disconnects).toBeGreaterThanOrEqual(3);
      expect(env.logs.filter((l) => l.level === "error")).toEqual([]);
    },
    60_000,
  );
});
