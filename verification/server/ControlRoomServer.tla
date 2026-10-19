---------------------------- MODULE ControlRoomServer ----------------------------
(***************************************************************************)
(* Model of the room pipeline of the control room server, docs/PLAN.md   *)
(* section 8 (8.2 to 8.10) and section 9 (what is persisted).             *)
(*                                                                         *)
(* One step of the server = one event in one SQLite transaction (9).      *)
(* Persisted:  slot, lastLeft, status, started, fin, shares, outbox,      *)
(*             nextId (AUTOINCREMENT).                                    *)
(* Volatile:   conn, cursor (retry round), sent ("player_incoming was     *)
(*             sent one or more times", 8.9.6; not in the schema of 9).    *)
(* Network:    up[pi]   = FIFO Pi -> server (client send_queue + socket). *)
(*             down[pi] = FIFO server -> Pi (socket). Lost on disconnect.  *)
(* Pi:         view[pi] = player that the Pi shows, ps[pi] = Pi phase.    *)
(* Ghost:      entered, got, gsent, quit, pstart, bad, bound counters.  *)
(*                                                                         *)
(* The FIX_* and PI_* constants switch on the repairs that README.md      *)
(* proposes. With all of them FALSE the model is the plan as written.     *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
    ROOMS, RUNS,            \* number of rooms (Pis) and number of runs
    KEYS, TARGETS,          \* share keys; share targets (sets, 0 = null = all)
    MAX_SHARES,             \* max share messages that honest Pis send in total
    MAX_RESTARTS, MAX_DISC, \* max server restarts, max Pi disconnects
    MAX_DROPS, MAX_DUPS,    \* max lost Pi messages, max duplicated Pi messages
    DROP_REQUESTS,          \* FALSE: only acks can be lost; TRUE: any Pi message
    MAX_UP,                 \* bound of each Pi -> server channel
    RETRY,                  \* the server can send unacked messages again
    LEAVES,                 \* players can quit (player_leave)
    ARBITRARY,              \* Pis can also send any event at any time
    MAX_JUNK,               \* max number of such arbitrary messages
    FIX_ACK_ID,             \* acks carry the outbox id
    FIX_NAME_CHECK,         \* Pi events carry the username; the server checks it
    FIX_STALE_INC,          \* game_start in room M deletes player_incoming for M
    FIX_PERSIST_SENT,       \* the "sent" mark is persisted (survives restart)
    FIX_FINOK_ACK,          \* game_finish_ok (with username) is an outbox message with an ack
    PI_DEDUP,               \* the Pi ignores player_left for another username and
                            \* player_incoming with an id that it saw before
    PI_SHARES_BEFORE_FINISH \* a Pi sends all shares before game_finish

Rooms == 1..ROOMS
Pis == Rooms
Runs == 1..RUNS
EmptySlot == [st |-> "empty", run |-> 0]
NoShare == [t |-> {}, from |-> 0]
NoMsg == [ev |-> "none", who |-> 0, k |-> "-", t |-> {}, id |-> 0]
MaxIds == RUNS * 2 * ROOMS + 1

KeysDefault == {"a"}
TgtDefault == {{0}, {ROOMS}, {1, ROOMS}}   \* null, a single Pi, an array
TgtNull == {{0}}                           \* null only

VARIABLES
    slot, lastLeft, status, started, fin, shares, outbox, nextId,   \* persisted
    conn, cursor, sent,                                             \* volatile
    up, down,                                                       \* network
    view, ps, seen,                                                 \* Pis
    entered, got, gsent, quit, pstart, bad,                         \* ghost
    nextRun, nShares, restarts, discs, drops, dups, junk, lastSent  \* bounds

vars == <<slot, lastLeft, status, started, fin, shares, outbox, nextId,
          conn, cursor, sent, up, down, view, ps, seen, entered, got, gsent, quit, pstart, bad,
          nextRun, nShares, restarts, discs, drops, dups, junk, lastSent>>

-----------------------------------------------------------------------------
(* Helpers *)
Min(S) == CHOOSE x \in S : \A y \in S : x <= y
RemoveAt(s, i) == SubSeq(s, 1, i - 1) \o SubSeq(s, i + 1, Len(s))
OutIds == {outbox[i].id : i \in 1..Len(outbox)}

(* 8.8.6: keys with M in the target list, or target null *)
Targeted(sh, q, m) == {k \in KEYS : 0 \in sh[q][k].t \/ m \in sh[q][k].t}
(* What room m must get: forward shares only (from a Pi before m), 8.8.7 *)
Expected(sh, q, m) == {k \in Targeted(sh, q, m) : sh[q][k].from < m}

(* W is a record of the server state that one event can change. *)
Wc == [slot |-> slot, lastLeft |-> lastLeft, status |-> status,
       started |-> started, fin |-> fin, shares |-> shares, outbox |-> outbox,
       nextId |-> nextId, down |-> down, sent |-> sent, bad |-> bad,
       entered |-> entered]

Flag(W, f) == [W EXCEPT !.bad = @ \cup {f}]
Mis(W, who, q) == IF who # 0 /\ who # q THEN Flag(W, "misapply") ELSE W
(* FIX_NAME_CHECK: the server accepts the event only for the named run. *)
NameOK(msg, q) == ~FIX_NAME_CHECK \/ msg.who = q

(* 8.6.3: game_finish_ok, direct if Pi n is connected, else in the outbox *)
SendFinOk(W, n, q) ==
    IF conn[n] /\ ~FIX_FINOK_ACK
    THEN [W EXCEPT !.down[n] = Append(@, [ev |-> "fin", run |-> q, data |-> {}, id |-> 0])]
    ELSE [W EXCEPT !.outbox = Append(@, [id |-> W.nextId, pi |-> n, ev |-> "fin",
                                         run |-> q, data |-> {}]),
                   !.nextId = @ + 1]

QueueInc(W, q, m) ==
    [W EXCEPT !.outbox = Append(@, [id |-> W.nextId, pi |-> m, ev |-> "inc",
                                    run |-> q, data |-> Targeted(W.shares, q, m)]),
              !.nextId = @ + 1]

QueueLeft(W, q, m) ==
    [W EXCEPT !.outbox = Append(@, [id |-> W.nextId, pi |-> m, ev |-> "left",
                                    run |-> q, data |-> {}]),
              !.nextId = @ + 1]

DelInc(W, q, m) ==
    [W EXCEPT !.outbox = SelectSeq(@, LAMBDA e : ~(e.ev = "inc" /\ e.run = q /\ e.pi = m))]

(* 8.6 hand over from room n to room n+1 *)
HandOver(W, n) ==
    LET q  == W.slot[n].run
        W1 == IF W.slot[n + 1].st # "empty" THEN Flag(W, "handover_nonempty") ELSE W
        W2 == [W1 EXCEPT !.slot[n + 1] = [st |-> "incoming", run |-> q],
                         !.slot[n] = EmptySlot,
                         !.lastLeft[n] = q,
                         !.entered[q] = n + 1]
    IN QueueInc(SendFinOk(W2, n, q), q, n + 1)

(* 8.5.6 and 8.6.5: room m is empty; hand over the chain back to room 1 *)
RECURSIVE Cascade(_, _)
Cascade(W, m) ==
    IF m > 1 /\ W.slot[m].st = "empty" /\ W.slot[m - 1].st = "waiting"
    THEN Cascade(HandOver(W, m - 1), m - 1)
    ELSE W

-----------------------------------------------------------------------------
(* Server event handlers, section 8. Errors leave W unchanged. *)

DoRegister(W, pi, msg) ==                                        \* 8.3
    LET u == msg.who IN
    IF pi # 1 THEN W
    ELSE IF W.slot[1].st = "empty"
         THEN IF W.status[u] # "none"
              THEN IF FIX_NAME_CHECK THEN W           \* known username: repeat
                   ELSE Flag(W, "phantom")      \* a second run for an old message
              ELSE [W EXCEPT !.status[u] = "active",
                             !.slot[1] = [st |-> "incoming", run |-> u],
                             !.entered[u] = 1]
         ELSE W                            \* same username: ok; else room_busy

DoStart(W, pi, msg) ==                                           \* 8.4
    LET s == W.slot[pi] IN
    IF s.st = "incoming" /\ NameOK(msg, s.run)
    THEN LET W1 == [Mis(W, msg.who, s.run) EXCEPT !.slot[pi].st = "playing",
                                                  !.started[s.run] = @ \cup {pi}]
         IN IF FIX_STALE_INC THEN DelInc(W1, s.run, pi) ELSE W1
    ELSE W                                 \* playing: ok; else error

DoFinish(W, pi, msg) ==                                          \* 8.5
    LET s == W.slot[pi]
        q == s.run
    IN IF s.st \notin {"playing", "waiting"} \/ ~NameOK(msg, q) THEN W
       ELSE LET W2 == [Mis(W, msg.who, q) EXCEPT !.fin[q] = @ \cup {pi}] IN
            IF pi = ROOMS
            THEN LET W3 == IF W2.status[q] # "active" THEN Flag(W2, "status_flip") ELSE W2
                     W4 == [W3 EXCEPT !.status[q] = "completed",
                                      !.slot[ROOMS] = EmptySlot,
                                      !.lastLeft[ROOMS] = q]
                 IN Cascade(SendFinOk(W4, ROOMS, q), ROOMS)
            ELSE IF W2.slot[pi + 1].st = "empty"
                 THEN Cascade(HandOver(W2, pi), pi)
                 ELSE [W2 EXCEPT !.slot[pi].st = "waiting"]

LeaveRun(W, pi, msg) ==                                          \* 8.9.2
    IF FIX_NAME_CHECK
    THEN IF msg.who # 0 /\ W.slot[pi].run = msg.who THEN msg.who
         ELSE IF pi < ROOMS /\ msg.who # 0 /\ W.lastLeft[pi] = msg.who
                 /\ W.slot[pi + 1] = [st |-> "incoming", run |-> msg.who]
              THEN msg.who
              ELSE 0
    ELSE IF W.slot[pi].run # 0 THEN W.slot[pi].run
    ELSE IF pi < ROOMS /\ W.lastLeft[pi] # 0
            /\ W.slot[pi + 1].st = "incoming" /\ W.slot[pi + 1].run = W.lastLeft[pi]
         THEN W.lastLeft[pi]
         ELSE 0

DoLeave(W, pi, msg) ==                                           \* 8.9
    LET q == LeaveRun(W, pi, msg) IN
    IF q = 0 THEN W
    ELSE LET m      == CHOOSE r \in Rooms : W.slot[r].run = q
             wasInc == W.slot[m].st = "incoming"
             W1 == Mis(W, msg.who, q)
             W2 == IF W1.status[q] # "active" THEN Flag(W1, "status_flip") ELSE W1
             W3 == [W2 EXCEPT !.status[q] = "left", !.slot[m] = EmptySlot]
             W4 == IF wasInc /\ m >= 2
                   THEN LET W5 == DelInc(W3, q, m)
                            W6 == IF <<q, m>> \in got /\ <<q, m>> \notin W5.sent
                                  THEN Flag(W5, "left_not_queued") ELSE W5
                        IN IF <<q, m>> \in W6.sent THEN QueueLeft(W6, q, m) ELSE W6
                   ELSE W3
         IN Cascade(W4, m)

ShareRun(W, pi, msg) ==                                          \* 8.8.3
    LET l    == W.lastLeft[pi]
        lOK  == l # 0 /\ (pi = ROOMS \/ (pi + 1) \notin W.started[l])
    IN IF FIX_NAME_CHECK
       THEN IF msg.who # 0 /\ W.slot[pi].run = msg.who THEN msg.who
            ELSE IF lOK /\ l = msg.who THEN l ELSE 0
       ELSE IF W.slot[pi].run # 0 THEN W.slot[pi].run
            ELSE IF lOK THEN l ELSE 0

DoShare(W, pi, msg) ==                                           \* 8.8
    LET q == ShareRun(W, pi, msg) IN
    IF q = 0 THEN W
    ELSE [Mis(W, msg.who, q) EXCEPT !.shares[q][msg.k] = [t |-> msg.t, from |-> pi]]

DoAck(W, pi, msg, kind) ==                                       \* 8.10
    LET idx == {i \in 1..Len(W.outbox) :
                    W.outbox[i].pi = pi /\ W.outbox[i].ev = kind
                    /\ (FIX_ACK_ID => W.outbox[i].id = msg.id)}
    IN IF idx = {} THEN W
       ELSE LET i  == Min(idx)
                e  == W.outbox[i]
                W1 == IF kind = "inc" /\ <<e.run, pi>> \notin got
                      THEN Flag(W, "ack_undelivered") ELSE W
            IN [W1 EXCEPT !.outbox = RemoveAt(@, i)]

Handle(W, pi, msg) ==
    CASE msg.ev = "reg"    -> DoRegister(W, pi, msg)
      [] msg.ev = "start"  -> DoStart(W, pi, msg)
      [] msg.ev = "finish" -> DoFinish(W, pi, msg)
      [] msg.ev = "leave"  -> DoLeave(W, pi, msg)
      [] msg.ev = "share"  -> DoShare(W, pi, msg)
      [] msg.ev = "incok"  -> DoAck(W, pi, msg, "inc")
      [] msg.ev = "leftok" -> DoAck(W, pi, msg, "left")
      [] msg.ev = "finok"  -> DoAck(W, pi, msg, "fin")

-----------------------------------------------------------------------------
Init ==
    /\ slot = [r \in Rooms |-> EmptySlot]
    /\ lastLeft = [r \in Rooms |-> 0]
    /\ status = [p \in Runs |-> "none"]
    /\ started = [p \in Runs |-> {}]
    /\ fin = [p \in Runs |-> {}]
    /\ shares = [p \in Runs |-> [k \in KEYS |-> NoShare]]
    /\ outbox = <<>>
    /\ nextId = 1
    /\ conn = [pi \in Pis |-> TRUE]
    /\ cursor = [pi \in Pis |-> 0]
    /\ sent = {}
    /\ up = [pi \in Pis |-> <<>>]
    /\ down = [pi \in Pis |-> <<>>]
    /\ view = [pi \in Pis |-> 0]
    /\ ps = [pi \in Pis |-> "idle"]
    /\ seen = [pi \in Pis |-> 0]
    /\ entered = [p \in Runs |-> 0]
    /\ got = {}
    /\ gsent = {}
    /\ quit = {}
    /\ pstart = [p \in Runs |-> 0]
    /\ bad = {}
    /\ nextRun = 1
    /\ nShares = 0
    /\ restarts = 0
    /\ discs = 0
    /\ drops = 0
    /\ dups = 0
    /\ junk = 0
    /\ lastSent = [pi \in Pis |-> NoMsg]

(* The server processes the oldest message from a connected Pi. *)
ServerRecv(pi) ==
    /\ conn[pi]
    /\ up[pi] # <<>>
    /\ LET W == Handle(Wc, pi, Head(up[pi])) IN
       /\ slot' = W.slot /\ lastLeft' = W.lastLeft /\ status' = W.status
       /\ started' = W.started /\ fin' = W.fin /\ shares' = W.shares
       /\ outbox' = W.outbox /\ nextId' = W.nextId /\ down' = W.down
       /\ sent' = W.sent /\ bad' = W.bad /\ entered' = W.entered
    /\ up' = [up EXCEPT ![pi] = Tail(@)]
    /\ UNCHANGED <<pstart, seen, conn, cursor, view, ps, got, gsent, quit, nextRun, nShares,
                   restarts, discs, drops, dups, junk, lastSent>>

ToDown(e) == [ev |-> e.ev, run |-> e.run, data |-> e.data, id |-> e.id]
ToDownSeq(s) == [j \in 1..Len(s) |-> ToDown(s[j])]
IncPairs(s, pi) == {<<s[j].run, pi>> : j \in {j \in 1..Len(s) : s[j].ev = "inc"}}

(* 8.10: send the outbox messages for Pi pi that this connection did not  *)
(* send yet (cursor = highest id sent). game_finish_ok needs no ack: the  *)
(* server deletes it when it sends it.                                    *)
ServerSend(pi) ==
    /\ conn[pi]
    /\ LET new == SelectSeq(outbox, LAMBDA e : e.pi = pi /\ e.id > cursor[pi]) IN
       /\ new # <<>>
       /\ down' = [down EXCEPT ![pi] = @ \o ToDownSeq(new)]
       /\ cursor' = [cursor EXCEPT ![pi] = new[Len(new)].id]
       /\ outbox' = IF FIX_FINOK_ACK THEN outbox
                    ELSE SelectSeq(outbox, LAMBDA e : ~(e.pi = pi /\ e.id > cursor[pi] /\ e.ev = "fin"))
       /\ sent' = sent \cup IncPairs(new, pi)
       /\ gsent' = gsent \cup IncPairs(new, pi)
    /\ UNCHANGED <<pstart, seen, slot, lastLeft, status, started, fin, shares, nextId, conn,
                   up, view, ps, entered, got, quit, bad, nextRun, nShares,
                   restarts, discs, drops, dups, junk, lastSent>>

(* ACK_RETRY_MS: send all unacked messages again. The model fires a     *)
(* retry only when the Pi has read the previous messages (down empty).   *)
Retry(pi) ==
    /\ RETRY
    /\ conn[pi]
    /\ down[pi] = <<>>
    /\ LET old == SelectSeq(outbox, LAMBDA e : e.pi = pi /\ e.id <= cursor[pi]) IN
       /\ old # <<>>
       /\ down' = [down EXCEPT ![pi] = ToDownSeq(old)]
    /\ UNCHANGED <<pstart, seen, slot, lastLeft, status, started, fin, shares, outbox, nextId,
                   conn, cursor, sent, up, view, ps, entered, got, gsent, quit, bad,
                   nextRun, nShares, restarts, discs, drops, dups, junk, lastSent>>

(* 8.1: auth_ok, then all outbox messages again (cursor = 0). *)
Connect(pi) ==
    /\ ~conn[pi]
    /\ conn' = [conn EXCEPT ![pi] = TRUE]
    /\ UNCHANGED <<pstart, seen, slot, lastLeft, status, started, fin, shares, outbox, nextId,
                   cursor, sent, up, down, view, ps, entered, got, gsent, quit, bad,
                   nextRun, nShares, restarts, discs, drops, dups, junk, lastSent>>

Disconnect(pi) ==
    /\ conn[pi]
    /\ discs < MAX_DISC
    /\ conn' = [conn EXCEPT ![pi] = FALSE]
    /\ down' = [down EXCEPT ![pi] = <<>>]
    /\ cursor' = [cursor EXCEPT ![pi] = 0]
    /\ discs' = discs + 1
    /\ UNCHANGED <<pstart, seen, slot, lastLeft, status, started, fin, shares, outbox, nextId,
                   sent, up, view, ps, entered, got, gsent, quit, bad,
                   nextRun, nShares, restarts, drops, dups, junk, lastSent>>

(* Server restart: volatile state is lost, SQLite state is kept. *)
Restart ==
    /\ restarts < MAX_RESTARTS
    /\ conn' = [pi \in Pis |-> FALSE]
    /\ down' = [pi \in Pis |-> <<>>]
    /\ cursor' = [pi \in Pis |-> 0]
    /\ sent' = IF FIX_PERSIST_SENT THEN sent ELSE {}
    /\ restarts' = restarts + 1
    /\ UNCHANGED <<pstart, seen, slot, lastLeft, status, started, fin, shares, outbox, nextId,
                   up, view, ps, entered, got, gsent, quit, bad,
                   nextRun, nShares, discs, drops, dups, junk, lastSent>>

(* A Pi message is lost (it was on a connection that broke). *)
Drop(pi) ==
    /\ up[pi] # <<>>
    /\ DROP_REQUESTS \/ Head(up[pi]).ev \in {"incok", "leftok"}
    /\ drops < MAX_DROPS
    /\ up' = [up EXCEPT ![pi] = Tail(@)]
    /\ drops' = drops + 1
    /\ UNCHANGED <<pstart, seen, slot, lastLeft, status, started, fin, shares, outbox, nextId,
                   conn, cursor, sent, down, view, ps, entered, got, gsent, quit, bad,
                   nextRun, nShares, restarts, discs, dups, junk, lastSent>>

(* A Pi message is delivered two times (client resend). *)
Dup(pi) ==
    /\ dups < MAX_DUPS
    /\ lastSent[pi] # NoMsg
    /\ Len(up[pi]) < MAX_UP
    /\ up' = [up EXCEPT ![pi] = Append(@, lastSent[pi])]
    /\ dups' = dups + 1
    /\ UNCHANGED <<pstart, seen, slot, lastLeft, status, started, fin, shares, outbox, nextId,
                   conn, cursor, sent, down, view, ps, entered, got, gsent, quit, bad,
                   nextRun, nShares, restarts, discs, drops, junk, lastSent>>

-----------------------------------------------------------------------------
(* The Pis *)

Mk(e, w, k, t, i) == [ev |-> e, who |-> w, k |-> k, t |-> t, id |-> i]

(* Append m to up[pi]; remember it for Dup only if dups are possible. *)
PiSend(pi, m) ==
    /\ Len(up[pi]) < MAX_UP
    /\ up' = [up EXCEPT ![pi] = Append(@, m)]
    /\ lastSent' = IF MAX_DUPS > 0 THEN [lastSent EXCEPT ![pi] = m] ELSE lastSent

Live(pi) == view[pi] # 0 /\ view[pi] \notin quit

Register ==
    /\ ps[1] = "idle"
    /\ nextRun <= RUNS
    /\ PiSend(1, Mk("reg", nextRun, "-", {}, 0))
    /\ view' = [view EXCEPT ![1] = nextRun]
    /\ ps' = [ps EXCEPT ![1] = "ready"]
    /\ nextRun' = nextRun + 1
    /\ UNCHANGED <<pstart, seen, slot, lastLeft, status, started, fin, shares, outbox, nextId,
                   conn, cursor, sent, down, entered, got, gsent, quit, bad,
                   nShares, restarts, discs, drops, dups, junk>>

Start(pi) ==
    /\ ps[pi] = "ready" /\ Live(pi)
    /\ PiSend(pi, Mk("start", view[pi], "-", {}, 0))
    /\ ps' = [ps EXCEPT ![pi] = "play"]
    /\ pstart' = [pstart EXCEPT ![view[pi]] = pi]
    /\ UNCHANGED <<seen, slot, lastLeft, status, started, fin, shares, outbox, nextId,
                   conn, cursor, sent, down, view, entered, got, gsent, quit, bad,
                   nextRun, nShares, restarts, discs, drops, dups, junk>>

Finish(pi) ==
    /\ ps[pi] = "play" /\ Live(pi)
    /\ PiSend(pi, Mk("finish", view[pi], "-", {}, 0))
    /\ ps' = [ps EXCEPT ![pi] = "fin"]
    /\ UNCHANGED <<pstart, seen, slot, lastLeft, status, started, fin, shares, outbox, nextId,
                   conn, cursor, sent, down, view, entered, got, gsent, quit, bad,
                   nextRun, nShares, restarts, discs, drops, dups, junk>>

(* The player quits: at the Pi that has the player, also when the player *)
(* is incoming (8.9 last line) or finished and not yet at the next room.  *)
(* Physical rule: the player is not in a later room. pstart[p] is the    *)
(* last Pi where the player pressed start.                                *)
Leave(pi) ==
    /\ LEAVES
    /\ ps[pi] \in {"ready", "play", "fin"} /\ Live(pi)
    /\ pi >= pstart[view[pi]]
    /\ PiSend(pi, Mk("leave", view[pi], "-", {}, 0))
    /\ quit' = quit \cup {view[pi]}
    /\ view' = [view EXCEPT ![pi] = 0]
    /\ ps' = [ps EXCEPT ![pi] = "idle"]
    /\ UNCHANGED <<pstart, seen, slot, lastLeft, status, started, fin, shares, outbox, nextId,
                   conn, cursor, sent, down, entered, got, gsent, bad,
                   nextRun, nShares, restarts, discs, drops, dups, junk>>

SharePhases == IF PI_SHARES_BEFORE_FINISH THEN {"play"} ELSE {"play", "fin"}

Share(pi, k, t) ==
    /\ ps[pi] \in SharePhases /\ Live(pi)
    /\ nShares < MAX_SHARES
    /\ PiSend(pi, Mk("share", view[pi], k, t, 0))
    /\ nShares' = nShares + 1
    /\ UNCHANGED <<pstart, seen, slot, lastLeft, status, started, fin, shares, outbox, nextId,
                   conn, cursor, sent, down, view, ps, entered, got, gsent, quit, bad,
                   nextRun, restarts, discs, drops, dups, junk>>

(* ARBITRARY: any event at any time, with no intended player. *)
Junk(pi) ==
    /\ ARBITRARY
    /\ junk < MAX_JUNK
    /\ junk' = junk + 1
    /\ \E m \in {Mk(e, w, "-", {}, 0) : e \in {"start", "finish", "leave"}, w \in 0..RUNS}
               \cup {Mk("share", w, k, t, 0) : k \in KEYS, t \in TARGETS, w \in 0..RUNS}
               \cup {Mk(e, 0, "-", {}, i) : e \in {"incok", "leftok", "finok"}, i \in OutIds \cup {0}} :
         PiSend(pi, m)
    /\ UNCHANGED <<pstart, seen, slot, lastLeft, status, started, fin, shares, outbox, nextId,
                   conn, cursor, sent, down, view, ps, entered, got, gsent, quit, bad,
                   nextRun, nShares, restarts, discs, drops, dups>>

(* The Pi reads the oldest server message (control_room_client.gd). *)
Receive(pi) ==
    /\ down[pi] # <<>>
    /\ LET m == Head(down[pi]) IN
       CASE m.ev = "fin" ->
              /\ IF FIX_FINOK_ACK THEN PiSend(pi, Mk("finok", 0, "-", {}, m.id))
                                  ELSE UNCHANGED <<up, lastSent>>
              /\ IF ps[pi] = "fin" /\ (FIX_FINOK_ACK => view[pi] = m.run)
                 THEN /\ ps' = [ps EXCEPT ![pi] = "idle"]
                      /\ view' = [view EXCEPT ![pi] = 0]
                 ELSE UNCHANGED <<ps, view>>
              /\ UNCHANGED <<got, bad, seen>>
         [] m.ev = "inc" ->
              /\ PiSend(pi, Mk("incok", 0, "-", {}, m.id))
              /\ got' = got \cup {<<m.run, pi>>}
              /\ IF view[pi] # m.run /\ ~(PI_DEDUP /\ m.id <= seen[pi])
                 THEN /\ view' = [view EXCEPT ![pi] = m.run]
                      /\ ps' = [ps EXCEPT ![pi] = "ready"]
                      /\ bad' = bad \cup
                           (IF status[m.run] = "active" /\ entered[m.run] > pi
                            THEN {"stale_adopt"} \cup (IF m.data # {} THEN {"share_passed"} ELSE {})
                            ELSE {})
                 ELSE UNCHANGED <<view, ps, bad>>
              /\ seen' = IF PI_DEDUP /\ m.id > seen[pi]
                          THEN [seen EXCEPT ![pi] = m.id] ELSE seen
         [] m.ev = "left" ->
              /\ PiSend(pi, Mk("leftok", 0, "-", {}, m.id))
              /\ IF ~PI_DEDUP \/ view[pi] = m.run
                 THEN /\ view' = [view EXCEPT ![pi] = 0]
                      /\ ps' = [ps EXCEPT ![pi] = "idle"]
                      /\ bad' = IF view[pi] # 0 /\ view[pi] # m.run
                                THEN bad \cup {"left_clears_other"} ELSE bad
                 ELSE UNCHANGED <<view, ps, bad>>
              /\ UNCHANGED <<got, seen>>
    /\ down' = [down EXCEPT ![pi] = Tail(@)]
    /\ UNCHANGED <<pstart, slot, lastLeft, status, started, fin, shares, outbox, nextId,
                   conn, cursor, sent, gsent, entered, quit,
                   nextRun, nShares, restarts, discs, drops, dups, junk>>

(* All work is done: an explicit final stutter, so that deadlock = stuck. *)
Terminal ==
    /\ nextRun = RUNS + 1
    /\ \A p \in Runs : status[p] \in {"completed", "left"}
    /\ outbox = <<>>
    /\ \A pi \in Pis : up[pi] = <<>> /\ down[pi] = <<>>

Done == Terminal /\ UNCHANGED vars

Next ==
    \/ \E pi \in Pis : \/ ServerRecv(pi) \/ ServerSend(pi) \/ Retry(pi)
                       \/ Connect(pi) \/ Disconnect(pi) \/ Drop(pi) \/ Dup(pi)
                       \/ Start(pi) \/ Finish(pi) \/ Leave(pi) \/ Receive(pi)
                       \/ Junk(pi)
                       \/ \E k \in KEYS, t \in TARGETS : Share(pi, k, t)
    \/ Register
    \/ Restart
    \/ Done

Fairness ==
    /\ \A pi \in Pis : /\ WF_vars(ServerRecv(pi)) /\ WF_vars(ServerSend(pi))
                       /\ WF_vars(Retry(pi)) /\ WF_vars(Connect(pi))
                       /\ WF_vars(Receive(pi))
                       /\ WF_vars(Start(pi)) /\ WF_vars(Finish(pi))

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
(* Safety *)

TypeOK ==
    /\ slot \in [Rooms -> [st : {"empty", "incoming", "playing", "waiting"}, run : 0..RUNS]]
    /\ lastLeft \in [Rooms -> 0..RUNS]
    /\ status \in [Runs -> {"none", "active", "completed", "left"}]
    /\ entered \in [Runs -> 0..ROOMS]
    /\ view \in [Pis -> 0..RUNS]
    /\ ps \in [Pis -> {"idle", "ready", "play", "fin"}]
    /\ nextId \in 1..(MaxIds + 1)

SlotWellFormed == \A r \in Rooms : (slot[r].st = "empty") <=> (slot[r].run = 0)
OneRoomPerRun == \A r1, r2 \in Rooms :
                    r1 # r2 /\ slot[r1].run # 0 => slot[r1].run # slot[r2].run
InOrder == \A r \in Rooms : slot[r].run # 0 => entered[slot[r].run] = r
OnlyActiveInRooms == \A r \in Rooms : slot[r].run # 0 => status[slot[r].run] = "active"
WaitingNextBusy == \A r \in Rooms : slot[r].st = "waiting" =>
                        r < ROOMS /\ slot[r + 1].st # "empty"
NoHandoverToBusy == "handover_nonempty" \notin bad
CompletedAllTimes == \A p \in Runs : status[p] = "completed" =>
                        fin[p] = Rooms /\ started[p] = Rooms /\ entered[p] = ROOMS
TimesConsistent == \A p \in Runs : fin[p] \subseteq started[p]
                                   /\ started[p] \subseteq 1..entered[p]
LeftNeverCompleted == "status_flip" \notin bad
OutboxLive == \A i \in 1..Len(outbox) :
                /\ outbox[i].ev = "inc"  => status[outbox[i].run] = "active"
                /\ outbox[i].ev = "left" => status[outbox[i].run] = "left"
OutboxCurrent == \A i \in 1..Len(outbox) : outbox[i].ev = "inc" =>
                    slot[outbox[i].pi] = [st |-> "incoming", run |-> outbox[i].run]
LeftOnlyIfSent == \A i \in 1..Len(outbox) : outbox[i].ev = "left" =>
                    <<outbox[i].run, outbox[i].pi>> \in gsent
LeftQueuedIfReceived == "left_not_queued" \notin bad
NoShareToPassedRoom == "share_passed" \notin bad
NoStaleAdopt == "stale_adopt" \notin bad
DataExact == \A i \in 1..Len(outbox) : outbox[i].ev = "inc" =>
                outbox[i].data = Expected(shares, outbox[i].run, outbox[i].pi)
NoMisapply == "misapply" \notin bad
NoPhantomRun == "phantom" \notin bad
AckOnlyDelivered == "ack_undelivered" \notin bad
LeftOnlyForOwn == "left_clears_other" \notin bad

(* Action property: a run enters rooms one by one, 1, 2, ..., ROOMS. *)
EnterStep == [][\A p \in Runs : entered'[p] \in {entered[p], entered[p] + 1}]_vars

-----------------------------------------------------------------------------
(* Liveness (with FairSpec) *)

RunsEnd == \A p \in Runs : (status[p] = "active") ~> (status[p] \in {"completed", "left"})
WaitingMovesOn == \A r \in Rooms, p \in Runs :
                    (slot[r].st = "waiting" /\ slot[r].run = p) ~> (slot[r].run # p)
OutboxDrains == \A i \in 1..MaxIds : (i \in OutIds) ~> (i \notin OutIds)
GhostCleared == \A pi \in Pis, p \in Runs :
                    (view[pi] = p /\ status[p] = "left") ~> (view[pi] # p)

(* The same four properties in "eventually always" form. In this bounded *)
(* model they imply the leads-to forms above, and TLC checks them much   *)
(* faster (fewer tableau branches).                                      *)
RunsEndEA        == \A p \in Runs : <>[](status[p] # "active")
NoWaitEA         == <>[](\A r \in Rooms : slot[r].st # "waiting")
OutboxEmptyEA    == <>[](outbox = <<>>)
NoGhostEA        == <>[](\A pi \in Pis : view[pi] = 0 \/ status[view[pi]] # "left")
=============================================================================
