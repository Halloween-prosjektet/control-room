# Verification of the server room pipeline (docs/PLAN.md section 8)

This directory holds a formal model of the room pipeline that `docs/PLAN.md`
section 8 specifies: room slots, register, start, finish, wait, the hand-over
chain, share, player quits, and the outbox with acknowledgements. The model
also includes what section 9 persists, a server restart, Pi disconnects, lost
acks and duplicate deliveries.

Summary: the plan as written has eight real flaws (F1 to F8 below; F1b is a
second path to F1) and the plan client has one more (F9). Three of them stop
the pipeline permanently (F1/F1b, F8, F9). Two apply an event to the wrong
player (F2, F7). The others lose share data or show an old player on a Pi
(F3, F4, F5, F6). With seven repairs (switches `FIX_*` and `PI_*` in the
model) and no duplicated Pi events (the F7 repair, not modelled), TLC and the
independent Python checker find no violation of any property in all bounds
that we checked.

## Files

| File | Content |
| --- | --- |
| `ControlRoomServer.tla` | TLA+ model. The switches `FIX_*` and `PI_*` turn on the repairs. All switches FALSE = the plan as written. |
| `Server*.cfg` | TLC configurations for the repaired design. Each must pass. |
| `Find_*.cfg` | TLC configurations for the plan with one repair removed. Each must FAIL. They give the counterexamples in "Findings". |
| `check_design.py` | Independent explicit-state checker (Python, no imports outside the standard library). It does not read the TLA+ file. |

## How to run

    python3 -I verification/server/check_design.py      # about 2 minutes, exit code 0 = pass
    cd verification/server
    tlc -workers auto -config $PWD/ServerSmall.cfg $PWD/ControlRoomServer.tla
    # ... the same for each .cfg file. Give TLC absolute paths.

TLC writes a `states/` directory. Delete it after a run.

## The model

One server step is one event in one SQLite transaction (section 9).

| Part | Variables |
| --- | --- |
| Persisted (survives a restart) | `slot`, `lastLeft`, `status`, `started`, `fin` (rooms with a room time), `shares` (target and source Pi of each key), `outbox`, `nextId` |
| Volatile (lost at a restart) | `conn`, `cursor` (highest outbox id sent on this connection), `sent` (the "sent one or more times" mark of 8.9.6) |
| Network | `up[pi]`: FIFO from Pi to server (the client `send_queue` and the socket). `down[pi]`: FIFO from server to Pi. A disconnect or restart empties `down`. |
| Pi | `view[pi]` (player that the Pi shows), `ps[pi]` (idle, ready, play, fin), `seen[pi]` (highest player_incoming id, for the repaired client) |
| Ghost | `entered`, `got`, `gsent`, `quit`, `pstart`, `bad` (flags for event-level properties), bound counters |

Environment actions:

- Honest Pis: Pi 1 registers new players. A Pi starts and finishes the player
  that it shows. A player can quit at any time at the Pi where the player is
  (also when the player is `incoming` at the next Pi, or after `game_finish`
  before the next Pi starts). Pis send shares during the game (and after
  `game_finish` in the plan).
- The Pi acks each `player_incoming` and `player_left` that it reads, also a
  resent copy, as `control_room_client.gd` does.
- The server sends new outbox messages, and resends all unacked messages
  (`ACK_RETRY_MS`). The model does a resend when the Pi has read the previous
  copies.
- Faults (bounded): lost ack (`MAX_DROPS`), lost request (`DROP_REQUESTS`),
  Pi disconnect (`MAX_DISC`), server restart (`MAX_RESTARTS`), duplicated Pi
  message (`MAX_DUPS`), arbitrary Pi message (`ARBITRARY`, `MAX_JUNK`).

## Properties

Safety (invariants, checked in every reachable state):

