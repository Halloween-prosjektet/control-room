// Fake control room server for the end-to-end test of the GDScript client.
// Usage: bun fake_server.ts <scenario> <port>
// On SIGTERM the server checks what it received, prints "SERVER ..." lines
// and exits with code 0 (pass) or 1 (fail).

type Msg = Record<string, any>;
interface Entry {
  conn: number;
  dir: "in" | "out" | "sys" | "dup";
  msg: Msg;
  t: number;
}

const [scenario, portStr] = process.argv.slice(2);
const port = Number(portStr);
const t0 = Date.now();
const log: Entry[] = [];
let connCount = 0;

function rec(conn: number, dir: Entry["dir"], msg: Msg) {
  log.push({ conn, dir, msg, t: Date.now() - t0 });
}
function send(ws: any, msg: Msg) {
  rec(ws.data.conn, "out", msg);
  ws.send(JSON.stringify(msg));
}

// Per Pi (across connections): seq numbers seen, and the highest seq n such that
// all seq 1..n are seen (the cumulative ack value). A message with a seq that
// was seen before is a duplicate: it is logged as "dup" and not processed.
const seenByPi = new Map<number, { seen: Set<number>; contig: number }>();
const piState = (pi: number) => {
  let st = seenByPi.get(pi);
  if (!st) seenByPi.set(pi, (st = { seen: new Set(), contig: 0 }));
  return st;
};
const dups = () => log.filter((e) => e.dir === "dup");

// "ins" holds accepted messages only (duplicates are in "dup" entries).
const ins = (conn?: number) =>
  log.filter((e) => e.dir === "in" && (conn === undefined || e.conn === conn));
const events = (conn?: number) => ins(conn).filter((e) => e.msg.event !== "auth");
const names = (es: Entry[]) => es.map((e) => e.msg.event);
const authsOn = (conn: number) => ins(conn).filter((e) => e.msg.event === "auth");
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})\+00:00$/;
function checkTimestamps(f: string[]) {
  for (const e of ins()) {
    if (e.msg.event === "register") f.push("client sent legacy event 'register'");
    if (["player_register", "game_start", "game_finish", "share"].includes(e.msg.event)) {
      const ts = e.msg.timestamp;
      const m = typeof ts === "string" ? ts.match(TS_RE) : null;
      if (!m) {
        f.push(`bad timestamp format in ${e.msg.event}: ${JSON.stringify(ts)}`);
        continue;
      }
      const ms = Date.parse(m[1] + "Z");
      if (Number.isNaN(ms) || Math.abs(Date.now() - ms) > 60_000)
        f.push(`timestamp not close to now in ${e.msg.event}: ${ts}`);
    }
  }
}

// Check for all scenarios: every event has a seq; accepted seq values are
// exactly 1..n in order (no loss, no duplicate after dedupe, order kept).
function checkSeq(f: string[]) {
  const seqs: number[] = [];
  for (const e of events()) {
    if (!Number.isInteger(e.msg.seq) || e.msg.seq < 1) f.push(`event '${e.msg.event}' has bad seq ${JSON.stringify(e.msg.seq)}`);
    else seqs.push(e.msg.seq);
  }
  for (let i = 0; i < seqs.length; i++)
    if (seqs[i] !== i + 1) {
      f.push(`accepted seq not 1..n in order: got ${JSON.stringify(seqs.slice(0, 20))}${seqs.length > 20 ? "..." : ""} (first bad at index ${i})`);
      break;
    }
  for (const e of ins()) if (e.msg.event === "auth" && "seq" in e.msg) f.push("auth message has a seq");
}

interface Scenario {
  onMessage(ws: any, msg: Msg): void;
  suppressAck?(ws: any, msg: Msg): boolean;
  verify(f: string[]): void;
}

let targetSeq: number | undefined;
const answerAuth = (ws: any) => send(ws, { event: "auth_ok" });

