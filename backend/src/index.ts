// Entry point. Connects the parts:
//
//   WebSocket frame -> connections.ts (auth, buffer) -> ControlRoom.process()
//     -> game.step() -> db.applyEffects() (one transaction) -> sends -> outbox.ts
//
// HTTP requests go to http.ts. The WebSocket path is "/".
//
// Order for each input (contract in game.ts):
// 1. step() gives the new state and the effects.
// 2. applyEffects() writes the db effects in one transaction. If it fails, the
//    state stays as before and nothing is sent (the client sends the event again,
//    because it gets no ack).
// 3. The "send" effects go to the open connections, in order.
// 4. The new outbox entries go to outbox.ts, which writes them and then calls
//    process({type: "outbox_sent"}).

import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { type Config, loadConfig } from "./config.ts";
import { type ConnData, Connections, newConnData } from "./connections.ts";
import { applyEffects, createQueries, getSession, loadState, openDb, setSession } from "./db.ts";
import { type Input, type State, type StepOptions, step } from "./game.ts";
import { createHttpHandler } from "./http.ts";
import { Outbox } from "./outbox.ts";
import { FEATURE_GAME_FINISH_ACK, msg, type PiId } from "./protocol.ts";

export type LogLevel = "info" | "warn" | "error";
export type Logger = (level: LogLevel, message: string) => void;

export const consoleLogger: Logger = (level, message) => {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  if (level === "info") console.log(line);
  else console.warn(line);
};

export interface ServerOptions {
  log?: Logger;
  /** Clock (epoch ms). Default: Date.now. */
  now?: () => number;
  /** Makes a player_id. Default: crypto.randomUUID. */
  newId?: () => string;
}

/** The control room: state, database, connections and outbox. No HTTP server. */
export class ControlRoom {
  state: State;
  readonly connections: Connections;
  readonly outbox: Outbox;
  private readonly stepOptions: Partial<StepOptions>;
  private readonly log: Logger;
  private readonly now: () => number;
  /**
   * F8: Pis whose current client acks game_finish_ok (auth feature "game_finish_ack").
   * For the other Pis the server removes game_finish_ok after one send (old clients).
   * Each auth sets the value again, before the outbox is sent again.
   */
  private readonly finishAckPis = new Set<PiId>();

  constructor(
    readonly db: Database,
    readonly config: Config,
    options: ServerOptions = {},
  ) {
    this.log = options.log ?? consoleLogger;
    this.now = options.now ?? Date.now;
    this.stepOptions = {
      defaultRoomMs: config.defaultRoomMs,
      tzName: config.tzName,
      ...(options.newId ? { newId: options.newId } : {}),
    };
    this.state = loadState(db);
    this.connections = new Connections({
      onAuth: (pi, session, features) => this.onAuth(pi, session, features),
      onMessage: (pi, text) => this.process({ type: "message", pi, text }),
      log: (level, message) => this.log(level, message),
    });
    this.outbox = new Outbox({
      entries: () => this.state.outbox,
      send: (pi, m) => this.connections.send(pi, m),
      isReady: (pi) => this.connections.isReady(pi),
      sent: (ids) =>
        this.process({ type: "outbox_sent", ids, finishAckPis: [...this.finishAckPis] }),
      now: this.now,
      retryMs: config.ackRetryMs,
    });
  }

  /** Runs one input through the state machine and persists the result. */
  process(input: Input, extra?: () => void): boolean {
    const r = step(this.state, input, this.now(), this.stepOptions);
    try {
      applyEffects(this.db, r.effects, extra);
    } catch (err) {
      this.log("error", `database write failed for ${input.type}; input dropped: ${String(err)}`);
      return false;
    }
    this.state = r.state;
    const added: number[] = [];
    for (const e of r.effects) {
      if (e.type === "log") this.log(e.level, e.message);
      else if (e.type === "send") this.connections.send(e.pi, e.msg);
      else if (e.type === "outbox_add") added.push(e.entry.id);
    }
    if (added.length > 0) this.outbox.deliver(added);
    return true;
  }

  /** 8.1: a valid auth. Session rule, features, then auth_ok, then the outbox again. */
  private onAuth(pi: PiId, session: string | undefined, features: readonly string[]): void {
    if (features.includes(FEATURE_GAME_FINISH_ACK)) this.finishAckPis.add(pi);
    else this.finishAckPis.delete(pi);
    if (session !== undefined && getSession(this.db, pi) !== session) {
      this.log("info", `pi ${pi}: new client session ${session}; seq reset`);
      this.process({ type: "reset_seq", pi }, () => setSession(this.db, pi, session));
    }
    this.connections.send(pi, msg.authOk());
    this.outbox.resendAll(pi);
  }
}

export interface RunningServer {
  server: Server<ConnData>;
  room: ControlRoom;
  port: number;
  /** Stops the HTTP server, closes all connections, stops the timer and closes the database. */
  stop(): Promise<void>;
}

export function startServer(config: Config, options: ServerOptions = {}): RunningServer {
  const db = openDb(config.dbPath);
  const room = new ControlRoom(db, config, options);
  const http = createHttpHandler(
    createQueries(db, config.tzName, { connectedPis: () => room.connections.connectedPis() }),
  );
  let stopped = false;

  const server = Bun.serve<ConnData>({
    port: config.port,
    hostname: config.host,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (srv.upgrade(req, { data: newConnData() })) return undefined;
        return Response.json({ error: "upgrade_failed" }, { status: 400 });
      }
      return (
        http(req) ??
        Response.json(
          { error: "not_found", message: "use a WebSocket on this path" },
          { status: 404, headers: { "Access-Control-Allow-Origin": "*" } },
        )
      );
    },
    websocket: {
      open: (ws) => {
        if (!stopped) room.connections.open(ws);
      },
      message: (ws, data) => {
        if (!stopped) room.connections.message(ws, data);
      },
      close: (ws, code, reason) => {
        room.connections.close(ws, code, reason);
      },
    },
  });
  room.outbox.start();

  return {
    server,
    room,
    port: server.port ?? config.port,
    async stop() {
      if (stopped) return;
      stopped = true;
      room.outbox.stop();
      room.connections.closeAll();
      await server.stop(true);
      db.close();
    },
  };
}

if (import.meta.main) {
  const config = loadConfig();
  const running = startServer(config);
  consoleLogger(
    "info",
    `control room server on http://${running.server.hostname}:${running.port} (db ${config.dbPath})`,
  );
  const shutdown = () => {
    consoleLogger("info", "stopping");
    void running.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
