// A command-line Pi for manual tests of the control room server.
//
//   bun tools/fake-pi.ts --url ws://localhost:7321 --pi 1
//   bun tools/fake-pi.ts --url ws://localhost:7321 --pi 1 --script steps.json
//   bun tools/fake-pi.ts --url ws://localhost:7321 --pi 3 --auto
//
// It uses the same client protocol as the Godot client (src/protocol.ts):
// - `auth` with `pi`, a random `session` and `features: ["game_finish_ack"]`.
// - Each other event gets a `seq` (1, 2, 3, ...). The server replies `ack` with
//   the highest processed seq. Events with no ack are sent again after the next
//   `auth_ok`, before the events in the queue.
// - `player_incoming`, `player_left` and `game_finish_ok` get `player_incoming_ok`,
//   `player_left_ok` and `game_finish_ack`. The reply echoes the `id` of the message
//   (when it has one), for each copy.
// - A copy of a message (same event, id and username) changes nothing more.
//   `player_left` for another player than the current player changes nothing.
// - `game_start`, `game_finish`, `player_leave` and `share` carry `username` of the
//   current player (when known).
// - When the connection closes, it connects again (1 s, 2 s, 4 s ... max 10 s).
//   Close code 4001 (auth refused) stops the program.
//
// Commands on stdin (also the lines of a --script file):
//   register NAME            player_register (Pi 1)
//   start                    game_start
//   finish                   game_finish
//   leave                    player_leave
//   share KEY VALUE [PI...]  share; VALUE is JSON or text; no PI = all Pis
//   raw JSON                 send a JSON object with no seq (for error tests)
//   sleep MS                 wait MS milliseconds
//   wait EVENT [MS]          wait for a server event (default timeout 60000 ms)
//   drop                     close the socket (it connects again)
//   status                   show the queue, unacked events and the player
//   help                     show this list
//   quit                     stop
//
// A --script file is a JSON array. Each item is a command line (string) or
// {"cmd": "start", "delay_ms": 500}.
//
// --auto plays runs for the room of the Pi with random delays:
//   Pi 1 registers a random name. Pi 2-5 waits for player_incoming. Then start,
//   play, (optional share), finish, and wait for game_finish_ok.
// Options for --auto: --runs N (default: no limit), --min-ms (default 1000),
//   --max-ms (default 5000), --leave-chance P (0..1, default 0),
//   --share-to PI (share {"from_pi": N} to this Pi in each run).

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Msg = { [key: string]: Json };

// ---------------------------------------------------------------- arguments

interface Options {
  url: string;
  pi: number;
  script: string | undefined;
  auto: boolean;
  runs: number;
  minMs: number;
  maxMs: number;
  leaveChance: number;
  shareTo: number | undefined;
  quiet: boolean;
}

function usage(code: number): never {
  console.log(
    "usage: bun tools/fake-pi.ts --url ws://localhost:7321 --pi 1..5 [--script file.json] [--auto]\n" +
      "       [--runs N] [--min-ms MS] [--max-ms MS] [--leave-chance P] [--share-to PI] [--quiet]",
  );
  process.exit(code);
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    url: "ws://localhost:7321",
    pi: 0,
    script: undefined,
    auto: false,
    runs: Number.POSITIVE_INFINITY,
    minMs: 1000,
    maxMs: 5000,
    leaveChance: 0,
    shareTo: undefined,
    quiet: false,
  };
  const num = (name: string, v: string | undefined): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n)) {
      console.error(`${name} needs a number`);
      usage(2);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case "--url":
        o.url = next() ?? usage(2);
        break;
      case "--pi":
        o.pi = num(a, next());
        break;
      case "--script":
        o.script = next() ?? usage(2);
        break;
      case "--auto":
        o.auto = true;
        break;
      case "--runs":
        o.runs = num(a, next());
        break;
      case "--min-ms":
        o.minMs = num(a, next());
        break;
      case "--max-ms":
        o.maxMs = num(a, next());
        break;
      case "--leave-chance":
        o.leaveChance = num(a, next());
        break;
      case "--share-to":
        o.shareTo = num(a, next());
        break;
      case "--quiet":
        o.quiet = true;
        break;
      case "-h":
      case "--help":
        usage(0);
        break;
      default:
        console.error(`unknown argument: ${a}`);
        usage(2);
    }
  }
  if (!Number.isInteger(o.pi) || o.pi < 1 || o.pi > 5) {
    console.error("--pi must be an integer from 1 to 5");
    usage(2);
  }
  if (o.minMs < 0 || o.maxMs < o.minMs) {
    console.error("--min-ms and --max-ms are not valid");
    usage(2);
  }
  return o;
}

