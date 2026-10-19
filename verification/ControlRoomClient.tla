------------------------- MODULE ControlRoomClient -------------------------
(***************************************************************************)
(* TLA+ model of control_room_client.gd (Godot client) in a lossy          *)
(* environment. It models the shipped code. It is the same model as the    *)
(* baseline variant of model_check.py.                                     *)
(* Delivery protocol: each app event has a seq (here: seq = k for event k). *)
(* After send_text returns OK, the event goes to "unacked". The server     *)
(* sends "ack" n (cumulative: all seq <= n). On every authentication,      *)
(* send_queue = unacked + send_queue and unacked = <<>>. The server keeps  *)
(* the set "received" and ignores a seq that it has seen before (dedupe).  *)
(* Time is abstracted: a timer that expires is a nondeterministic step.    *)
(* Messages: 0 is an auth message. A number k > 0 is app event k.          *)
(* The auth message goes through _send_raw. It is never in send_queue.     *)
(* The "retry delay" (_retry_delay) is not modelled: it has no effect on   *)
(* the state machine.                                                      *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS AUTH_ATTEMPTS,  \* gd: AUTH_ATTEMPTS (3). Check with 2.
          MAX_RETRIES,    \* gd: MAX_RETRIES (10). Check with 2.
          N,              \* maximum number of app events given to send_event
          COOP,           \* TRUE: cooperative environment (for liveness)
          FLAKY_MAX,      \* COOP only: send_text may fail this many times (0 = never)
          LOSS_MAX        \* COOP only: the network may drop the connection this many times (0 = never)

VARIABLES
  st,       \* _state
  ws,       \* websocket /= null
  rs,       \* ready state that the client last saw: "N" none, "C" connecting, "O" open, "X" closed
  isauth,   \* is_authenticated
  queue,    \* send_queue (app events only)
  unacked,  \* unacked: sent (send_text OK), no ack yet
  att,      \* _auth_attempt
  retry,    \* _retry_amount
  net,      \* real transport: "N" none, "P" pending, "U" up, "D" dead
  out,      \* messages on the wire that the server has not read
  inbox,    \* packets from the server that the client has not read (records, see Pk and Ack)
  received, \* server: set of app events that the server has accepted (dedupe by seq)
  given,    \* number of app events given to send_event
  fails,    \* history: connection losses since last authentication
  calls,    \* history: calls of _begin_auth_attempt on this connection
  preauth,  \* history: an app event went on the wire while not authenticated
  fb,       \* history: failed sends so far (counted only if COOP)
  dr        \* history: connection drops by the network so far (counted only if COOP)

vars == <<st, ws, rs, isauth, queue, unacked, att, retry, net, out, inbox,
          received, given, fails, calls, preauth, fb, dr>>

IsApp(m) == m # 0
AppOf(ms) == SelectSeq(ms, IsApp)
Elems(s) == {s[i] : i \in DOMAIN s}
Count0(q) == Cardinality({i \in DOMAIN q : q[i] = 0})

\* Packets from the server to the client are records.
Pk(x) == [k |-> x, n |-> 0]            \* "ok" (auth_ok), "bad" (other packet), "inc" (player_incoming)
Ack(n) == [k |-> "ack", n |-> n]       \* {"event":"ack","seq":n}

\* Highest n such that all seq 1..n are in R (cumulative ack value).
Contig(R) == CHOOSE n \in 0..N : (\A i \in 1..n : i \in R) /\ (n = N \/ (n + 1) \notin R)

\* gd: _handle_ack. Keep the events with seq > n.
RECURSIVE Above(_, _)
Above(q, n) == IF q = <<>> THEN <<>>
               ELSE IF Head(q) > n THEN <<Head(q)>> \o Above(Tail(q), n)
               ELSE Above(Tail(q), n)

CanFail == ~COOP \/ fb < FLAKY_MAX               \* may a send_text fail now?
FbAfter(failed) == fb' = IF failed /\ COOP THEN fb + 1 ELSE fb

rsP == IF net = "P" THEN "C" ELSE IF net = "U" THEN "O" ELSE "X"  \* websocket.poll()

Init ==
  /\ st = "IDLE" /\ ws = FALSE /\ rs = "N" /\ isauth = FALSE /\ queue = <<>>
  /\ unacked = <<>> /\ att = 0 /\ retry = 0 /\ net = "N" /\ out = <<>> /\ inbox = <<>>
  /\ received = {} /\ given = 0 /\ fails = 0 /\ calls = 0
  /\ preauth = FALSE /\ fb = 0 /\ dr = 0

(* gd: _connection_lost. unacked is kept (only on authentication it goes back
   to the queue). Callers must say what happens to
   queue, unacked, att, calls, received, given, preauth, fb, dr. *)
ConnLost ==
  /\ isauth' = FALSE /\ ws' = FALSE /\ rs' = "N" /\ inbox' = <<>>
  /\ net' = "N" /\ out' = <<>>             \* websocket.close(): unread messages are lost
  /\ fails' = fails + 1
  /\ IF retry >= MAX_RETRIES
        THEN st' = "STOPPED" /\ retry' = retry
        ELSE st' = "WAITING_RETRY" /\ retry' = retry + 1
KeepOnLoss == UNCHANGED <<queue, unacked, att, calls, received, given, preauth, fb, dr>>

(* gd: _connect, success branch *)
ConnectOK ==
  /\ ws' = TRUE /\ rs' = "C" /\ net' = "P" /\ st' = "CONNECTING" /\ inbox' = <<>>
  /\ UNCHANGED <<isauth, queue, unacked, att, retry, out, received, given, fails, calls, preauth, fb, dr>>
(* gd: _connect, connect_to_url returned an error *)
ConnectErr == ~COOP /\ ConnLost /\ KeepOnLoss

(* gd: send_event(msg), msg > 0. Describes queue, unacked, out, preauth, fb only.
   It sends only if is_authenticated and send_queue is empty and _send_raw
   succeeds. Then it appends msg to unacked. Else it appends msg to send_queue. *)
SendEvOp(msg, r) ==   \* r: ready state that _send_raw sees
  LET fail == /\ queue' = Append(queue, msg) /\ UNCHANGED <<unacked, out, preauth>>
              /\ FbAfter(TRUE)
      ok == /\ queue' = queue /\ FbAfter(FALSE)
            /\ unacked' = Append(unacked, msg)
            /\ out' = IF net = "U" THEN out \o <<msg>> ELSE out   \* on a dead socket the message is lost
            /\ preauth' = (preauth \/ ~isauth)
  IN IF isauth /\ queue = <<>> /\ ws /\ r = "O"
        THEN ok \/ (CanFail /\ fail)
        ELSE (queue' = Append(queue, msg) /\ UNCHANGED <<unacked, out, preauth, fb>>)

(* gd: _send_raw({"event": "auth", ...}) in _begin_auth_attempt.
   The result is ignored. The auth message is not queued. *)
AuthSend ==
  /\ out' = IF net = "U" THEN out \o <<0>> ELSE out
  /\ UNCHANGED <<queue, unacked, preauth, fb>>
AuthSendFail == ~COOP /\ UNCHANGED <<queue, unacked, out, preauth, fb>>   \* flaky mode fails app sends only

(* gd: _begin_auth_attempt *)
BeginAuth(a, c, stNew, inboxNew) ==
  \/ /\ a >= AUTH_ATTEMPTS /\ att' = a /\ calls' = c /\ ConnLost
     /\ UNCHANGED <<queue, unacked, received, given, preauth, fb, dr>>
  \/ /\ a < AUTH_ATTEMPTS /\ att' = a + 1 /\ calls' = c + 1 /\ (AuthSend \/ AuthSendFail)
     /\ st' = stNew /\ rs' = "O" /\ inbox' = inboxNew
     /\ UNCHANGED <<ws, isauth, retry, net, received, given, fails, dr>>

(* ---- client actions ---- *)

\* gd: run
Run == st = "IDLE" /\ (ConnectOK \/ (ConnectErr))

\* gd: send_event (called by register_player, share, ...)
UserSend ==
  /\ given < N /\ given' = given + 1 /\ SendEvOp(given + 1, rs)
  /\ UNCHANGED <<st, ws, rs, isauth, att, retry, net, inbox, received, fails, calls, dr>>

\* gd: _process, state WAITING_RETRY, timer expired
TickWait == st = "WAITING_RETRY" /\ (ConnectOK \/ ConnectErr)

\* gd: _process, poll shows STATE_CLOSED
TickClosed == st \in {"CONNECTING", "AUTHENTICATING", "CONNECTED"} /\ rsP = "X"
              /\ ConnLost /\ KeepOnLoss

\* gd: _process, CONNECTING, connect timer expired
TickConnTimeout == ~COOP /\ st = "CONNECTING" /\ rsP = "C" /\ ConnLost /\ KeepOnLoss

\* gd: _process, CONNECTING, socket open: auth_attempt = 0; _begin_auth_attempt
TickConnOpen == st = "CONNECTING" /\ rsP = "O" /\ BeginAuth(0, 0, "AUTHENTICATING", inbox)

\* gd: _flush_queue. The loop sends send_queue[0]. If _send_raw succeeds it pops the
\* event and appends it to unacked. It stops at the first failure. So k events go out
\* (the first k of the queue) and the rest stay in order.
\* FlushQ(q, u, k): q is the queue before the flush, u is unacked before the flush.
\* Effect on queue, unacked, out, fb.
FlushQ(q, u, k) ==
  LET ms == SubSeq(q, 1, k)
  IN /\ (k < Len(q) => CanFail)
     /\ FbAfter(k < Len(q))
     /\ queue' = SubSeq(q, k + 1, Len(q))
     /\ unacked' = u \o ms
     /\ out' = IF net = "U" THEN out \o ms ELSE out

\* gd: _on_authenticated. send_queue = unacked + send_queue; unacked = []; then _flush_queue().
OnAuth(r) ==
  \E k \in 0..(Len(unacked) + Len(queue)) :
    /\ FlushQ(unacked \o queue, <<>>, k)
    /\ isauth' = TRUE /\ st' = "CONNECTED" /\ retry' = 0 /\ fails' = 0
    /\ rs' = "O" /\ inbox' = r
    /\ UNCHANGED <<ws, att, net, received, given, calls, preauth, dr>>

\* gd: _process, CONNECTED, _flush_queue() before the packet loop
TickFlush ==
  /\ st = "CONNECTED" /\ rsP = "O"
  /\ \E k \in 0..Len(queue) : FlushQ(queue, unacked, k)
  /\ rs' = "O"
  /\ UNCHANGED <<st, ws, isauth, att, retry, net, inbox, received, given, fails, calls, preauth, dr>>

\* gd: _process, AUTHENTICATING, a packet is available
TickAuthPkt ==
  /\ st = "AUTHENTICATING" /\ rsP = "O" /\ inbox # <<>>
  /\ IF Head(inbox).k = "ok" THEN OnAuth(Tail(inbox))
     ELSE BeginAuth(att, calls, "AUTHENTICATING", Tail(inbox))

\* gd: _process, AUTHENTICATING, no packet, auth timer expired
TickAuthTimeout ==
  ~COOP /\ st = "AUTHENTICATING" /\ rsP = "O" /\ inbox = <<>>
  /\ BeginAuth(att, calls, "AUTHENTICATING", inbox)

\* gd: _process, CONNECTED, packet loop. The gd loop reads all packets after the
\* flush. The model reads one packet per step, without a flush. This allows more
\* interleavings than gd (a safe over-approximation).
TickConnected ==
  /\ st = "CONNECTED" /\ rsP = "O" /\ inbox # <<>>
  /\ inbox' = Tail(inbox) /\ rs' = "O"
  /\ LET p == Head(inbox) IN
     IF p.k = "inc" /\ given < N       \* gd: event_handler "player_incoming" -> ack
        THEN SendEvOp(given + 1, "O") /\ given' = given + 1
     ELSE IF p.k = "ack"               \* gd: event_handler "ack" -> _handle_ack
        THEN /\ unacked' = Above(unacked, p.n) /\ queue' = Above(queue, p.n)
             /\ UNCHANGED <<out, preauth, given, fb>>
     ELSE UNCHANGED <<queue, unacked, out, preauth, given, fb>>
  /\ UNCHANGED <<st, ws, isauth, att, retry, net, received, fails, calls, dr>>

(* ---- environment actions ---- *)
NetAccept == net = "P" /\ net' = "U"
             /\ UNCHANGED <<st, ws, rs, isauth, queue, unacked, att, retry, out, inbox, received, given, fails, calls, preauth, fb, dr>>
NetFail == ~COOP /\ net = "P" /\ net' = "D"
             /\ UNCHANGED <<st, ws, rs, isauth, queue, unacked, att, retry, out, inbox, received, given, fails, calls, preauth, fb, dr>>
\* The connection drops. Messages on the wire that the server has not read are lost.
\* In COOP the network may do this only LOSS_MAX times.
NetDrop == net = "U" /\ (~COOP \/ dr < LOSS_MAX) /\ net' = "D" /\ out' = <<>>
             /\ dr' = (IF COOP THEN dr + 1 ELSE dr)
             /\ UNCHANGED <<st, ws, rs, isauth, queue, unacked, att, retry, inbox, received, given, fails, calls, preauth, fb>>
ServerPush == ~COOP /\ net = "U" /\ Len(inbox) < 2
             /\ \E p \in {"bad", "inc"} : inbox' = Append(inbox, Pk(p))
             /\ UNCHANGED <<st, ws, rs, isauth, queue, unacked, att, retry, net, out, received, given, fails, calls, preauth, fb, dr>>
\* The server reads one message from the wire.
\* App message m: dedupe by seq. A new seq goes into "received". A seq seen before is
\* ignored. In both cases the server may send {"event":"ack","seq":n} with n = the
\* highest seq such that all seq <= n are received (cumulative). In the lossy
\* environment it may also send no ack (the ack is lost or late).
ServerRecv ==
  /\ net = "U" /\ out # <<>>
  /\ LET m == Head(out) IN
     IF m # 0
       THEN /\ out' = Tail(out)
            /\ received' = received \cup {m}
            /\ \/ inbox' = Append(inbox, Ack(Contig(received \cup {m})))
               \/ (~COOP /\ inbox' = inbox)
            /\ UNCHANGED net
       ELSE /\ UNCHANGED received
            /\ \/ /\ out' = Tail(out) /\ inbox' = Append(inbox, Pk("ok")) /\ UNCHANGED net          \* auth_ok
               \/ /\ ~COOP /\ out' = Tail(out) /\ inbox' = Append(inbox, Pk("bad")) /\ UNCHANGED net \* other reply
               \/ /\ ~COOP /\ out' = Tail(out) /\ UNCHANGED <<net, inbox>>                            \* ignore
               \/ /\ ~COOP /\ net' = "D" /\ out' = <<>> /\ inbox' = inbox                            \* close
  /\ UNCHANGED <<st, ws, rs, isauth, queue, unacked, att, retry, given, fails, calls, preauth, fb, dr>>

\* No step left: avoids a TLC deadlock report in the two end states.
Done == (st = "STOPPED" \/ (COOP /\ st = "CONNECTED")) /\ UNCHANGED vars

Next == Run \/ UserSend \/ TickWait \/ TickFlush \/ TickClosed \/ TickConnTimeout \/ TickConnOpen
        \/ TickAuthPkt \/ TickAuthTimeout \/ TickConnected
        \/ NetAccept \/ NetFail \/ NetDrop \/ ServerPush \/ ServerRecv \/ Done

Fair == /\ WF_vars(Run) /\ WF_vars(TickWait) /\ WF_vars(TickConnOpen)
        /\ WF_vars(TickAuthPkt) /\ WF_vars(TickFlush) /\ WF_vars(NetAccept) /\ WF_vars(ServerRecv)
        /\ WF_vars(TickConnected) /\ WF_vars(TickClosed)

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fair

(* ---- invariants (all must hold) ---- *)
TypeOK ==
  /\ st \in {"IDLE", "CONNECTING", "AUTHENTICATING", "CONNECTED", "WAITING_RETRY", "STOPPED"}
  /\ ws \in BOOLEAN /\ rs \in {"N", "C", "O", "X"} /\ isauth \in BOOLEAN
  /\ net \in {"N", "P", "U", "D"} /\ queue \in Seq(1..N) /\ unacked \in Seq(1..N)
  /\ out \in Seq(0..N) /\ received \subseteq 1..N /\ given \in 0..N
  /\ fb \in 0..FLAKY_MAX /\ dr \in 0..LOSS_MAX
  /\ \A i \in DOMAIN inbox : inbox[i].k \in {"ok", "bad", "inc", "ack"} /\ inbox[i].n \in 0..N

AuthImpliesConnected == isauth <=> (st = "CONNECTED")
WebsocketPresence == ws <=> (st \in {"CONNECTING", "AUTHENTICATING", "CONNECTED"})
AuthAttemptsBound ==
  /\ att <= AUTH_ATTEMPTS
  /\ (st \in {"AUTHENTICATING", "CONNECTED"} => att = calls)
RetryBound == retry <= MAX_RETRIES
StoppedOnlyAfterMaxRetries ==
  IF st = "STOPPED" THEN retry = MAX_RETRIES /\ fails = MAX_RETRIES + 1
  ELSE retry = fails
\* Bookkeeping of the client: an event is never in send_queue and in unacked at the
\* same time, never twice in one of them, and only given events are in them.
\* The server accepts only given events.
NoEventLost ==
  /\ Elems(queue) \cap Elems(unacked) = {}
  /\ Len(queue) + Len(unacked) = Cardinality(Elems(queue) \cup Elems(unacked))
  /\ Elems(queue) \cup Elems(unacked) \subseteq 1..given
  /\ received \subseteq 1..given

Safety == TypeOK /\ AuthImpliesConnected /\ WebsocketPresence /\ AuthAttemptsBound
          /\ RetryBound /\ StoppedOnlyAfterMaxRetries /\ NoEventLost

(* ---- S1, S2, S3, S4' hold for the shipped code. ---- *)
IsInc(s) == \A i, j \in DOMAIN s : i < j => s[i] < s[j]
S1_NoPreAuthAppSend == ~preauth
\* FIFO. Client: unacked and send_queue together are in given order (unacked first).
\* Wire: the events on the wire are in order. Server: it accepts events in the given
\* order, without a gap (received is a prefix 1..r).
S2_Fifo == /\ IsInc(unacked \o queue)
           /\ IsInc(AppOf(out))
           /\ received = 1..Cardinality(received)
S3_NoAuthInQueue == Count0(queue) = 0 /\ Count0(unacked) = 0
\* S4' (at-least-once, safety, lossy environment). An event leaves the client state
\* (send_queue and unacked) only if the server has received it. A lost message
\* stays in unacked, so it is sent again after the next authentication.
\* The old S4 ("no event lost with the socket") is not a property of this protocol:
\* a message can be lost with the socket, but the client keeps it.
S4_AtLeastOnceSafe == \A k \in 1..given : k \in Elems(queue) \cup Elems(unacked) \cup received

(* ---- temporal properties ---- *)
StoppedAbsorbing == [][st = "STOPPED" => st' = "STOPPED"]_vars   \* holds under Spec
\* Under FairSpec with COOP = TRUE:
CoopNeverGivesUp == [](st # "STOPPED")
CoopReachesConnected == <>(st = "CONNECTED")
CoopStaysConnected == <>[](st = "CONNECTED")
\* Under FairSpec with COOP = TRUE, FLAKY_MAX > 0 (ControlRoomClientFlaky.cfg):
\* a non-empty send_queue in CONNECTED eventually empties.
QueueDrains == [](st = "CONNECTED" /\ queue # <<>> => <>(queue = <<>>))
\* S4' (at-least-once, liveness). Under FairSpec with COOP = TRUE: every event that is
\* given is eventually received by the server, and eventually acked (it leaves the
\* client state). With LOSS_MAX > 0 (ControlRoomClientRecover.cfg) the network may drop
\* the connection LOSS_MAX times, and the claim still holds.
CoopEventuallyReceived == \A k \in 1..N : (k <= given) ~> (k \in received)
CoopEventuallyAcked == \A k \in 1..N : (k <= given) ~> (k \notin Elems(queue) \cup Elems(unacked))
=============================================================================