const scenarios: Record<string, Scenario> = {
  // a) normal flow
  normal: {
    onMessage(ws, msg) {
      if (msg.event === "auth") answerAuth(ws);
    },
    verify(f) {
      const all = names(ins());
      const want = ["auth", "player_register", "game_start", "share", "game_finish"];
      if (!eq(all, want)) f.push(`order: got ${JSON.stringify(all)}, want ${JSON.stringify(want)}`);
      const a = ins()[0]?.msg;
      if (a?.pi !== 3) f.push(`auth pi: got ${JSON.stringify(a?.pi)}, want 3`);
      const reg = events().find((e) => e.msg.event === "player_register")?.msg;
      if (reg?.username !== "bob") f.push(`username: got ${JSON.stringify(reg?.username)}`);
      const sh = events().find((e) => e.msg.event === "share")?.msg;
      if (sh?.key !== "score" || sh?.value !== 42 || !eq(sh?.pi, [1, 2]))
        f.push(`share fields wrong: ${JSON.stringify(sh)}`);
      if (connCount !== 1) f.push(`connections: got ${connCount}, want 1`);
      checkTimestamps(f);
    },
  },

  // b) events before auth_ok must wait; FIFO
  early: {
    onMessage(ws, msg) {
      if (msg.event === "auth") setTimeout(() => answerAuth(ws), 1500);
    },
    verify(f) {
      const okIdx = log.findIndex((e) => e.dir === "out" && e.msg.event === "auth_ok");
      if (okIdx < 0) f.push("server never sent auth_ok");
      log.forEach((e, i) => {
        if (e.dir === "in" && e.msg.event !== "auth" && i < okIdx)
          f.push(`event '${e.msg.event}' reached server BEFORE auth_ok (t=${e.t}ms)`);
      });
      const all = names(ins());
      const want = ["auth", "player_register", "game_start", "share", "share", "share", "share"];
      if (!eq(all, want)) f.push(`order: got ${JSON.stringify(all)}, want ${JSON.stringify(want)}`);
      const keys = events().filter((e) => e.msg.event === "share").map((e) => e.msg.key);
      if (!eq(keys, ["a", "b", "c", "after"]))
        f.push(`share FIFO: got ${JSON.stringify(keys)}, want [a,b,c,after]`);
      if (authsOn(0).length !== 1) f.push(`auth count: ${authsOn(0).length}, want 1`);
      checkTimestamps(f);
    },
  },

  // c) first auth ignored, second answered
  auth2: {
    onMessage(ws, msg) {
      if (msg.event !== "auth") return;
      if (authsOn(ws.data.conn).length >= 2) answerAuth(ws);
    },
    verify(f) {
      const a = authsOn(0);
      if (a.length !== 2) f.push(`auth count on conn 0: ${a.length}, want 2`);
      else {
        const gap = a[1].t - a[0].t;
        if (gap < 4500 || gap > 6500) f.push(`gap between auths ${gap}ms, want about 5000`);
      }
      if (connCount !== 1) f.push(`connections: got ${connCount}, want 1 (no reconnect)`);
      const okIdx = log.findIndex((e) => e.dir === "out" && e.msg.event === "auth_ok");
      log.forEach((e, i) => {
        if (e.dir === "in" && e.msg.event !== "auth" && i < okIdx)
          f.push(`event '${e.msg.event}' before auth_ok`);
      });
      if (!eq(names(events()), ["player_register"]))
        f.push(`events: ${JSON.stringify(names(events()))}, want [player_register]`);
    },
  },

  // c2) three auths ignored on first connection: client drops and reconnects
  auth3: {
    onMessage(ws, msg) {
      if (msg.event !== "auth") return;
      if (ws.data.conn >= 1) answerAuth(ws);
    },
    verify(f) {
      const a0 = authsOn(0);
      if (a0.length !== 3) f.push(`auth count on conn 0: ${a0.length}, want exactly 3`);
      else {
        for (let i = 1; i < 3; i++) {
          const gap = a0[i].t - a0[i - 1].t;
          if (gap < 4500 || gap > 6500) f.push(`gap auth ${i}->${i + 1}: ${gap}ms, want about 5000`);
        }
      }
      if (connCount !== 2) f.push(`connections: got ${connCount}, want 2`);
      if (authsOn(1).length !== 1) f.push(`auth count on conn 1: ${authsOn(1).length}, want 1`);
      if (events(0).length) f.push(`events leaked on conn 0: ${JSON.stringify(names(events(0)))}`);
      if (!eq(names(events(1)), ["player_register"]))
        f.push(`conn 1 events: ${JSON.stringify(names(events(1)))}, want [player_register]`);
      if (log.findIndex((e) => e.conn === 1 && e.dir === "in" && e.msg.event === "auth") >
          log.findIndex((e) => e.conn === 1 && e.dir === "in" && e.msg.event === "player_register"))
        f.push("player_register came before auth on conn 1");
    },
  },

  // d) server drops mid session
  drop: {
    onMessage(ws, msg) {
      if (msg.event === "auth") return answerAuth(ws);
      if (ws.data.conn === 0 && msg.event === "share" && msg.key === "seq" && msg.value === 30) {
        rec(0, "sys", { event: "SERVER_TERMINATE" });
        ws.terminate();
      }
    },
    verify(f) {
      if (connCount !== 2) f.push(`connections: got ${connCount}, want 2`);
      if (authsOn(1).length !== 1) f.push(`auth count on conn 1: ${authsOn(1).length}, want 1`);
      const sh = events().filter((e) => e.msg.event === "share");
      const seqs = sh.filter((e) => e.msg.key === "seq");
      const vals = seqs.map((e) => e.msg.value as number);
      for (let i = 1; i < vals.length; i++)
        if (vals[i] <= vals[i - 1]) f.push(`order broken: ${vals[i - 1]} then ${vals[i]}`);
      // At-least-once: no loss. After dedupe: no duplicate. Order kept.
      for (let i = 0; i < vals.length; i++)
        if (vals[i] !== i) {
          f.push(`share 'seq' values not 0..n in order: ${vals[i - 1]} then ${vals[i]} at index ${i}`);
          break;
        }
      const onConn0 = events().filter((e) => e.conn === 0).length;
      console.log(`SERVER INFO drop: ${onConn0} events accepted on conn 0, ${dups().length} duplicate(s) dropped after reconnect`);
      const down = sh.filter((e) => e.msg.key === "down");
      const downOn1 = down.filter((e) => e.conn === 1).map((e) => e.msg.value);
      if (!eq(downOn1, [0, 1, 2])) f.push(`'down' events on conn 1: ${JSON.stringify(downOn1)}, want [0,1,2]`);
      if (down.some((e) => e.conn === 0)) f.push("'down' event arrived on dead conn 0");
      const firstOn1 = ins(1)[0]?.msg.event;
      if (firstOn1 !== "auth") f.push(`first message on conn 1 is '${firstOn1}', want auth`);
      const last = events().at(-1)?.msg.event;
      if (last !== "game_finish") f.push(`last event '${last}', want game_finish`);
      if (seqs.length === 0 || vals.at(-1) !== 149) f.push(`last seq ${vals.at(-1)}, want 149`);
      checkTimestamps(f);
    },
  },

  // d2) server reads an event, does NOT ack it, then kills the connection.
  // The client must send it again; the server sees a seq it knows (dedupe).
  lost_after_send: {
    suppressAck(ws, msg) {
      return ws.data.conn === 0 && msg.event === "share" && msg.key === "target";
    },
    onMessage(ws, msg) {
      if (msg.event === "auth") return answerAuth(ws);
      if (ws.data.conn === 0 && msg.event === "share" && msg.key === "target") {
        targetSeq = msg.seq;
        rec(0, "sys", { event: "SERVER_TERMINATE" });
        ws.terminate();
      }
    },
    verify(f) {
      if (connCount !== 2) f.push(`connections: got ${connCount}, want 2`);
      if (targetSeq === undefined) return f.push("server never saw the 'target' event");
      const acked = log.filter((e) => e.dir === "out" && e.msg.event === "ack" && e.conn === 0 && e.msg.seq >= targetSeq!);
      if (acked.length) f.push(`server acked seq ${targetSeq} or later on conn 0, but it must not`);
      const again = dups().filter((e) => e.conn === 1 && e.msg.seq === targetSeq);
      if (again.length !== 1) f.push(`resend of seq ${targetSeq} on conn 1 (as duplicate): got ${again.length}, want 1`);
      const tgt = events().filter((e) => e.msg.key === "target");
      if (tgt.length !== 1) f.push(`'target' accepted ${tgt.length} times, want exactly 1`);
      const keys = events().filter((e) => e.msg.event === "share").map((e) => e.msg.key);
      if (!eq(keys, ["a", "target", "b", "c"])) f.push(`share order: ${JSON.stringify(keys)}, want [a,target,b,c]`);
      const want = ["player_register", "game_start", "share", "share", "share", "share", "game_finish"];
      if (!eq(names(events()), want)) f.push(`events: ${JSON.stringify(names(events()))}, want ${JSON.stringify(want)}`);
      const last = log.filter((e) => e.dir === "out" && e.msg.event === "ack").at(-1)?.msg.seq;
      if (last !== 7) f.push(`last cumulative ack ${last}, want 7`);
      console.log(`SERVER INFO lost_after_send: target seq ${targetSeq} seen on conn 0 without ack, resent on conn 1, ${dups().length} duplicate(s) dropped`);
      checkTimestamps(f);
    },
  },

  // e) server-side events
  events: {
    onMessage(ws, msg) {
      if (msg.event !== "auth") return;
      answerAuth(ws);
      const steps: (() => void)[] = [
        () => send(ws, { event: "game_finish_wait", max_wait: "10 min" }),
        () => ws.send("not json {"),
        () => ws.send("[1,2]"),
        () => send(ws, { event: "mystery_event" }),
        () => send(ws, { event: "game_finish_ok" }),
        () => send(ws, { event: "player_incoming", username: "alice", player_data: { score: 3 } }),
        () => send(ws, { event: "player_left", username: "alice" }),
        () => send(ws, { event: "error", code: "E1", message: "boom", event_name: "share" }),
      ];
      steps.forEach((s, i) => setTimeout(s, 200 + i * 100));
    },
    verify(f) {
      const got = names(events());
      const want = ["player_incoming_ok", "player_left_ok"];
      if (!eq(got, want)) f.push(`client acks: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    },
  },
};

const sc = scenarios[scenario];
if (!sc) {
  console.error(`unknown scenario ${scenario}`);
  process.exit(2);
}

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    if (srv.upgrade(req, { data: { conn: connCount } })) {
      connCount++;
      return;
    }
    return new Response("websocket only", { status: 400 });
  },
  websocket: {
    open(ws: any) {
      rec(ws.data.conn, "sys", { event: "OPEN" });
    },
    message(ws: any, raw) {
      let msg: Msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.event === "auth") ws.data.pi = msg.pi;
      else {
        const st = piState(ws.data.pi ?? -1);
        if (Number.isInteger(msg.seq)) {
          if (st.seen.has(msg.seq)) {   // seq seen before: drop, but ack again
            rec(ws.data.conn, "dup", msg);
            send(ws, { event: "ack", seq: st.contig });
            return;
          }
          st.seen.add(msg.seq);
          while (st.seen.has(st.contig + 1)) st.contig++;
        }
      }
      rec(ws.data.conn, "in", msg);
      if (msg.event !== "auth" && !sc.suppressAck?.(ws, msg))
        send(ws, { event: "ack", seq: piState(ws.data.pi ?? -1).contig });
      sc.onMessage(ws, msg);
    },
    close(ws: any) {
      rec(ws.data.conn, "sys", { event: "CLOSE" });
    },
  },
});

console.log(`SERVER READY ${scenario} on ${server.port}`);

process.on("SIGTERM", () => {
  const f: string[] = [];
  try {
    sc.verify(f);
    checkSeq(f);
  } catch (e) {
    f.push(`verify threw: ${e}`);
  }
  const lines = log.map(
    (e) => `  conn${e.conn} ${e.dir.padEnd(3)} +${String(e.t).padStart(5)}ms ${JSON.stringify({ ...e.msg, timestamp: undefined })}`,
  );
  if (f.length || process.env.VERBOSE) {
    console.log("SERVER LOG (first 80 entries)");
    console.log(lines.slice(0, 80).join("\n"));
  }
  for (const m of f) console.log(`SERVER CHECK FAIL: ${m}`);
  if (!f.length) console.log("SERVER CHECK ok: all server-side checks passed");
  process.exit(f.length ? 1 : 0);
});