| Name | Statement |
| --- | --- |
| `OneRoomPerRun`, `SlotWellFormed` | Max one run in each room. A run is in max one room. |
| `InOrder`, `EnterStep` | A run enters rooms 1, 2, ..., 5 in this order, one step at a time (action property). |
| `OnlyActiveInRooms` | Only `active` runs have a room. |
| `WaitingNextBusy` | A run is `waiting` only when the next room is not empty. |
| `NoHandoverToBusy` | No hand-over to a room that is not empty. |
| `CompletedAllTimes`, `TimesConsistent` | A completed run has start and finish times for all rooms. |
| `LeftNeverCompleted` | `completed` and `left` never change. A left run never becomes completed and the reverse. |
| `OutboxLive` | `player_incoming` refers to an `active` run, `player_left` to a `left` run. |
| `OutboxCurrent` | `player_incoming` for Pi M refers to the run that is `incoming` in room M now. |
| `LeftOnlyIfSent` | `player_left` is only queued if `player_incoming` was sent. |
| `LeftQueuedIfReceived` | If Pi M got `player_incoming` and the run quits, `player_left` is queued. |
| `NoShareToPassedRoom`, `NoStaleAdopt` | A Pi never takes a `player_incoming` (with or without shares) for a run that already passed its room. |
| `DataExact` | `player_data` for room M = the keys of the run that target M (or null) and that come from a Pi before M. |
| `NoMisapply` | The server never applies start, finish, leave or share to another run than the player at that Pi. |
| `NoPhantomRun` | A repeated message never makes a second run. |
| `AckOnlyDelivered` | An ack never removes a `player_incoming` that the Pi did not get. |
| `LeftOnlyForOwn` | `player_left` never clears another player at the Pi. |
| Deadlock | Only the final state (all runs done, all queues empty) has no next step. |

Liveness (with `FairSpec`: weak fairness on server receive, server send,
resend, reconnect, Pi read, start and finish. No fairness on register, quit,
share, disconnect, restart and loss. Disconnects and restarts are bounded, so
"fair reconnect" holds):

| Name | Statement |
| --- | --- |
| `RunsEndEA` | Each run that is not left eventually completes (no run stays `active`). |
| `NoWaitEA` | A waiting run eventually moves on. |
| `OutboxEmptyEA` | Each outbox message is eventually delivered and acked, or deleted. |
| `NoGhostEA` | No Pi shows a left player for ever. |

TLC checks the "eventually always" forms. In this bounded model they imply the
leads-to forms (`RunsEnd`, `WaitingMovesOn`, `OutboxDrains`, `GhostCleared`
in the .tla file). `check_design.py` checks the leads-to forms directly
(Python SCC analysis with weak fairness, stutter steps included).

## Results

TLC 2.19, `-workers auto`. "pass" = no error.

Repaired design (all `FIX_*` and `PI_*` TRUE). All configurations use
`MAX_UP = 1` (one message in flight from each Pi), one key, and check all
invariants and `EnterStep` (`ServerArbitrary.cfg`: only the invariants that
must hold for any client; no deadlock check).

| Configuration | Rooms, runs | Environment | Result | Distinct states | Depth | Time |
| --- | --- | --- | --- | --- | --- | --- |
| `ServerSmall.cfg` | 3, 2 | quits, resends, 1 lost ack | pass | 817,700 | 67 | 9 s |
| `ServerShareSmall.cfg` | 3, 2 | quits, 1 share (null, [3], [1,3]) | pass | 293,380 | 63 | 3 s |
| `ServerArbitrary.cfg` | 3, 2 | quits, 1 arbitrary Pi message (any event, any name, any ack id) | pass | 2,252,079 | 63 | 26 s |
| `ServerLossy3.cfg` | 3, 2 | quits, resends, 1 share, 1 lost ack | pass | 10,580,612 | 69 | 2 min 12 s |
| `ServerFaults3.cfg` | 3, 2 | quits, resends, 1 restart, 1 Pi disconnect, 1 lost ack | pass | 16,104,286 | 73 | 3 min 49 s |
| `ServerCore5.cfg` | 5, 3 | no quits, no faults, no resends (waits and full chains) | pass | 4,462,918 | 140 | 1 min 44 s |
| `ServerLeave5.cfg` | 5, 2 | quits in all states | pass | 3,319,678 | 99 | 54 s |
| `ServerShare5.cfg` | 5, 2 | quits, 1 share (null) | pass | 26,984,328 | 101 | 9 min 15 s |
| `ServerLiveSmall.cfg` (liveness) | 3, 2 | quits, resends | pass | 350,020 | 67 | 2 min 26 s |
| `ServerLive3.cfg` (liveness) | 3, 3 | quits, no resends | pass | 580,484 | 90 | 4 min 36 s |
| `ServerLiveRestart.cfg` (liveness) | 3, 2 | quits, 1 restart, no resends | pass | 902,033 | 71 | 6 min 20 s |
| `ServerLive5.cfg` (liveness) | 5, 2 | no quits, no resends | pass | 226,052 | 95 | 1 min 50 s |

