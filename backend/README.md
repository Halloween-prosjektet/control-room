# Control room server

This server controls the flow of players through the five rooms. It uses
TypeScript and Bun. It has no runtime dependencies. The full plan is in
`../docs/PLAN.md`.

Status: the server is complete (plan steps 1 to 9). The WebSocket, the state
machine, SQLite, the outbox and the HTTP endpoints have tests. Step 10 (a test
with the Godot example) is not done.

## Parts

| File | Function |
| --- | --- |
| `src/index.ts` | Starts `Bun.serve` (WebSocket on `/`, HTTP on the other paths). Connects the parts. |
| `src/connections.ts` | Map from Pi to the open WebSocket. Auth, pre-auth buffer, close codes. |
| `src/game.ts` | The room state machine. Pure logic. The header comment gives the effect contract. |
| `src/db.ts` | SQLite schema, migrations, `applyEffects`, `loadState`, the queries for HTTP. |
| `src/outbox.ts` | Sends outbox messages, and sends them again until the Pi acks them. |
| `src/http.ts` | `GET /leaderboard`, `GET /leaderboard/:player_id`, `GET /state`, `GET /health`. |
| `src/queries-interface.ts` | The interface between `db.ts` and `http.ts`. |
| `src/protocol.ts`, `src/time.ts`, `src/config.ts` | Messages, timestamps, configuration. |
| `tools/fake-pi.ts` | A command-line Pi for manual tests. |

For each message from a Pi, the server:

1. Gives the message to `game.step()`. The result is the new state and a list
   of effects.
2. Writes all database effects in one SQLite transaction.
3. Sends the replies (the `ack` is the last reply). If the write fails, the
   server sends nothing, and the client sends the event again.
4. Gives the new outbox messages to `outbox.ts`.

At start, the server rebuilds the state from SQLite. Then it sends the outbox
messages again when each Pi authenticates.

## Commands

Do these commands in the `backend/` directory.

| Command | Result |
| --- | --- |
| `bun install` | Installs the dev dependencies (Biome, bun-types). |
| `bun start` | Starts the server. |
| `bun run dev` | Starts the server. Starts it again when a file changes. |
| `bun test` | Runs all tests. |
| `bun run check` | Runs Biome (format and lint) and `tsc --noEmit`. `tsc` must be installed on the computer. |

## Configuration

The server reads these environment variables. If a value is not valid, the
server does not start.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `7321` | Port for WebSocket and HTTP. |
| `HOST` | `0.0.0.0` | Address to listen on. |
| `DB_PATH` | `./data/control-room.sqlite` | SQLite file. |
| `LOG_FILE` | `./data/server.log` | File that gets a copy of each log line (appended). `off` = no file. |
| `ACK_RETRY_MS` | `2000` | Time between two sends of an outbox message. |
| `DEFAULT_ROOM_MS` | `300000` | Room time estimate when no run has completed the room. The server uses it for `max_wait`. |
| `TZ_NAME` | `Europe/Oslo` | Time zone for the timestamps that the server sends. |

## Delivery rules

These rules are added to the protocol in the plan. The Godot client uses them.

- Each client event, except `auth`, has an integer `seq`. The `seq` of a Pi
  increases for each event.
- After the server processes an event, it sends `{"event":"ack","seq":n}`. The
  ack is for all events with `seq` less than or equal to `n`.
- If the server gets an event with a `seq` that it processed before, it ignores
  the event. It sends the ack again.
- An event with no `seq` (old client) is processed each time. It gets no ack.
- An `error` message has `"event": "error"`. The name of the failing event is in
  `event_name`.
- The `auth` message can have a `session` string (1 to 128 characters). The
  Godot client makes a new random session each time the app starts. If the
  session is different from the stored session of that Pi, the server sets the
  last `seq` of the Pi to 0 and stores the new session. If the session is the
  same (a new connection of the same app start), the server keeps the last
  `seq`. If `auth` has no `session`, the server keeps the last `seq`.
- `player_incoming` and `player_left` have an integer `id`. The `id` is the id
  of the outbox message. The server can send the same message (with the same
  `id`) more than one time. The client sends `player_incoming_ok` or
  `player_left_ok` for each copy that it gets, with the same `id`.
- When the server gets an ok with `id`, it removes only the outbox message with
  that `id` (for that Pi and that event). If no such message is open (unknown
  `id`, or the server removed it before), the ok has no effect. The server
  still acks the `seq` of the ok. If `id` is not a positive integer, the server
  replies `error` with code `bad_request`.
- An ok with no `id` (old client) removes the oldest open message of that
  event for the Pi. For `player_incoming_ok` with no `id`, the server first
  ignores one ok for each sent `player_incoming` that it removed because the
  player quit (`stale_incoming_oks`). An ok with `id` sets this count to 0.
- At start, the server adds the `id` to an outbox message from an older server
  version that has no `id`.

### Player check (design finding F2)

