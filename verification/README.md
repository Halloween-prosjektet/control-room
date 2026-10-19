# Verification of ControlRoomClient

This directory holds a formal check of the connection, authentication and
queue state machine in
`godot/addons/control_room_client/control_room_client.gd`.

## Files

- `ControlRoomClient.tla`: TLA+ model of the shipped client plus a lossy environment.
- `ControlRoomClient.cfg`: TLC, lossy environment, safety including S1, S2, S3.
- `ControlRoomClientCoop.cfg`: TLC, cooperative environment, liveness with fairness.
- `ControlRoomClientFlaky.cfg`: TLC, cooperative network but `send_text` can fail twice (`FLAKY_MAX=2`). Checks that a non-empty queue in CONNECTED drains (`QueueDrains`), plus S1, S2, S3.
- `ControlRoomClientFindings.cfg`: TLC, expected to FAIL. It checks S4 (accepted protocol limit, see below).
- `model_check.py`: independent explicit-state checker for the same model, with mutation tests. It also keeps the legacy `asis` model (the code before the repair) as a reference.

## How to run

    python3 -I verification/model_check.py          # about 3 s, exit code 0 = all pass
    cd verification
    tlc -config $PWD/ControlRoomClient.cfg $PWD/ControlRoomClient.tla
    tlc -config $PWD/ControlRoomClientCoop.cfg $PWD/ControlRoomClient.tla
    tlc -config $PWD/ControlRoomClientFlaky.cfg $PWD/ControlRoomClient.tla
    tlc -config $PWD/ControlRoomClientFindings.cfg $PWD/ControlRoomClient.tla   # must FAIL (S4)

Give TLC an absolute path for `-config` and for the `.tla` file.

## What the model says about the code

The model follows the shipped `control_room_client.gd`:

- `send_event` sends only if `is_authenticated` is true and `send_queue` is empty and `_send_raw` succeeds. Otherwise it appends the event to `send_queue`.
- `_begin_auth_attempt` sends `auth` with `_send_raw`. The result is ignored. `auth` is never in `send_queue`.
- The flush in `_on_authenticated` sends `send_queue[0]` and pops it only if the send succeeds. It stops at the first failure.
- `_flush_queue()` is called in `_on_authenticated` and at the start of every `_process` tick in CONNECTED, before the packets are read. So a queue that is left after a failed flush drains at the next tick.
- The model splits a tick into `TickFlush` (the flush) and `TickConnected` (read one packet, no flush). The model allows more interleavings than gd (a packet read without a flush before it). This is a safe over-approximation.

## Results (bounds: AUTH_ATTEMPTS=2, MAX_RETRIES=2, N=2 events)

TLC 2.19:

| Run | Result | States generated | Distinct states | Depth |
|---|---|---|---|---|
| `ControlRoomClient.cfg` (safety + S1, S2, S3 + `StoppedAbsorbing`) | pass, no error | 19291 | 5814 | 28 |
| `ControlRoomClientCoop.cfg` (invariants + 3 temporal properties, fairness) | pass, no error | 44 | 21 | 10 |
| `ControlRoomClientFlaky.cfg` (invariants + S1, S2, S3 + 4 temporal properties incl. `QueueDrains`, fairness) | pass, no error | 107 | 39 | 12 |
| `ControlRoomClientFindings.cfg` (S4) | fails, as expected | 880 | 383 | counterexample of 8 states |

`model_check.py` (exit code 0, "ALL CHECKS PASSED"):

- Variant `fixed` (the shipped code): 5814 reachable states, 17759 transitions, 21 cooperative states, 39 flaky-cooperative states. The state counts equal the TLC counts. All core properties, all liveness checks, and S1, S2, S3 pass. S4 is violated, as expected (accepted limit).
- Variant `asis` (legacy code, reference only): 46077 reachable states, 142514 transitions, 39 coop states. Core properties pass. S1, S2, S3 and S4 are violated.
- Mutation tests: 16 mutants of `fixed`. All 16 are killed.

TLC leaves a `states/` directory. Delete it after a run.

### What is proved (inside the bounds, for the shipped code)

Core safety (invariants, checked on all reachable states):