The plan with one repair removed (expected to fail):

| Configuration | Result | Distinct states | Trace length |
| --- | --- | --- | --- |
| `Find_Plan.cfg` (all repairs off) | FAIL `DataExact` (F5 is the shortest) | 76 | 9 |
| `Find_F1_AckByType.cfg` | FAIL `AckOnlyDelivered` | 1,642 | 19 |
| `Find_F1b_DuplicateAck.cfg` | FAIL `AckOnlyDelivered` | 6,922 | 26 |
| `Find_F2_LeaveWithoutName.cfg` | FAIL `NoMisapply` | 2,886 | 25 |
| `Find_F3_StaleIncoming.cfg` | FAIL `OutboxCurrent` | 332 | 13 |
| `Find_F4_SentVolatile.cfg` | FAIL `LeftQueuedIfReceived` | 879 | 13 |
| `Find_F5_ShareAfterFinish.cfg` | FAIL `DataExact` | 136 | 10 |
| `Find_F6_LeftClearsOther.cfg` | FAIL `NoStaleAdopt` | 2,759 | 17 |
| `Find_F7_DuplicateMessage.cfg` | FAIL `NoMisapply` | 971 | 16 |
| `Find_F8_FinishOkLost.cfg` | FAIL deadlock | 5,461 | 18 |
| `Find_F9_LostRequest.cfg` | FAIL deadlock | 95 | 9 |

`check_design.py` (exit code 0, "ALL CHECKS PASSED", about 2 minutes):

    [fixed/small]     states=817700  edges=3350114 depth=67 deadlocks=0 errors=0
    [fixed/share]     states=293380  edges=865752  depth=63 deadlocks=0 errors=0
    [fixed/live]      states=350020  edges=1349632 depth=67 deadlocks=0 errors=0
    [fixed/live]      liveness failures: none   (RunsEnd, WaitingMovesOn, OutboxDrains, GhostCleared)
    [fixed/arbitrary] states=2252079 edges=8649826 depth=63 errors=0
    [plan] F1 to F9 (10 cases): each violates the expected property
    mutants killed: 11/11

The state counts of `[fixed/small]`, `[fixed/share]`, `[fixed/live]` and
`[fixed/arbitrary]` are equal to the TLC distinct state counts of
`ServerSmall.cfg`, `ServerShareSmall.cfg`, `ServerLiveSmall.cfg` and
`ServerArbitrary.cfg`.

Mutants (11 of 11 killed): hand over without the empty check, no hand-over
chain, chain stops after one step, leave does not free the room,
`player_incoming` not deleted when an incoming run leaves, restart loses the
outbox, `player_data` with all keys, completion in room ROOMS-1 (off by one),
double hand-over (copy, not move), `player_left` without a sent
`player_incoming`, no `waiting` state.

## What is proved

Inside the bounds of each configuration, for the repaired design: all safety
properties above, no deadlock (except in `ServerArbitrary.cfg`, which does not
check it), and the four liveness properties under the stated fairness.

## What is NOT covered

- Bounds: 5 rooms are checked with 3 runs only without quits and faults
  (`ServerCore5.cfg`), and with 2 runs for quits, shares and liveness. Faults
  (restart, disconnect, lost ack, resends) are checked with 3 rooms and 2
  runs, max one of each. Liveness with a restart is checked with 3 rooms and
  2 runs. A flaw that needs more runs, more rooms with faults, or two faults of
  the same kind is not excluded.
- Each Pi has max one message in flight to the server (`MAX_UP = 1`; the
  findings F1b and F6 use 2).
- `max_wait` (8.7), timestamps (7.3), room-time values, the leaderboard
  (section 10), validation and error codes (8.11), authentication details
  (8.1: pre-auth buffer, close codes 4000/4001), last-value-wins values of a
  share (the model keeps the target and source Pi, not the value).
- One key per run in the share configurations, and the target set
  {null, [5], [1, 5]}.