- `game_start`, `game_finish`, `player_leave` and `share` can have `username`:
  the player that the Pi shows. The server removes the spaces at the start and
  at the end, as for `player_register`. If `username` is not a string with 1 to
  64 characters, the server replies `error` with code `bad_request`. `null` is
  the same as no `username`.
- `game_start` and `game_finish`: if the run in the room has a different
  username, the server replies `error` with code `wrong_player` and changes
  nothing.
- `player_leave` and `share`: Pi N can mean the run in room N, or the run that
  left room N and is `incoming` in room N+1. The server uses the run with that
  username. If no run of these two has that username, the server replies
  `error` with code `wrong_player` and changes nothing. For `player_leave` with
  no such run at all, the reply is `player_leave_ok` (a repeated message).
- With no `username` (old client), the server uses the rules of the plan.
- The server acks the `seq` of an event that gets `wrong_player`.

### Stale messages and late shares (F3, F5)

- `game_start` in room M removes the open `player_incoming` of that run for
  Pi M. If the server sent it, a late `player_incoming_ok` with no `id` from an
  old client can still come: the server adds 1 to `stale_incoming_oks`.
- When the server stores a share, it builds `player_data` again for each open
  `player_incoming` of the run. Thus each later send (also a resend and a send
  after a restart) has the current data. A share that comes after
  `game_finish`, but before Pi N+1 reads `player_incoming`, gets to Pi N+1. If
  Pi N+1 read an earlier copy, it ignores the new copy (same `id`), and the
  share does not get to that Pi. A share for a room that the run passed is
  stored and logged only.

### `game_finish_ok` with an ack (F8)

- `game_finish_ok` has `id` (the outbox message id) and `username`.
- The `auth` message can have `features`, a list of strings. A client with
  `"game_finish_ack"` in `features` replies `{"event":"game_finish_ack","id":n}`
  to each copy of `game_finish_ok`. The server sends `game_finish_ok` again
  (each `ACK_RETRY_MS`, and after each `auth_ok`) until it gets this ack. Only
  the message with that `id` is removed. `game_finish_ack` with no valid `id`
  gets `error` with code `bad_request`.
- Old clients (no `features`): the server removes `game_finish_ok` after one
  send, as before. Thus an old client gets each `game_finish_ok` one time, but
  it can lose it if the connection breaks.
- Each `auth` sets the feature of the Pi again. The server keeps it in memory
  only (a restart needs a new `auth` before a send).

### Client rules (F6)

The Godot client, `refrence.py`, `test/pi-client.ts` and `tools/fake-pi.ts`:

- send `username` (the current player, when known) in `game_start`,
  `game_finish`, `player_leave` and `share`;
- send `features: ["game_finish_ack"]` in `auth`, and `game_finish_ack` for
  each copy of `game_finish_ok` that has an `id`;
- reply to each copy of `player_incoming`, `player_left` and `game_finish_ok`,
  but do the action and emit the signal one time only for each message (same
  event, `id` and `username`);
- ignore `player_left` for another player than the current player;
- ignore `game_finish_ok` for another player than the current player (when the
  current player is known).

## Connections

- The server sends `auth_ok` for each valid `auth`. Then it sends all outbox
  messages of that Pi again. Then it processes the messages that came before
  `auth` (max 100 for each connection, in order).
- If `pi` in `auth` is not valid, the server sends no reply and closes the
  connection with code 4001.
- If a Pi connects again while its old connection is open, the server closes the
  old connection with code 4000.
- The server does not close an authenticated connection because of a bad
  message. It replies `error`.

## Database

The schema is the schema in plan section 9, with these additions:

| Table | Addition |
| --- | --- |
| `room_slots` | `notified` (0 or 1): the Pi of the room possibly knows the player. |
| `outbox` | `player_id` (the run of the message) and `sent` (0 or 1). The `sent` mark is persisted, so a restart keeps the rule "send `player_left` only if `player_incoming` was sent" (F4). |
| `pi_delivery` | New table: `pi`, `last_seq`, `stale_incoming_oks`, `session`. |

Times are ISO 8601 text in UTC. The HTTP endpoints write times in `TZ_NAME`.
`schema_version` has the version. The server runs the missing migrations at
start. It does not start with a database from a newer server.

## Tests

| File | Covers |
| --- | --- |
| `test/game.test.ts`, `test/game.property.test.ts` | The state machine. |
| `test/findings.test.ts` | The design findings F2 to F8 of `../verification/server/README.md` (also across a restart). |
| `test/db.test.ts` | Schema, transactions, "a restart gives the same state", leaderboard queries. |
| `test/http.test.ts` | The HTTP endpoints. |
| `test/server.test.ts` | The real server on a random port with five clients that act like the Godot client (`test/pi-client.ts`). It includes a soak test: 20 runs with random disconnects. |

To run the soak test with more seeds: `SOAK_SEEDS=40 bun test test/server.test.ts -t soak`.
