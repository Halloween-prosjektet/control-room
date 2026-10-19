# Verification of ControlRoomClient

This directory holds a formal check of the connection, authentication, queue and
delivery (seq, ack, unacked) state machine in
`godot/addons/control_room_client/control_room_client.gd`. It also holds an
end-to-end test of the real client against a fake server (`e2e/`).

## Files

- `ControlRoomClient.tla`: TLA+ model of the shipped client, a server with dedupe and a lossy environment.
- `ControlRoomClient.cfg`: TLC, lossy environment, safety including S1, S2, S3, S4'.
- `ControlRoomClientAtLeastOnce.cfg`: TLC, lossy environment, S4' (at-least-once, safety). It replaces the old `ControlRoomClientFindings.cfg` (S4), which failed.
- `ControlRoomClientCoop.cfg`: TLC, cooperative environment, liveness with fairness (also: every event is eventually received and acked).
- `ControlRoomClientFlaky.cfg`: TLC, cooperative network but `send_text` can fail twice (`FLAKY_MAX=2`). Checks that a non-empty queue in CONNECTED drains (`QueueDrains`).
- `ControlRoomClientRecover.cfg`: TLC, cooperative, but the network drops the connection once (`LOSS_MAX=1`) and `send_text` can fail once. Checks that every given event is eventually received by the server and eventually acked (S4' liveness).
- `model_check.py`: independent explicit-state checker for the same model, with 21 mutation tests.
- `e2e/`: end-to-end test. `run.sh` starts `fake_server.ts` (bun) and the real client (godot, headless, `client_test.gd`) for each scenario.

## How to run

    python3 -I verification/model_check.py          # about 5 s, exit code 0 = all pass
    cd verification
    tlc -config $PWD/ControlRoomClient.cfg $PWD/ControlRoomClient.tla
    tlc -config $PWD/ControlRoomClientAtLeastOnce.cfg $PWD/ControlRoomClient.tla
    tlc -config $PWD/ControlRoomClientCoop.cfg $PWD/ControlRoomClient.tla
    tlc -config $PWD/ControlRoomClientFlaky.cfg $PWD/ControlRoomClient.tla
    tlc -config $PWD/ControlRoomClientRecover.cfg $PWD/ControlRoomClient.tla
    bash verification/e2e/run.sh                    # about 3 min, exit code 0 = all pass

Give TLC an absolute path for `-config` and for the `.tla` file. TLC leaves a
`states/` directory. Delete it after a run. `model_check.py` exits with a
non-zero code if a check fails or a mutant survives.

## What the model says about the code

The model follows the shipped `control_room_client.gd`:

- Each event from `send_event` gets a `seq`. In the model, event k has seq k.
- `send_event` sends only if `is_authenticated` is true and `send_queue` is empty and `_send_raw` succeeds. Then the event goes to `unacked`. Otherwise it goes to `send_queue`.
- `_begin_auth_attempt` sends `auth` with `_send_raw`. The result is ignored. `auth` is never in `send_queue` or `unacked`.
- The flush sends `send_queue[0]`. If the send succeeds, it pops the event and appends it to `unacked`. It stops at the first failure.
- `_handle_ack(n)` removes the events with seq <= n from `unacked` and `send_queue`.
- `_on_authenticated` does `send_queue = unacked + send_queue; unacked = []`, then the flush.
- `_flush_queue()` is called in `_on_authenticated` and at the start of every `_process` tick in CONNECTED, before the packets are read.
- The model splits a tick into `TickFlush` (the flush) and `TickConnected` (read one packet, no flush). The model allows more interleavings than gd (a packet read without a flush before it). This is a safe over-approximation.
- The server has a set `received` (the events it accepted). It ignores a seq that it has seen before (dedupe). For each app message that it reads, it may send `ack` with n = the highest n such that all seq <= n are received (cumulative). In the lossy environment it may also send no ack. In the cooperative environment it always sends the ack.
- The lossy channel: a message that `send_text` accepted is lost if the connection drops before the server reads it (`NetDrop`, `ServerRecv` close, `websocket.close()`), or if the socket is already dead. The client keeps such a message in `unacked`. Packets from the server that the client has not read are lost with the connection.

## Results (bounds: AUTH_ATTEMPTS=2, MAX_RETRIES=2, N=2 events)

TLC 2.19, all runs pass:

| Run | Result | States generated | Distinct states | Depth |
|---|---|---|---|---|
| `ControlRoomClient.cfg` (safety + S1, S2, S3, S4' + `StoppedAbsorbing`) | pass, no error | 34536 | 10567 | 30 |
| `ControlRoomClientAtLeastOnce.cfg` (`NoEventLost`, S4') | pass, no error | 34536 | 10567 | 30 |
| `ControlRoomClientCoop.cfg` (invariants + 5 temporal properties, fairness) | pass, no error | 58 | 25 | 12 |
| `ControlRoomClientFlaky.cfg` (invariants + 6 temporal properties incl. `QueueDrains`, fairness) | pass, no error | 158 | 53 | 14 |
| `ControlRoomClientRecover.cfg` (invariants + 6 temporal properties incl. `CoopEventuallyReceived`, `CoopEventuallyAcked`, fairness) | pass, no error | 587 | 273 | 21 |

`model_check.py` (exit code 0, "ALL CHECKS PASSED"):

- Baseline (the shipped code): 10567 reachable states, 31679 transitions, 25 cooperative states, 53 flaky-cooperative states, 273 recover states. The state counts equal the TLC distinct counts of the five runs. All core properties, all liveness checks, and S1, S2, S3, S4' pass.
- Mutation tests: 21 mutants of the baseline. All 21 are killed.

### What is proved (inside the bounds, for the shipped code)

Core safety (invariants, checked on all reachable states):

- `is_authenticated` is true exactly when the state is CONNECTED.
- `websocket` exists exactly in CONNECTING, AUTHENTICATING and CONNECTED.
- `_auth_attempt` never exceeds AUTH_ATTEMPTS, and equals the number of auth attempts on the current connection.
- `_retry_amount` never exceeds MAX_RETRIES.
- STOPPED happens only after MAX_RETRIES+1 consecutive connection losses. Outside STOPPED, `_retry_amount` equals the number of losses since the last authentication.
- No event is lost or duplicated by the client: an event is never in `send_queue` and in `unacked` at the same time, never twice in one of them, and only given events are in them.
- No queued event goes on the wire before authentication.
- Flush liveness (`QueueDrains`, flaky cooperative environment): a non-empty `send_queue` in CONNECTED eventually becomes empty. `model_check.py` checks the same as a graph property (no stuck state, no cycle among such states).
- S1: no app event goes on the wire while the client is not authenticated.
- S2: FIFO. `unacked` and `send_queue` together are in the given order (`unacked` first). The events on the wire are in order. The server accepts the events in the given order without a gap (`received` is a prefix 1..r), also after resends.
- S3: `send_queue` and `unacked` never hold an `auth` message.
- S4' (safety, lossy environment): every given event is in `send_queue`, in `unacked`, or received by the server. So an event leaves the client state only after the server has received it.
- STOPPED is absorbing (TLC temporal property).

Liveness (graph analysis in Python, fairness in TLC):

- No deadlock. Only STOPPED has no move.
- From every reachable state, CONNECTED or STOPPED is reachable. STOPPED is the only absorbing set.
- With a cooperative server and network: STOPPED is never reached, and every fair run reaches and stays in CONNECTED.
- S4' (liveness, at-least-once): in the cooperative environment, every given event is eventually received by the server (`CoopEventuallyReceived`) and eventually acked, so it leaves the client state (`CoopEventuallyAcked`). This also holds when the network drops the connection once and `send_text` fails once (`ControlRoomClientRecover.cfg`). `model_check.py` checks the same as a graph property (`recover` checks).

Mutation tests: the 21 mutants are no reset of `_auth_attempt`, no clearing of
`is_authenticated`, queue flush before auth, two off-by-one errors in
MAX_RETRIES, off-by-one in AUTH_ATTEMPTS, a flush that drops a failed event and
goes on, loss that clears the queue, `websocket` not nulled, no reset of
`_retry_amount`, no STOPPED state, a mutant without the per-tick flush
(`no_tick_flush`, killed by the flush-liveness graph check), four that bring back
old bugs (send when the socket is open but not authenticated (S1), a failed flush
event re-appended to the back (S2), `auth` sent through the queue (S3), a flush
that pops before it sends), and five for the ack protocol:

- `ack_off_by_one`: `_handle_ack` removes seq <= n+1. Killed by S4' (safety) and by S4' liveness.
- `no_requeue`: `unacked` is not moved to `send_queue` on authentication. The lost event is never sent again. Killed by S2 and by S4' liveness (`recover`). The safety check S4' alone cannot see it: the event stays in `unacked`.
- `unacked_clear`: connection loss clears `unacked`. Killed by S4', S2 and S4' liveness.
- `unacked_early`: the event goes to `unacked` before the send, and also to `send_queue` if the send fails. Killed by the no-duplicate check (`NoEventLost`) and by S2.
- `no_seq_inc`: `seq` is not incremented. The server drops all events after the first as duplicates, but acks them. Killed by S4' and by S4' liveness.

The checker kills all of them. S1, S2, S3 and S4' kill their own mutants. For
`no_tick_flush`, TLC also fails `QueueDrains` when `TickFlush` is removed from
`Next` (checked by hand, not a stored cfg). For `no_requeue`, TLC fails
`CoopEventuallyReceived` in `ControlRoomClientRecover.cfg` when `OnAuth` does not
move `unacked` to the queue (checked by hand, not a stored cfg).

## At-least-once delivery (S4')

The protocol has client-to-server acknowledgements. Every event has a `seq`. The
client keeps a sent event in `unacked` until the server sends `ack`. After
each authentication the client sends the `unacked` events again, in front of
the queue. The server ignores a seq that it has seen before. So delivery is
at-least-once on the wire and exactly-once after the dedupe in the server.

Safety (S4', lossy environment): an event leaves the client state only after the
server has received it. Liveness (S4', cooperative or fair-lossy environment):
every given event is eventually received by the server and acked.

The claim holds only if the server follows the rules in the section "Protocol
additions the server must implement". The model checks the client against a
server that follows these rules.

### History: S4 (at-most-once), now closed

Before the ack protocol, the client was at-most-once (S4). If `send_text`
returned OK and the connection dropped before the server read the message, the
event was lost: the client kept no copy and there was no client-to-server
acknowledgement. `ControlRoomClientFindings.cfg` checked "no event lost with the
socket" (`lost = {}`) and failed on purpose. The counterexample was: run, send
`share` (queued), accept, tick, `auth_ok`, tick (the flush sends the event), the
network drops before the server reads it. The new protocol closes this
limit. The old S4 property ("a message accepted by `send_text` is never lost
with the socket") is still not true: such a message can be lost, but the client
keeps a copy and sends it again. The new S4' replaces it. The e2e scenario
`lost_after_send` shows the same case on the real client.

## History: the legacy code (before the repair)

The legacy code had three more findings. An earlier version of `model_check.py`
(`asis` variant, removed when the ack protocol was added; see the git history)
showed them:

1. S1: `send_event` tested only that the socket was open, so events went on the wire in AUTHENTICATING, before `auth_ok`.
2. S2: a new event could pass older queued events, and a failed event in the flush was re-appended to the back (order 2, 1).
3. S3: a failed `auth` send was queued and sent again after `auth_ok`, so the queue could grow.

The repair in the shipped code removes all three.

## Other observations

- `run()` is modelled only from IDLE. A second call to `run()` while connected
  would create a second `WebSocketPeer` without closing the first one.
- In STOPPED, `send_event` still queues events without limit.
- `unacked` and `send_queue` have no size limit. If the server never sends `ack`, `unacked` grows without limit and every reconnect sends all of it again.
- `_next_seq` starts at 1 when the client object is created. If the game process restarts, the new `seq` values start again at 1. A server that keeps the seen seq values for a Pi without a reset drops these events as duplicates (see the server rules below).

## What is NOT covered

- The GDScript is translated by hand. It is not extracted by a tool. A mistake in the translation is possible. The comments in `model_check.py` cite the GDScript function for each transition. The e2e test runs the real client against a fake server for the main flows.
- Godot networking (`WebSocketPeer`) is assumed to behave as the model says: `get_ready_state` changes only in `poll()`, `send_text` can fail or succeed even on a dead socket, `close()` loses unread data (pessimistic).
- Flaky mode fails only app-event sends, not `auth` sends (a lost `auth` with no timer would deadlock the cooperative model). The failure count is bounded (`FLAKY_MAX`), so fairness can force success. The number of network drops in the cooperative environment is bounded (`LOSS_MAX`).
- Timers are abstracted: a timer can expire at any tick. `_retry_delay` and its quadratic growth are not modelled.
- Bounds are small (see above). Larger real values (AUTH_ATTEMPTS=3, MAX_RETRIES=10) are not checked. The logic is the same, but the proof is for the small bounds. With N=2 the model has at most two events: it does not show a case where an ack of a later event covers a gap in a longer sequence.
- The `_process` loop in CONNECTED reads one packet per tick in the model (a sound split of the real loop).
- The server in the TLA+ model is an abstraction of the rules below (dedupe and cumulative ack). The real server code is not checked here.
- `model_check.py` has bounds that only the mutants reach: `AUTH_Q_CAP=1` (auth messages in the queue, mutant `auth_queued`), `INBOX_CAP=6` (acks in the inbox), and a cut-off of states with more than 2N events in `send_queue` and `unacked` (mutant `unacked_early`). The baseline never reaches them, so the state counts equal the TLC counts.
- Liveness in the lossy environment is not claimed: a hostile network can prevent CONNECTED. The claim is only for the cooperative environment and for the fair-lossy environment of `ControlRoomClientRecover.cfg` (a bounded number of drops).
- Parsing of JSON and `event_handler` content are not modelled, except that `player_incoming` causes one acknowledgement event and `ack` calls `_handle_ack`.

## End-to-end test (e2e)

`e2e/run.sh` runs 8 scenarios with the real GDScript client (godot, headless)
against `e2e/fake_server.ts` (bun). In all scenarios the fake server follows the
rules below: it acks (cumulative) and drops a duplicate seq (per Pi, across
connections). A check for all scenarios: the accepted seq values are exactly 1..n
in order, so there is no loss, no duplicate and no reorder after the dedupe.

- `normal`, `early`, `auth2`, `auth3`, `events`, `giveup`: as before (the client also ends with an empty `send_queue` and `unacked` where the server acks).
- `events`: the client sends `player_incoming_ok` and `player_left_ok` with the `id` of the message (as an integer). For a `player_incoming` with no `id`, the ok has no `id`.
- `drop`: the server kills the connection in a stream of 150 events. After the reconnect there is no loss, no duplicate after dedupe, and the order is kept.
- `lost_after_send`: the server reads the event `target`, does not ack it, and kills the connection. The client sends it again after the reconnect. The server sees the known seq, drops it as a duplicate and acks.

## Protocol additions the server must implement

The client needs these rules from the server. The backend README (`backend/README.md`)
has the same rules in the protocol.

1. `seq`: every client event, except `auth`, has an integer `seq` (1, 2, 3, ...). The client numbers its events with one counter. The counter starts at 1 when the client object is created and it does not reset on a reconnect.
2. `ack`: after the server has processed an event, it sends `{"event": "ack", "seq": n}`. The ack is cumulative: it confirms all events with `seq <= n`. The server sets `n` to the highest number such that all seq 1..n are processed (no gap). The server may send one ack for each event, or fewer acks; a later ack covers the earlier events. The client resends every event that it has not seen an ack for.
3. Dedupe: the server keeps the seq values that it has seen for each Pi, across connections. If it gets an event with a seq that it has seen before, it does not process the event again. It sends the ack again. This is necessary: after a reconnect, the client sends again every event without an ack, also events that the server has already processed (the ack was lost).
4. The server must process the events of one Pi in `seq` order. The client sends them in order, also on resend, so a server that reads each connection in order does this.
5. `auth`: the client sends `{"event": "auth", "pi": n}` without a `seq`, and it does not send it again from a queue. The server answers `auth_ok`. The client sends no app event before `auth_ok`. After `auth_ok`, it sends the unacked events again.
6. `error.event_name`: an `error` message has `"event": "error"`. The name of the event that failed is in `event_name`, not in `event`. The client reads `event_name` and gives it to the signal `server_error(code, message, event)`.
7. Seq reset: if a game process restarts, the client counter starts again at 1. The server needs a way to know this (for example a new session id, or a reset when the Pi is idle). The current rules have no such way: see "Other observations".
8. Old clients (no `seq`): the server processes each such event and sends no ack.
9. `id` on `player_incoming` and `player_left`: the server puts a unique integer `id` (the outbox message id) in each `player_incoming` and `player_left`. The server can send the same message more than one time (after a reconnect, and by timer). The client sends one ok for each copy that it gets, with the same `id`. The server removes only the outbox message with that `id`. An ok for an unknown `id`, or for a message that the server removed before, has no effect (the server still acks its `seq`). Thus a late or duplicate ok cannot remove a newer message. An ok with no `id` (old client) removes the oldest open message of that event for the Pi.