- The model of the Pi is an abstraction of the Godot game. The client queue is
  a FIFO without loss (except bounded loss of acks). The plan client
  (at-most-once) can also lose requests; `DROP_REQUESTS` exists but no
  configuration of the repaired design turns it on, because a lost
  `game_finish` without a resend stops the player (see F9).
- A model checker shows the absence of errors only in the bounds.

## Findings in docs/PLAN.md section 8

Each finding has a TLC configuration that FAILS (`Find_*.cfg`) and the same
case in `check_design.py` ("[plan]" lines). The traces below are from TLC,
shortened. "A" = player 1, "B" = player 2. "Pi N" = the Pi in room N.

### F1. An ack removes the wrong `player_incoming` (8.10) — pipeline stops

Rule 8.10: "An ack removes the oldest outbox message of that type for that
Pi". The ack has no id. `Find_F1_AckByType.cfg` fails `AckOnlyDelivered`
(19 states):

1. A finishes room 1. Hand-over: room 2 = A `incoming`. Outbox: `player_incoming(A)` to Pi 2.
2. The server sends it to Pi 2. Before Pi 2 reads it, A quits at Pi 1 (8.9.2, "last run that left room N"). The server deletes `player_incoming(A)` and queues `player_left(A)`.
3. B registers, plays room 1, finishes. Hand-over: room 2 = B. Outbox: `player_left(A)`, `player_incoming(B)`.
4. Pi 2 reads the old copy of `player_incoming(A)` and sends `player_incoming_ok`.
5. The server removes the oldest `player_incoming` for Pi 2: that is `player_incoming(B)`. Pi 2 never gets B.

Result: B stays `incoming` in room 2 for ever. Room 2 never becomes empty, so
all later players wait for ever. Nothing in the plan recovers from this.

### F1b. A late duplicate `player_incoming_ok` removes a newer message — pipeline stops

This is the same rule as F1, with no quit. It is also in
`backend/src/game.ts` (it removes the oldest `player_incoming` on any
`player_incoming_ok`). `Find_F1b_DuplicateAck.cfg` fails `AckOnlyDelivered`
(26 states):

1. A goes to room 2. The server sends `player_incoming(A)` (id 2) to Pi 2.
2. Pi 2 reads it and sends ok. The resend timer fires before the server reads the ok: the server sends id 2 again.
3. The server reads the first ok and removes id 2. A plays room 2. B finishes room 1 and waits.
4. A finishes room 2. Hand-over: A to room 3, B to room 2. Outbox: `player_incoming(B)` (id 6) to Pi 2.
5. Pi 2 reads the second copy of id 2 and sends ok again (the client acks every copy).
6. The server removes the oldest `player_incoming` for Pi 2: id 6. Pi 2 never gets B.

Result: as F1, B blocks room 2 for ever.

Fix (`FIX_ACK_ID`): give each outbox message its id in the payload. The Pi
echoes the id in the ok (`player_incoming_ok {id}`). The server removes only
the message with that id, and ignores an ok for an unknown id. With this fix
`AckOnlyDelivered` and all liveness properties pass.

### F2. `player_leave` hits the next player (8.9.2)

`player_leave` has no username. Rule 8.9.2 first uses "the run in room N". But
the hand-over chain (8.6.5) fills room N again at once.
`Find_F2_LeaveWithoutName.cfg` fails `NoMisapply` (25 states):

1. A plays room 2. B plays room 1, finishes, and waits (room 2 is busy).
2. A finishes room 2. A goes to room 3 (`incoming`), and the chain moves B to room 2 (`incoming`) in the same step.
3. A says "I stop" at Pi 2 (issue 1 case "the person stops after they finished the previous machine"). Pi 2 sends `player_leave`.
4. Room 2 has a run (B), so the server marks B as `left` and empties room 2.

Result: the wrong player (B) is removed. A, who quit, stays `incoming` in
room 3 and blocks room 3 (nobody starts A, so the pipeline stops after room 3
until an operator acts). The same problem exists for `share` (8.8.3, F5) and
for `game_start`/`game_finish` with duplicates (F7).

Fix (`FIX_NAME_CHECK`): all Pi events carry `username` (the client has it in
`current_player`). The server applies the event only to the run with that
name: for `player_leave`, the run in room N or the run that left room N and is
`incoming` in room N+1. Else it replies `player_leave_ok` (or `error`) and does
nothing.

