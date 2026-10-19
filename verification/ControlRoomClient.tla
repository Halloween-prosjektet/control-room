------------------------- MODULE ControlRoomClient -------------------------
(***************************************************************************)
(* TLA+ model of control_room_client.gd (Godot client) in a lossy          *)
(* environment. It models the shipped code. It is the same model as the    *)
(* "fixed" variant of model_check.py.                                      *)
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
          FLAKY_MAX       \* COOP only: send_text may fail this many times (0 = never)

VARIABLES
  st,       \* _state
  ws,       \* websocket /= null
  rs,       \* ready state that the client last saw: "N" none, "C" connecting, "O" open, "X" closed
  isauth,   \* is_authenticated
  queue,    \* send_queue (app events only)
  att,      \* _auth_attempt
  retry,    \* _retry_amount
  net,      \* real transport: "N" none, "P" pending, "U" up, "D" dead
  out,      \* messages on the wire that the server has not read
  inbox,    \* packets from the server that the client has not read
  sent,     \* app events for which send_text returned OK, in order
  lost,     \* app events lost with the socket after send_text returned OK
  given,    \* number of app events given to send_event
  fails,    \* history: connection losses since last authentication
  calls,    \* history: calls of _begin_auth_attempt on this connection
  preauth,  \* history: an app event went on the wire while not authenticated
  fb        \* history: failed sends so far (counted only if COOP)

vars == <<st, ws, rs, isauth, queue, att, retry, net, out, inbox,
          sent, lost, given, fails, calls, preauth, fb>>

IsApp(m) == m # 0
AppOf(ms) == SelectSeq(ms, IsApp)
Elems(s) == {s[i] : i \in DOMAIN s}
Count0(q) == Cardinality({i \in DOMAIN q : q[i] = 0})

RECURSIVE Sel(_, _, _, _)
Sel(q, oks, b, i) ==
  IF i > Len(q) THEN <<>>
  ELSE IF oks[i] = b THEN <<q[i]>> \o Sel(q, oks, b, i + 1)
  ELSE Sel(q, oks, b, i + 1)

CanFail == ~COOP \/ fb < FLAKY_MAX               \* may a send_text fail now?
FbAfter(failed) == fb' = IF failed /\ COOP THEN fb + 1 ELSE fb

rsP == IF net = "P" THEN "C" ELSE IF net = "U" THEN "O" ELSE "X"  \* websocket.poll()

Init ==
  /\ st = "IDLE" /\ ws = FALSE /\ rs = "N" /\ isauth = FALSE /\ queue = <<>>
  /\ att = 0 /\ retry = 0 /\ net = "N" /\ out = <<>> /\ inbox = <<>>
  /\ sent = <<>> /\ lost = {} /\ given = 0 /\ fails = 0 /\ calls = 0
  /\ preauth = FALSE /\ fb = 0

(* gd: _connection_lost. Callers must say what happens to
   queue, att, calls, sent, given, preauth. *)
ConnLost ==
  /\ isauth' = FALSE /\ ws' = FALSE /\ rs' = "N" /\ inbox' = <<>>
  /\ net' = "N" /\ out' = <<>>
  /\ lost' = lost \cup Elems(AppOf(out))   \* websocket.close(): unread messages are lost
  /\ fails' = fails + 1
  /\ IF retry >= MAX_RETRIES
        THEN st' = "STOPPED" /\ retry' = retry
        ELSE st' = "WAITING_RETRY" /\ retry' = retry + 1
KeepOnLoss == UNCHANGED <<queue, att, calls, sent, given, preauth, fb>>

(* gd: _connect, success branch *)
ConnectOK ==
  /\ ws' = TRUE /\ rs' = "C" /\ net' = "P" /\ st' = "CONNECTING" /\ inbox' = <<>>
  /\ UNCHANGED <<isauth, queue, att, retry, out, sent, lost, given, fails, calls, preauth, fb>>