- `is_authenticated` is true exactly when the state is CONNECTED.
- `websocket` exists exactly in CONNECTING, AUTHENTICATING and CONNECTED.
- `_auth_attempt` never exceeds AUTH_ATTEMPTS, and equals the number of auth attempts on the current connection.
- `_retry_amount` never exceeds MAX_RETRIES.
- STOPPED happens only after MAX_RETRIES+1 consecutive connection losses. Outside STOPPED, `_retry_amount` equals the number of losses since the last authentication.
- No event is lost or duplicated by the client: each event given to `send_event` is in `send_queue` or was accepted by `send_text`, never both.
- No queued event goes on the wire before authentication.
- Flush liveness (`QueueDrains`, flaky cooperative environment): a non-empty `send_queue` in CONNECTED eventually becomes empty. `model_check.py` checks the same as a graph property (no stuck state, no cycle among such states).
- S1: no app event goes on the wire while the client is not authenticated.
- S2: FIFO. Events leave in the order given. `send_queue` holds only later events than the events already sent.
- S3: `send_queue` never holds an `auth` message.
- STOPPED is absorbing (TLC temporal property).

Liveness (graph analysis in Python, fairness in TLC):

- No deadlock. Only STOPPED has no move.
- From every reachable state, CONNECTED or STOPPED is reachable. STOPPED is the only absorbing set.
- With a cooperative server and network: STOPPED is never reached, and every fair run reaches and stays in CONNECTED.

Mutation tests: the 16 mutants are no reset of `_auth_attempt`, no clearing of
`is_authenticated`, queue flush before auth, two off-by-one errors in
MAX_RETRIES, off-by-one in AUTH_ATTEMPTS, a flush that drops a failed event and
goes on, loss that clears the queue, `websocket` not nulled, no reset of
`_retry_amount`, no STOPPED state, a mutant without the per-tick flush (`no_tick_flush`, killed by the flush-liveness graph check), and four that bring back the old bugs:
send when the socket is open but not authenticated (S1), a failed flush event
re-appended to the back (S2), `auth` sent through the queue (S3), and a flush
that pops before it sends (event lost). The checker kills all of them. S1, S2
and S3 kill their own mutant. For `no_tick_flush`, TLC also fails `QueueDrains` when `TickFlush` is removed from `Next` (checked by hand, not a stored cfg).

## Accepted protocol limit (S4)

**At-most-once delivery (S4).** If `send_text` returns OK and the connection
drops before the server reads the message, the event is lost. The client keeps
no copy. There is no client-to-server acknowledgement. The server outbox
(PLAN 8.10) covers only server-to-client messages. To close S4, the protocol
needs acknowledgements from the server to the client. This is outside the
client. `ControlRoomClientFindings.cfg` shows the counterexample: run, send
`share` (queued), accept, tick, `auth_ok`, tick (flush sends the event), the
network drops before the server reads it.

## History: the legacy code (before the repair)

The legacy code had three more findings. The `asis` variant in `model_check.py`
still shows them, as a reference:

1. S1: `send_event` tested only that the socket was open, so events went on the wire in AUTHENTICATING, before `auth_ok`.
2. S2: a new event could pass older queued events, and a failed event in the flush was re-appended to the back (order 2, 1).
3. S3: a failed `auth` send was queued and sent again after `auth_ok`, so the queue could grow.

The repair in the shipped code removes all three.

## Other observations

- `run()` is modelled only from IDLE. A second call to `run()` while connected
  would create a second `WebSocketPeer` without closing the first one.
- In STOPPED, `send_event` still queues events without limit.

## What is NOT covered

- The GDScript is translated by hand. It is not extracted by a tool. A mistake in the translation is possible. The comments in `model_check.py` cite the GDScript function for each transition.
- Godot networking (`WebSocketPeer`) is assumed to behave as the model says: `get_ready_state` changes only in `poll()`, `send_text` can fail or succeed even on a dead socket, `close()` loses unread data (pessimistic).
- Flaky mode fails only app-event sends, not `auth` sends (a lost `auth` with no timer would deadlock the cooperative model). The failure count is bounded (`FLAKY_MAX`), so fairness can force success.
- Timers are abstracted: a timer can expire at any tick. `_retry_delay` and its quadratic growth are not modelled.
- Bounds are small (see above). Larger real values (AUTH_ATTEMPTS=3, MAX_RETRIES=10) are not checked. The logic is the same, but the proof is for the small bounds.
- The `_process` loop in CONNECTED reads one packet per tick in the model (a sound split of the real loop).
- The server is a nondeterministic environment. The real server code is not checked.
- `model_check.py` has a bound `AUTH_Q_CAP=1`. It is used only by the legacy `asis` variant and the `auth_queued` mutant, where `auth` can enter the queue. The TLA+ model does not need it.
- Liveness in the lossy environment is not claimed: a hostile network can prevent CONNECTED. The claim is only for the cooperative environment.
- Parsing of JSON and `event_handler` content are not modelled, except that `player_incoming` causes one acknowledgement event.