### F3. `player_incoming` stays in the outbox after the run started (8.10)

If the ok is lost, `player_incoming` stays in the outbox while the run plays,
and also after the run left the room. `Find_F3_StaleIncoming.cfg` fails
`OutboxCurrent` (13 states):

1. A goes to room 2. Pi 2 gets `player_incoming(A)` and sends ok. The connection loses the ok.
2. Pi 2 starts A. Room 2 = A `playing`. The outbox still has `player_incoming(A)` for Pi 2.

The server resends it until an ok comes. If A finishes room 2 first, Pi 2 shows
A again after `game_finish_ok` (`NoStaleAdopt` without the Pi fix of F6), and
if the share data is not empty, room 2 gets shares for a room that A passed.
If A completes room 5 first, the outbox refers to a completed run
(`OutboxLive`).

Fix (`FIX_STALE_INC`): `game_start` in room M deletes `player_incoming` of that
run for Pi M (the start shows that the Pi has the player).

### F4. The "sent" mark of 8.9.6 is not persisted (sections 8.9 and 9)

8.9.6 sends `player_left` only "if the server sent `player_incoming` ... one or
more times". The schema in section 9 has no column for this. After a restart
the mark is lost. `Find_F4_SentVolatile.cfg` fails `LeftQueuedIfReceived`
(13 states):

1. A goes to room 2. Pi 2 gets `player_incoming(A)` and shows A.
2. A quits at Pi 1 (between room 1 and room 2). The `player_leave` is in the queue.
3. The server restarts. Pi 1 connects again, the server reads the `player_leave`.
4. The server deletes `player_incoming(A)` but does not queue `player_left(A)`, because the mark is lost.

Result: Pi 2 shows A for ever (until the next `player_incoming`).

Fix (`FIX_PERSIST_SENT`): add `sent_count` (or `sent_at`) to the outbox row, or
keep a `notified` flag per run and room in SQLite. A simpler rule is also
safe: always queue `player_left` when the run was `incoming` in room M ≥ 2
(the Pi ignores `player_left` for a player that it does not show, see F6).

### F5. A share after `game_finish` is lost or goes to the wrong player (8.8)

8.8.3 accepts a share for "the last run that left room N". But the hand-over
(8.6.4) already built `player_data` for room N+1. A game that sends its result
after `game_finish` is normal. `Find_F5_ShareAfterFinish.cfg` fails
`DataExact` (10 states):

1. A finishes room 1. Room 2 is empty: hand-over at once. Outbox: `player_incoming(A)` with `player_data = {}`.
2. Pi 1 sends `share` (key a, target null). Room 1 is empty, so the server connects it to A and saves it.

Result: Pi 2 never gets key a, also though A did not start room 2. The plan
has no rule to update or resend `player_data`. If the chain moved B into
room 1 before the share arrives, 8.8.3 connects the share to B (the run in
room N), which is wrong (`NoMisapply`).

Fix (`PI_SHARES_BEFORE_FINISH`): a game must send all shares before
`game_finish` (the client queue keeps the order, so the server has the share
before the hand-over). Then the "last run that left room N" rule is not
necessary. If late shares are a requirement, the server must rebuild
`player_data` when it sends (store only the run id in the outbox) and send an
update after an ack; this repair is not in the model.

### F6. The client acts on old copies (client, 8.10)

The server resends messages, and a copy can arrive after the Pi moved on.
`control_room_client.gd` takes every `player_incoming` and clears
`current_player` on every `player_left`, for any username.
`Find_F6_LeftClearsOther.cfg` fails `NoStaleAdopt` (17 states):

1. A goes to room 2. Pi 2 reads `player_incoming(A)`. A resend puts a second copy in the socket.
2. Pi 2 starts and finishes A. A goes to room 3. A then quits at Pi 2.
3. Pi 2 reads the old copy and shows A again as a new player.

The same mechanism lets a resent `player_left(A)` clear player B at the Pi
(`LeftOnlyForOwn`).

Fix (`PI_DEDUP`, client): ignore `player_incoming` with an id that the Pi
already saw (needs the ids of F1), and ignore `player_left` for a username that
the Pi does not show. Still send the ack.