(* gd: _connect, connect_to_url returned an error *)
ConnectErr == ~COOP /\ ConnLost /\ KeepOnLoss

(* gd: send_event(msg), msg > 0. Describes queue, sent, out, lost, preauth only.
   It sends only if is_authenticated and send_queue is empty and _send_raw
   succeeds. Else it appends msg to send_queue. *)
SendEvOp(msg, r) ==   \* r: ready state that _send_raw sees
  LET fail == /\ queue' = Append(queue, msg) /\ UNCHANGED <<sent, out, lost, preauth>>
              /\ FbAfter(TRUE)
      ok == /\ queue' = queue /\ FbAfter(FALSE)
            /\ sent' = sent \o <<msg>>
            /\ out' = IF net = "U" THEN out \o <<msg>> ELSE out
            /\ lost' = IF net = "U" THEN lost ELSE lost \cup {msg}
            /\ preauth' = (preauth \/ ~isauth)
  IN IF isauth /\ queue = <<>> /\ ws /\ r = "O"
        THEN ok \/ (CanFail /\ fail)
        ELSE (queue' = Append(queue, msg) /\ UNCHANGED <<sent, out, lost, preauth, fb>>)

(* gd: _send_raw({"event": "auth", ...}) in _begin_auth_attempt.
   The result is ignored. The auth message is not queued. *)
AuthSend ==
  /\ out' = IF net = "U" THEN out \o <<0>> ELSE out
  /\ UNCHANGED <<queue, sent, lost, preauth, fb>>
AuthSendFail == ~COOP /\ UNCHANGED <<queue, sent, out, lost, preauth, fb>>   \* flaky mode fails app sends only

(* gd: _begin_auth_attempt *)
BeginAuth(a, c, stNew, inboxNew) ==
  \/ /\ a >= AUTH_ATTEMPTS /\ att' = a /\ calls' = c /\ ConnLost
     /\ UNCHANGED <<queue, sent, given, preauth, fb>>
  \/ /\ a < AUTH_ATTEMPTS /\ att' = a + 1 /\ calls' = c + 1 /\ (AuthSend \/ AuthSendFail)
     /\ st' = stNew /\ rs' = "O" /\ inbox' = inboxNew
     /\ UNCHANGED <<ws, isauth, retry, net, given, fails>>

(* ---- client actions ---- *)

\* gd: run
Run == st = "IDLE" /\ (ConnectOK \/ (ConnectErr))

\* gd: send_event (called by register_player, share, ...)
UserSend ==
  /\ given < N /\ given' = given + 1 /\ SendEvOp(given + 1, rs)
  /\ UNCHANGED <<st, ws, rs, isauth, att, retry, net, inbox, fails, calls>>

\* gd: _process, state WAITING_RETRY, timer expired
TickWait == st = "WAITING_RETRY" /\ (ConnectOK \/ ConnectErr)

\* gd: _process, poll shows STATE_CLOSED
TickClosed == st \in {"CONNECTING", "AUTHENTICATING", "CONNECTED"} /\ rsP = "X"
              /\ ConnLost /\ KeepOnLoss

\* gd: _process, CONNECTING, connect timer expired
TickConnTimeout == ~COOP /\ st = "CONNECTING" /\ rsP = "C" /\ ConnLost /\ KeepOnLoss

\* gd: _process, CONNECTING, socket open: auth_attempt = 0; _begin_auth_attempt
TickConnOpen == st = "CONNECTING" /\ rsP = "O" /\ BeginAuth(0, 0, "AUTHENTICATING", inbox)

\* gd: _flush_queue. The loop sends send_queue[0] and pops it only if
\* _send_raw succeeds. It stops at the first failure. So k events go out
\* (the first k of the queue) and the rest stay in order.
\* Flush(k): effect on queue, sent, out, lost, fb.
Flush(k) ==
  LET ms == SubSeq(queue, 1, k)
  IN /\ (k < Len(queue) => CanFail)
     /\ FbAfter(k < Len(queue))
     /\ queue' = SubSeq(queue, k + 1, Len(queue))
     /\ sent' = sent \o ms
     /\ out' = IF net = "U" THEN out \o ms ELSE out
     /\ lost' = IF net = "U" THEN lost ELSE lost \cup Elems(ms)

\* gd: _on_authenticated
OnAuth(r) ==
  \E k \in 0..Len(queue) :
    /\ Flush(k)
    /\ isauth' = TRUE /\ st' = "CONNECTED" /\ retry' = 0 /\ fails' = 0
    /\ rs' = "O" /\ inbox' = r
    /\ UNCHANGED <<ws, att, net, given, calls, preauth>>

\* gd: _process, CONNECTED, _flush_queue() before the packet loop
TickFlush ==
  /\ st = "CONNECTED" /\ rsP = "O"
  /\ \E k \in 0..Len(queue) : Flush(k)
  /\ rs' = "O"
  /\ UNCHANGED <<st, ws, isauth, att, retry, net, inbox, given, fails, calls, preauth>>

\* gd: _process, AUTHENTICATING, a packet is available
TickAuthPkt ==
  /\ st = "AUTHENTICATING" /\ rsP = "O" /\ inbox # <<>>
  /\ IF Head(inbox) = "ok" THEN OnAuth(Tail(inbox))
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
  /\ IF Head(inbox) = "inc" /\ given < N       \* gd: event_handler "player_incoming" -> ack
        THEN SendEvOp(given + 1, "O") /\ given' = given + 1
        ELSE UNCHANGED <<queue, sent, out, lost, preauth, given, fb>>
  /\ UNCHANGED <<st, ws, isauth, att, retry, net, fails, calls>>

(* ---- environment actions ---- *)
Unch(xs) == UNCHANGED xs

NetAccept == net = "P" /\ net' = "U"
             /\ UNCHANGED <<st, ws, rs, isauth, queue, att, retry, out, inbox, sent, lost, given, fails, calls, preauth, fb>>
NetFail == ~COOP /\ net = "P" /\ net' = "D"
             /\ UNCHANGED <<st, ws, rs, isauth, queue, att, retry, out, inbox, sent, lost, given, fails, calls, preauth, fb>>
NetDrop == ~COOP /\ net = "U" /\ net' = "D" /\ out' = <<>>
             /\ lost' = lost \cup Elems(AppOf(out))
             /\ UNCHANGED <<st, ws, rs, isauth, queue, att, retry, inbox, sent, given, fails, calls, preauth, fb>>
ServerPush == ~COOP /\ net = "U" /\ Len(inbox) < 2
             /\ \E p \in {"bad", "inc"} : inbox' = Append(inbox, p)
             /\ UNCHANGED <<st, ws, rs, isauth, queue, att, retry, net, out, sent, lost, given, fails, calls, preauth, fb>>
\* server reads one message from the wire
ServerRecv ==
  /\ net = "U" /\ out # <<>>
  /\ LET m == Head(out) IN
     IF m # 0
       THEN /\ out' = Tail(out) /\ UNCHANGED <<net, inbox, lost>>
     ELSE \/ /\ out' = Tail(out) /\ inbox' = Append(inbox, "ok") /\ UNCHANGED <<net, lost>>     \* auth_ok
          \/ /\ ~COOP /\ out' = Tail(out) /\ inbox' = Append(inbox, "bad") /\ UNCHANGED <<net, lost>> \* other reply
          \/ /\ ~COOP /\ out' = Tail(out) /\ UNCHANGED <<net, inbox, lost>>                          \* ignore
          \/ /\ ~COOP /\ net' = "D" /\ out' = <<>> /\ inbox' = inbox                                \* close
             /\ lost' = lost \cup Elems(AppOf(Tail(out)))
  /\ UNCHANGED <<st, ws, rs, isauth, queue, att, retry, sent, given, fails, calls, preauth, fb>>

\* No step left: avoids a TLC deadlock report in the two end states.
Done == (st = "STOPPED" \/ (COOP /\ st = "CONNECTED")) /\ UNCHANGED vars

Next == Run \/ UserSend \/ TickWait \/ TickFlush \/ TickClosed \/ TickConnTimeout \/ TickConnOpen
        \/ TickAuthPkt \/ TickAuthTimeout \/ TickConnected
        \/ NetAccept \/ NetFail \/ NetDrop \/ ServerPush \/ ServerRecv \/ Done

Fair == /\ WF_vars(Run) /\ WF_vars(TickWait) /\ WF_vars(TickConnOpen)
        /\ WF_vars(TickAuthPkt) /\ WF_vars(TickFlush) /\ WF_vars(NetAccept) /\ WF_vars(ServerRecv)

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fair

(* ---- invariants (all must hold) ---- *)
TypeOK ==
  /\ st \in {"IDLE", "CONNECTING", "AUTHENTICATING", "CONNECTED", "WAITING_RETRY", "STOPPED"}
  /\ ws \in BOOLEAN /\ rs \in {"N", "C", "O", "X"} /\ isauth \in BOOLEAN
  /\ net \in {"N", "P", "U", "D"} /\ queue \in Seq(1..N) /\ out \in Seq(0..N)
  /\ sent \in Seq(1..N) /\ lost \subseteq 1..N /\ given \in 0..N /\ fb \in 0..FLAKY_MAX

AuthImpliesConnected == isauth <=> (st = "CONNECTED")
WebsocketPresence == ws <=> (st \in {"CONNECTING", "AUTHENTICATING", "CONNECTED"})
AuthAttemptsBound ==
  /\ att <= AUTH_ATTEMPTS
  /\ (st \in {"AUTHENTICATING", "CONNECTED"} => att = calls)
RetryBound == retry <= MAX_RETRIES
StoppedOnlyAfterMaxRetries ==
  IF st = "STOPPED" THEN retry = MAX_RETRIES /\ fails = MAX_RETRIES + 1
  ELSE retry = fails
NoEventLost ==
  /\ Len(AppOf(queue)) + Len(sent) = given
  /\ Elems(AppOf(queue)) \cup Elems(sent) = 1..given
  /\ lost \subseteq Elems(sent)

Safety == TypeOK /\ AuthImpliesConnected /\ WebsocketPresence /\ AuthAttemptsBound
          /\ RetryBound /\ StoppedOnlyAfterMaxRetries /\ NoEventLost

(* ---- S1, S2, S3 hold for the shipped code (checked in the main cfg). ---- *)
(* S4 does not hold. It is an accepted protocol limit (see README).         *)
IsInc(s) == \A i, j \in DOMAIN s : i < j => s[i] < s[j]
S1_NoPreAuthAppSend == ~preauth
S2_Fifo == /\ IsInc(sent) /\ IsInc(AppOf(queue))
           /\ (sent = <<>> \/ AppOf(queue) = <<>> \/ sent[Len(sent)] < AppOf(queue)[1])
S3_NoAuthInQueue == Count0(queue) = 0
S4_NoLossWithSocket == lost = {}

(* ---- temporal properties ---- *)
StoppedAbsorbing == [][st = "STOPPED" => st' = "STOPPED"]_vars   \* holds under Spec
\* Under FairSpec with COOP = TRUE:
CoopNeverGivesUp == [](st # "STOPPED")
CoopReachesConnected == <>(st = "CONNECTED")
CoopStaysConnected == <>[](st = "CONNECTED")
\* Under FairSpec with COOP = TRUE, FLAKY_MAX > 0 (ControlRoomClientFlaky.cfg):
\* a non-empty send_queue in CONNECTED eventually empties.
QueueDrains == [](st = "CONNECTED" /\ queue # <<>> => <>(queue = <<>>))
=============================================================================