// ---------------------------------------------------------------- helpers

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** ISO 8601 with the local offset, for example 2026-10-31T19:56:21.624+01:00. */
/** An ok event that echoes the `id` of the server message (when it has one). */
function okWithId(event: string, id: Json | undefined): Msg {
  return typeof id === "number" ? { event, id } : { event };
}

function timestamp(d = new Date()): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

const NAMES = ["Ghost", "Witch", "Pumpkin", "Bat", "Skeleton", "Vampire", "Zombie", "Mummy"];

// ---------------------------------------------------------------- client

type Waiter = { events: string[]; resolve: (m: Msg) => void };

class FakePi {
  private ws: WebSocket | null = null;
  private authenticated = false;
  private readonly session = randomHex(8);
  private nextSeq = 1;
  private sendQueue: Msg[] = [];
  private unacked: Msg[] = [];
  private waiters: Waiter[] = [];
  private retryMs = 1000;
  private stopped = false;
  /** Keys "event:id:username" of the server messages that it acted on. */
  private readonly seen = new Set<string>();
  player: { username: string; player_data: Json } | null = null;

  constructor(
    readonly url: string,
    readonly pi: number,
    private readonly quiet: boolean,
  ) {}

  log(text: string): void {
    const t = new Date().toISOString().slice(11, 23);
    console.log(`[${t} pi${this.pi}] ${text}`);
  }