### F7. A duplicate client message hits another run (no message id in section 7)

Section 7 has no message id, so the server cannot detect a repeated message.
The current client in this worktree (`control_room_client.gd`) adds `seq`,
keeps sent events in `unacked` until an `ack {seq}` event, and sends them
again after each reconnect. Section 7 does not define `ack`. With a server
that follows the plan, `unacked` is never cleared, and each reconnect sends
all old events again. `Find_F7_DuplicateMessage.cfg` fails `NoMisapply`
(16 states):

1. A goes to room 2 (`incoming`). B registers in room 1 and quits at Pi 1. Room 1 is empty.
2. The `player_leave` of Pi 1 comes a second time.
3. Room 1 is empty. `lastLeft[1]` = A and A is `incoming` in room 2, so 8.9.2 removes A.

Other duplicates make a second run for one `player_register`
(`NoPhantomRun`: 8.3.3 detects a repeat only while room 1 is `incoming` with
the same name), or start/finish the next player.

Fix: define `ack {seq}` in section 7 and make the server drop an event with a
`seq` that it already processed for that Pi (store the last `seq` per Pi in
SQLite, in the same transaction). `FIX_NAME_CHECK` (F2) also stops most of
the damage. The repaired design is verified without duplicates of Pi events
(`MAX_DUPS = 0`).

### F8. `game_finish_ok` can be lost for ever (8.6.3) — pipeline stops

8.6.3 sends `game_finish_ok` once, with no ack. It goes in the outbox only if
Pi N is offline. If the connection breaks after the send, the message is lost.
`Find_F8_FinishOkLost.cfg` reaches a deadlock (18 states):

1. A finishes room 1. Hand-over. The server sends `game_finish_ok` to Pi 1.
2. The server restarts before Pi 1 reads it.
3. A plays room 2 and quits there. Pi 1 still waits for `game_finish_ok`.

Result: Pi 1 waits for ever and cannot register the next player. The same
happens for a Pi disconnect.

Fix (`FIX_FINOK_ACK`): put `game_finish_ok` (with `username` and id) in the
outbox like `player_incoming`, and remove it on `game_finish_ok_ok {id}` (or a
common `ack {id}`). The client ignores a `game_finish_ok` for another
username.

### Other ambiguities (no counterexample needed)

- A1 (8.4): `game_start` when room N is `waiting` is not specified. The model
  replies an error and changes nothing.
- A2 (8.6, 8.9): the plan does not say if `last_left` changes when a run quits
  or completes. The model sets it on hand-over and on completion in room 5,
  not on quit.
- A3 (8.8.3): "if the next room has not started that run" can mean "room N+1
  is not `playing` with that run now" or "the run has no `started_at` for
  room N+1". The model uses `started_at`. With the first meaning, a share from
  Pi 2 can attach to a run that is already in room 4.
- A4 (8.9, last line): when Pi N+1 itself sends `player_leave` for its
  `incoming` player, "the same steps" queue `player_left` to Pi N+1 itself.
  This is harmless, but not necessary.
- A5 (8.5.4): completion in room 5 empties room 5. The plan says "hand over"
  only in 8.5.6 and 8.6.5. The model runs the chain after each room becomes
  empty (finish in room 5, quit, hand-over). The mutants show that the chain
  is necessary after each of these.
- A6 (8.10): `game_finish_ok` uses the outbox (`needs_ack = 0`) but 8.10 says
  that outbox messages stay until an ack. The model deletes it when sent.
- A7 (8.3.3): a repeated `player_register` is detected only while room 1 is
  `incoming` with the same name. After the player started, a repeat gets
  `room_busy`, and after the player left room 1 it makes a new run (F7).
### F9. A lost Pi request is lost for ever (client, section 11)

The plan client (`refrence.py`, and the gd client before the seq change) sends
each event at most once. `Find_F9_LostRequest.cfg` (`DROP_REQUESTS = TRUE`)
reaches a deadlock (9 states): Pi 1 sends `player_register` for player 1, the
connection loses it, and Pi 1 shows player 1 but the server has no run. The
same mechanism loses a `game_finish`: the player never moves on and blocks the
room. The F7 fix (seq and `ack`, resend until acked, server dedupe) also fixes
this. The repaired design is verified with loss of acks only.