  connect(): void {
    if (this.stopped) return;
    this.log(`connect ${this.url}`);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 1000;
      this.sendRaw({
        event: "auth",
        pi: this.pi,
        session: this.session,
        features: ["game_finish_ack"],
      });
    };
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.authenticated = false;
      this.log(`closed (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""})`);
      if (ev.code === 4001) {
        this.log("server refused auth, stop");
        process.exit(1);
      }
      if (this.stopped) return;
      const wait = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, 10000);
      this.log(`connect again in ${wait} ms`);
      setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => {
      // onclose comes after this and does the reconnect.
    };
  }

  /** Closes the socket. The client connects again (to test resend). */
  drop(): void {
    this.ws?.close(1000, "drop");
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close(1000, "quit");
  }

  private sendRaw(m: Msg): boolean {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    if (!this.quiet) this.log(`> ${JSON.stringify(m)}`);
    return true;
  }

  /** Sends a JSON object as it is, with no seq. */
  sendUntracked(m: Msg): void {
    if (!this.sendRaw(m)) this.log("not connected, message not sent");
  }

  /** Gives the event a seq and sends it now, or puts it in the queue. */
  sendEvent(m: Msg): void {
    m.seq = this.nextSeq++;
    if (this.authenticated && this.sendQueue.length === 0 && this.sendRaw(m)) {
      this.unacked.push(m);
      return;
    }
    this.sendQueue.push(m);
  }

  private flush(): void {
    while (this.sendQueue.length > 0) {
      const m = this.sendQueue[0];
      if (m === undefined || !this.sendRaw(m)) break;
      this.unacked.push(m);
      this.sendQueue.shift();
    }
  }

  private onAuthOk(): void {
    if (this.authenticated) return;
    this.authenticated = true;
    // Events with no ack can be lost with the old connection: send them first.
    this.sendQueue = [...this.unacked, ...this.sendQueue];
    this.unacked = [];
    this.flush();
  }

  private onAck(n: number): void {
    const keep = (m: Msg) => typeof m.seq !== "number" || m.seq > n;
    this.unacked = this.unacked.filter(keep);
    this.sendQueue = this.sendQueue.filter(keep);
  }

  private onMessage(text: string): void {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      this.log(`< (not JSON) ${text}`);
      return;
    }
    if (typeof m !== "object" || m === null || Array.isArray(m)) {
      this.log(`< (not an object) ${text}`);
      return;
    }
    const msg = m as Msg;
    const event = typeof msg.event === "string" ? msg.event : "";
    if (!this.quiet || event !== "ack") this.log(`< ${text}`);
    switch (event) {
      case "auth_ok":
        this.onAuthOk();
        break;
      case "ack":
        if (typeof msg.seq === "number") this.onAck(msg.seq);
        break;
      case "player_incoming":
        this.sendEvent(okWithId("player_incoming_ok", msg.id));
        if (!this.firstCopy(msg)) return;
        this.player = {
          username: String(msg.username ?? ""),
          player_data: msg.player_data ?? {},
        };
        break;
      case "player_left":
        this.sendEvent(okWithId("player_left_ok", msg.id));
        if (!this.firstCopy(msg) || msg.username !== this.player?.username) return;
        this.player = null;
        break;
      case "game_finish_ok":
        if (typeof msg.id === "number") this.sendEvent(okWithId("game_finish_ack", msg.id));
        if (!this.firstCopy(msg)) return;
        if (
          typeof msg.username === "string" &&
          this.player !== null &&
          msg.username !== this.player.username
        ) {
          return; // for an earlier player
        }
        if (this.pi === 5) this.player = null;
        break;
      case "player_leave_ok":
        this.player = null;
        break;
      case "error":
        this.log(
          `server error ${String(msg.code)} for '${String(msg.event_name)}': ${String(msg.message)}`,
        );
        break;
    }
    const now = this.waiters.filter((w) => w.events.includes(event));
    this.waiters = this.waiters.filter((w) => !w.events.includes(event));
    for (const w of now) w.resolve(msg);
  }

  /** True for the first copy of a server message (a message without id is always new). */
  private firstCopy(msg: Msg): boolean {
    if (typeof msg.id !== "number") return true;
    const key = `${String(msg.event)}:${msg.id}:${String(msg.username)}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  /** The username field of an event: the current player, when known. */
  private who(): Msg {
    return this.player ? { username: this.player.username } : {};
  }

  /** Waits for the next server message with one of these event names. */
  waitFor(events: string[], timeoutMs = 60000): Promise<Msg | null> {
    return new Promise((resolve) => {
      const w: Waiter = {
        events,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  status(): string {
    return JSON.stringify(
      {
        pi: this.pi,
        session: this.session,
        connected: this.ws?.readyState === WebSocket.OPEN,
        authenticated: this.authenticated,
        next_seq: this.nextSeq,
        queue: this.sendQueue.map((m) => `${m.seq}:${m.event}`),
        unacked: this.unacked.map((m) => `${m.seq}:${m.event}`),
        player: this.player,
      },
      null,
      2,
    );
  }

  register(username: string): void {
    this.player = { username: username.trim(), player_data: {} };
    this.sendEvent({ event: "player_register", username, timestamp: timestamp() });
  }
  start(): void {
    this.sendEvent({ event: "game_start", timestamp: timestamp(), ...this.who() });
  }
  finish(): void {
    this.sendEvent({ event: "game_finish", timestamp: timestamp(), ...this.who() });
  }
  leave(): void {
    this.sendEvent({ event: "player_leave", ...this.who() });
  }
  share(key: string, value: Json, pi: number | number[] | null): void {
    this.sendEvent({ event: "share", key, value, pi, timestamp: timestamp(), ...this.who() });
  }
}

// ---------------------------------------------------------------- commands

const HELP = `commands:
  register NAME            player_register (Pi 1)
  start | finish | leave   game_start | game_finish | player_leave
  share KEY VALUE [PI...]  VALUE is JSON or text; no PI = all Pis
  raw JSON                 send a JSON object with no seq
  sleep MS                 wait
  wait EVENT [MS]          wait for a server event
  drop                     close the socket (it connects again)
  status | help | quit`;

function parseValue(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

/** Runs one command line. Returns false for "quit". */
async function runCommand(client: FakePi, line: string): Promise<boolean> {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return true;
  const [cmd = "", ...rest] = trimmed.split(/\s+/);
  const restText = trimmed.slice(cmd.length).trim();
  switch (cmd.toLowerCase()) {
    case "register":
      if (restText === "") client.log("usage: register NAME");
      else client.register(restText);
      break;
    case "start":
      client.start();
      break;
    case "finish":
      client.finish();
      break;
    case "leave":
      client.leave();
      break;
    case "share": {
      const [key, value, ...pis] = rest;
      if (key === undefined || value === undefined) {
        client.log("usage: share KEY VALUE [PI...]");
        break;
      }
      const targets = pis.map(Number);
      if (targets.some((n) => !Number.isInteger(n))) {
        client.log("PI must be an integer");
        break;
      }
      const pi =
        targets.length === 0 ? null : targets.length === 1 ? (targets[0] ?? null) : targets;
      client.share(key, parseValue(value), pi);
      break;
    }
    case "raw": {
      const v = parseValue(restText);
      if (typeof v === "object" && v !== null && !Array.isArray(v)) client.sendUntracked(v);
      else client.log("usage: raw {JSON object}");
      break;
    }
    case "sleep":
      await sleep(Number(rest[0]) || 0);
      break;
    case "wait": {
      const [event, ms] = rest;
      if (event === undefined) {
        client.log("usage: wait EVENT [MS]");
        break;
      }
      const m = await client.waitFor([event], Number(ms) || 60000);
      if (m === null) client.log(`timeout: no ${event}`);
      break;
    }
    case "drop":
      client.drop();
      break;
    case "status":
      console.log(client.status());
      break;
    case "help":
      console.log(HELP);
      break;
    case "quit":
    case "exit":
      return false;
    default:
      client.log(`unknown command '${cmd}' (type help)`);
  }
  return true;
}

async function runScript(client: FakePi, path: string): Promise<boolean> {
  const data: unknown = await Bun.file(path).json();
  if (!Array.isArray(data)) throw new Error(`${path}: the script must be a JSON array`);
  for (const item of data) {
    let line: string;
    if (typeof item === "string") {
      line = item;
    } else if (typeof item === "object" && item !== null && typeof item.cmd === "string") {
      if (typeof item.delay_ms === "number") await sleep(item.delay_ms);
      line = item.cmd;
    } else {
      throw new Error(`${path}: bad script item ${JSON.stringify(item)}`);
    }
    client.log(`script: ${line}`);
    if (!(await runCommand(client, line))) return false;
  }
  return true;
}

async function runStdin(client: FakePi): Promise<void> {
  console.log(HELP);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!(await runCommand(client, line))) return;
      nl = buffer.indexOf("\n");
    }
  }
  if (buffer.trim() !== "") await runCommand(client, buffer);
}

// ---------------------------------------------------------------- auto mode

async function runAuto(client: FakePi, o: Options): Promise<void> {
  const delay = () => sleep(randomInt(o.minMs, o.maxMs));
  for (let run = 1; run <= o.runs; run++) {
    // 1. Get a player.
    if (client.pi === 1) {
      await delay();
      const name = `${NAMES[randomInt(0, NAMES.length - 1)]} ${randomInt(100, 999)}`;
      client.log(`auto run ${run}: register ${name}`);
      client.register(name);
      const r = await client.waitFor(["player_register_ok", "error"]);
      if (r?.event !== "player_register_ok") {
        client.log("auto: register failed, try again later");
        run--;
        await sleep(o.maxMs);
        continue;
      }
    } else {
      if (client.player === null) {
        client.log(`auto run ${run}: wait for player_incoming`);
        await client.waitFor(["player_incoming"], 24 * 3600 * 1000);
      }
      client.log(`auto run ${run}: player ${client.player?.username ?? "?"}`);
    }

    // 2. Play the room.
    await delay();
    if (Math.random() < o.leaveChance) {
      client.log("auto: the player quits");
      client.leave();
      await client.waitFor(["player_leave_ok"]);
      client.player = null;
      continue;
    }
    client.start();
    await delay();
    if (o.shareTo !== undefined) {
      client.share(`from_pi_${client.pi}`, { from_pi: client.pi, run }, o.shareTo);
    }
    await delay();

    // 3. Finish. game_finish_ok can come after game_finish_wait.
    client.finish();
    for (;;) {
      const m = await client.waitFor(["game_finish_ok", "game_finish_wait"], 24 * 3600 * 1000);
      if (m === null || m.event === "game_finish_ok") break;
      client.log(`auto: wait, max_wait ${String(m.max_wait)}`);
    }
    client.player = null;
    client.log(`auto run ${run}: done`);
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const client = new FakePi(o.url, o.pi, o.quiet);
  client.connect();
  process.on("SIGINT", () => {
    client.stop();
    process.exit(0);
  });
  let go = true;
  if (o.script !== undefined) go = await runScript(client, o.script);
  if (go) {
    if (o.auto) await runAuto(client, o);
    else if (o.script === undefined) await runStdin(client);
  }
  // Give the last events time to get an ack.
  await sleep(500);
  client.stop();
  process.exit(0);
}

await main();

export {};
