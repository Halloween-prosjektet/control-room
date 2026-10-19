#!/usr/bin/env python3
"""Explicit-state model checker for ControlRoomClient (control_room_client.gd).

Run with:  python3 -I verification/model_check.py

The model is a hand translation of the GDScript. Each transition cites the
GDScript function it mirrors. The client runs in a lossy environment.
Time is abstracted: a timer that expires is the nondeterministic input
"elapsed". Only the Python standard library is used.

Variants of the client:
  fixed   - the shipped code (baseline): send_event sends only if authenticated
            and the queue is empty and _send_raw succeeds, else it queues; auth
            goes through _send_raw and is never queued; the flush in
            _on_authenticated sends send_queue[0], pops only on success and
            stops at the first failure.
  asis    - the legacy code before the repair (reference only: S1, S2, S3 fail).
  mutants - deliberately broken copies of fixed. Each must be killed.
"""
import sys
from collections import namedtuple, deque
from itertools import product

# ---- bounds (small, so the search is exhaustive) -------------------------
AUTH_ATTEMPTS = 2      # GDScript: 3
MAX_RETRIES = 2        # GDScript: 10
N_EVENTS = 2           # max number of app events given to send_event
FLAKY_MAX = 2         # bound: failed sends allowed in the flaky cooperative graph
AUTH_Q_CAP = 1         # bound: max auth messages that a failed send may queue

IDLE, CONNECTING, AUTHENTICATING, CONNECTED, WAITING_RETRY, STOPPED = (
    "IDLE", "CONNECTING", "AUTHENTICATING", "CONNECTED", "WAITING_RETRY", "STOPPED")

# S: client variables + environment variables + history variables.
#  st      _state
#  ws      websocket != null
#  rs      ready state that the client last saw: N none, C connecting, O open, X closed
#  isauth  is_authenticated
#  queue   send_queue; item 0 is an auth message, item k>0 is app event k
#  att     _auth_attempt        retry  _retry_amount
#  net     real transport: N none, P pending, U up, D dead
#  out     messages on the wire that the server has not read yet
#  inbox   packets from server that the client has not read yet
#  sent    app events for which send_text returned OK (in order)
#  lost    app events lost with the socket after send_text returned OK
#  given   number of app events given to send_event
#  fails   history: losses since last authentication
#  calls   history: calls of _begin_auth_attempt on this connection
#  preauth history: an app event went on the wire while not authenticated
#  early   history: a queued event went on the wire while not authenticated
#  fb      history: failed sends so far (counted only in the cooperative environment)
S = namedtuple("S", "st ws rs isauth queue att retry net out inbox sent lost "
                    "given fails calls preauth early fb")
INIT = S(IDLE, False, "N", False, (), 0, 0, "N", (), (), (), (), 0, 0, 0, False, False, 0)


class Model:
    def __init__(self, fixed=True, mutant=None, coop=False, flaky=0):
        self.fixed = fixed
        self.m = mutant
        self.coop = coop    # cooperative environment (for liveness)
        self.flaky = flaky  # coop only: at most this many send_text failures

    # ---- helpers ---------------------------------------------------------
    def _lose(self, s, ids):
        app = [i for i in ids if i != 0]
        return s._replace(lost=tuple(sorted(set(s.lost) | set(app))))

    def _close_transport(self, s):
        # websocket.close(): model pessimistically. Unread messages are lost.
        s = self._lose(s, s.out)
        return s._replace(net="N", out=())

    def _try_send(self, s, msg, from_queue):
        """WebSocketPeer.send_text. Returns list of (state, ok)."""
        res = []
        # Bound: a failed auth send is queued by the as-is code, so the queue
        # can grow without limit. Cap the number of auth messages in the queue.
        if self.coop:
            if s.fb < self.flaky and msg != 0:      # flaky mode fails app sends only
                res.append((s._replace(fb=s.fb + 1), False))
        elif not (msg == 0 and s.queue.count(0) >= AUTH_Q_CAP):
            res.append((s, False))            # send_text returns an error
        t = s
        if msg != 0:
            t = t._replace(sent=t.sent + (msg,))
            if not t.isauth:
                t = t._replace(preauth=True)
                if from_queue:
                    t = t._replace(early=True)
        if t.net == "U":
            t = t._replace(out=t.out + (msg,))
        else:                                  # socket already dead, not yet polled
            t = self._lose(t, (msg,))
        res.append((t, True))
        return res

    # ---- send_event (gd: send_event) -----------------------------------
    def send_event(self, s, msg):
        can = s.ws and s.rs == "O"
        if self.fixed:
            if msg == 0 and self.m != "auth_queued":
                # gd: _begin_auth_attempt calls _send_raw. Failure is ignored.
                return [t for t, ok in self._try_send(s, 0, False)] if can else [s]
            if msg != 0:
                if self.m != "send_unauth":    # mutant: socket open is enough
                    can = can and s.isauth
                can = can and not s.queue
        if not can:
            return [s._replace(queue=s.queue + (msg,))]
        out = []
        for t, ok in self._try_send(s, msg, False):
            out.append(t if ok else t._replace(queue=t.queue + (msg,)))
        return out

    # ---- loop in _on_authenticated (gd: _on_authenticated) ----------------
    def flush(self, s, from_auth_entry=False):
        q = s.queue
        n = len(q)
        if n == 0:
            return [s]
        results = []
        if self.fixed:
            def rec(t):                        # gd: while not send_queue.is_empty()
                if not t.queue:
                    results.append(t); return
                head = t.queue[0]
                if self.m == "pop_first":      # mutant: pop before send
                    for u, ok in self._try_send(t._replace(queue=t.queue[1:]), head, True):
                        if ok: rec(u)
                        else: results.append(u)        # event lost, loop stops
                    return
                for u, ok in self._try_send(t, head, True):
                    if ok:
                        rec(u._replace(queue=u.queue[1:]))
                    elif self.m == "flush_drop":       # mutant: drop, go on
                        rec(u._replace(queue=u.queue[1:]))
                    else:
                        results.append(u)              # stop at first failure
            def rq(t, left):                   # mutant: old loop, size times
                if left == 0:
                    results.append(t); return
                head, rest = t.queue[0], t.queue[1:]
                for u, ok in self._try_send(t._replace(queue=rest), head, True):
                    rq(u if ok else u._replace(queue=u.queue + (head,)), left - 1)
            if self.m == "flush_requeue":
                rq(s, n)
            else:
                rec(s)
            return results
        # as-is: for _i in range(size): send_event(pop_front()); failure re-appends
        # so result = failed events in order. Outcomes per event are independent.
        for oks in product([True, False], repeat=n):
            if self.coop and not all(oks): continue
            if not (s.ws and s.rs == "O") and any(oks): continue
            t = s._replace(queue=())
            ok_states = [t]
            failed = []
            for msg, ok in zip(q, oks):
                if ok:
                    nxt = []
                    for u in ok_states:
                        nxt += [x for x, o in self._try_send(u, msg, True) if o]
                    ok_states = nxt
                else:
                    failed.append(msg)
            keep = tuple(failed)
            for u in ok_states:
                results.append(u._replace(queue=keep))
        return results

    # ---- _connection_lost -------------------------------------------------
    def connection_lost(self, s):
        s = self._close_transport(s)
        s = s._replace(
            isauth=s.isauth if self.m == "keep_isauth" else False,
            ws=True if self.m == "ws_kept" else False,
            rs="X" if self.m == "ws_kept" else "N",
            inbox=(), fails=min(s.fails + 1, MAX_RETRIES + 3))  # capped: keeps no_stop finite
        if self.m == "clear_queue":
            s = s._replace(queue=())
        limit_hit = {"retry_off": s.retry > MAX_RETRIES,
                     "early_stop": s.retry >= MAX_RETRIES - 1}.get(
                         self.m, s.retry >= MAX_RETRIES)
        if limit_hit:
            if self.m == "no_stop":            # never gives up
                return s._replace(st=WAITING_RETRY)
            return s._replace(st=STOPPED)      # gave_up.emit()
        return s._replace(retry=s.retry + 1, st=WAITING_RETRY)

    # ---- _connect ---------------------------------------------------------
    def connect(self, s):
        res = []
        if not self.coop:                      # connect_to_url returned an error
            res.append(self.connection_lost(s))
        res.append(s._replace(ws=True, rs="C", net="P", st=CONNECTING, inbox=()))
        return res

    # ---- _begin_auth_attempt ----------------------------------------------
    def begin_auth(self, s):
        over = s.att > AUTH_ATTEMPTS if self.m == "att_off" else s.att >= AUTH_ATTEMPTS
        if over:
            return [self.connection_lost(s)]
        s = s._replace(att=s.att + 1, calls=s.calls + 1)
        return self.send_event(s, 0)

    # ---- _on_authenticated ------------------------------------------------
    def on_authenticated(self, s):
        s = s._replace(isauth=True, st=CONNECTED, fails=0)
        if self.m != "no_retry_reset":
            s = s._replace(retry=0)
        return self.flush(s)

    # ---- _process (one tick) ----------------------------------------------
    def tick(self, s, elapsed):
        if s.st in (IDLE, STOPPED):
            return []
        if s.st == WAITING_RETRY:
            return self.connect(s) if elapsed else []
        s = s._replace(rs={"P": "C", "U": "O", "D": "X"}[s.net])   # websocket.poll()
        if s.rs == "X":
            return [self.connection_lost(s)]
        if s.st == CONNECTING:
            if s.rs == "O":
                nxt = [s._replace(st=AUTHENTICATING,
                                  att=s.att if self.m == "no_reset_att" else 0,
                                  calls=0)]
                if self.m == "flush_early":
                    nxt = [y for x in nxt for y in self.flush(x)]
                return [z for x in nxt for z in self.begin_auth(x)]
            return [self.connection_lost(s)] if elapsed else [s]
        if s.st == AUTHENTICATING:
            if s.inbox:
                pkt, s = s.inbox[0], s._replace(inbox=s.inbox[1:])
                return self.on_authenticated(s) if pkt == "ok" else self.begin_auth(s)
            return self.begin_auth(s) if elapsed else [s]
        # CONNECTED. gd: _flush_queue() first, then the packet loop. The model
        # splits this into the flush (here) and one packet read (read_packet).
        if self.m == "no_tick_flush" or not self.fixed:    # mutant / legacy: no flush
            return [s]
        return self.flush(s)

    def read_packet(self, s):
        """gd: _process, CONNECTED, packet loop (one packet per step)."""
        t = s._replace(rs="O")
        pkt, t = t.inbox[0], t._replace(inbox=t.inbox[1:])
        if pkt == "inc" and t.given < N_EVENTS:     # event_handler: ack
            t = t._replace(given=t.given + 1)
            return self.send_event(t, t.given)
        return [t]

    # ---- all transitions --------------------------------------------------
    def succ(self, s):
        out = []
        def add(label, states):
            for t in states:
                if t != s: out.append((label, t))
        # client / user
        if s.st == IDLE:                                     # run()
            add("run", self.connect(s._replace(retry=0, fails=0)))
        if s.given < N_EVENTS:                               # user calls send_event
            t = s._replace(given=s.given + 1)
            add("send_event(%d)" % t.given, self.send_event(t, t.given))
        for el in ((True,) if s.st == WAITING_RETRY else (False,)) if self.coop \
                else (False, True):
            add("tick(elapsed=%s)" % el, self.tick(s, el))
        if s.st == CONNECTED and s.net == "U" and s.inbox:
            add("read_packet", self.read_packet(s))
        # environment
        if s.net == "P":
            add("net_accept", [s._replace(net="U")])
            if not self.coop:
                add("net_fail", [s._replace(net="D")])
        if s.net == "U":
            if not self.coop:
                add("net_drop", [self._lose(s, s.out)._replace(net="D", out=())])
                if len(s.inbox) < 2:
                    for p in ("bad", "inc"):
                        add("server_push(%s)" % p, [s._replace(inbox=s.inbox + (p,))])
            if s.out:                                        # server reads one message
                m, r = s.out[0], s._replace(out=s.out[1:])
                if m != 0:
                    add("server_recv(app %d)" % m, [r])
                else:
                    add("server_accept_auth", [r._replace(inbox=r.inbox + ("ok",))])
                    if not self.coop:
                        add("server_reject_auth", [r._replace(inbox=r.inbox + ("bad",))])
                        add("server_ignore_auth", [r])
                        add("server_close", [self._lose(r, r.out)._replace(net="D", out=())])
        return out


# ---- exploration ----------------------------------------------------------
def explore(model, init=INIT):
    parent = {init: None}
    edges = {}
    dq = deque([init])
    while dq:
        s = dq.popleft()
        nxt = []
        for lab, t in model.succ(s):
            nxt.append(t)
            if t not in parent:
                parent[t] = (s, lab)
                dq.append(t)
        edges[s] = list(dict.fromkeys(nxt))
    return parent, edges


def trace(parent, s):
    steps = []
    while parent[s] is not None:
        p, lab = parent[s]
        steps.append(lab); s = p
    return list(reversed(steps))


# ---- state properties -----------------------------------------------------
def ids(q): return [i for i in q if i != 0]

CORE = {
 "is_authenticated <=> state CONNECTED": lambda s: s.isauth == (s.st == CONNECTED),
 "websocket exists <=> CONNECTING/AUTHENTICATING/CONNECTED":
     lambda s: s.ws == (s.st in (CONNECTING, AUTHENTICATING, CONNECTED)),
 "auth attempts <= AUTH_ATTEMPTS and counter = attempts made on this connection":
     lambda s: s.att <= AUTH_ATTEMPTS and
               (s.st not in (AUTHENTICATING, CONNECTED) or s.att == s.calls),
 "retry count <= MAX_RETRIES": lambda s: s.retry <= MAX_RETRIES,
 "retry count = losses since last auth; STOPPED only after MAX_RETRIES+1 losses":
     lambda s: (s.retry == s.fails if s.st != STOPPED
                else s.retry == MAX_RETRIES and s.fails == MAX_RETRIES + 1),
 "no event lost: given = queued + sent, no duplicates, lost only if sent":
     lambda s: (sorted(ids(s.queue) + list(s.sent)) == list(range(1, s.given + 1))
                and set(s.lost) <= set(s.sent)),
 "queued events are never written to the wire before auth": lambda s: not s.early,
}
# Properties that the code is expected NOT to satisfy (findings).
STRICT = {
 "S1 no app message on wire while unauthenticated": lambda s: not s.preauth,
 "S2 FIFO: sent and queue in given order, queue after sent":
     lambda s: (list(s.sent) == sorted(s.sent) and ids(s.queue) == sorted(ids(s.queue))
                and (not s.sent or not ids(s.queue) or max(s.sent) < min(ids(s.queue)))),
 "S3 send_queue never holds an auth message": lambda s: 0 not in s.queue,
 "S4 no event lost with the socket after send_text OK": lambda s: not s.lost,
}


def check_invariants(parent, props):
    res = {}
    for name, f in props.items():
        bad = next((s for s in parent if not f(s)), None)
        res[name] = (bad is None, bad)
    return res


# ---- graph analysis -------------------------------------------------------
def sccs(edges):
    idx, low, onst, stack, comp = {}, {}, set(), [], {}
    cnt = [0]; ncomp = [0]
    for root in edges:
        if root in idx: continue
        work = [(root, iter(edges[root]))]
        idx[root] = low[root] = cnt[0]; cnt[0] += 1
        stack.append(root); onst.add(root)
        while work:
            v, it = work[-1]
            adv = False
            for w in it:
                if w not in idx:
                    idx[w] = low[w] = cnt[0]; cnt[0] += 1
                    stack.append(w); onst.add(w)
                    work.append((w, iter(edges[w]))); adv = True; break
                elif w in onst:
                    low[v] = min(low[v], idx[w])
            if adv: continue
            work.pop()
            if work: low[work[-1][0]] = min(low[work[-1][0]], low[v])
            if low[v] == idx[v]:
                while True:
                    w = stack.pop(); onst.discard(w); comp[w] = ncomp[0]
                    if w == v: break
                ncomp[0] += 1
    return comp


def backward_reach(edges, targets):
    rev = {}
    for v, ws in edges.items():
        for w in ws: rev.setdefault(w, []).append(v)
    seen = set(targets); dq = deque(targets)
    while dq:
        v = dq.popleft()
        for u in rev.get(v, ()):
            if u not in seen: seen.add(u); dq.append(u)
    return seen


def liveness(parent, edges, coop_parent, coop_edges, flaky_edges=None):
    r = {}
    r["no deadlock (a state without moves is STOPPED)"] = \
        next((s for s, w in edges.items() if not w and s.st != STOPPED), None) is None
    good = backward_reach(edges, [s for s in edges if s.st in (CONNECTED, STOPPED)])
    r["from every state CONNECTED or STOPPED is reachable"] = len(good) == len(edges)
    r["CONNECTED is reachable from start"] = any(s.st == CONNECTED for s in edges)
    r["STOPPED is reachable from start"] = any(s.st == STOPPED for s in edges)
    comp = sccs(edges)
    has_out = {}
    for v, ws in edges.items():
        for w in ws:
            if comp[v] != comp[w]: has_out[comp[v]] = True
    bottom_bad = [v for v in edges if comp[v] not in has_out and v.st != STOPPED]
    r["STOPPED is absorbing and the only absorbing set"] = (
        all(t.st == STOPPED for s, w in edges.items() if s.st == STOPPED for t in w)
        and not bottom_bad)
    # cooperative environment, fair scheduling
    r["coop: STOPPED is never reached"] = all(s.st != STOPPED for s in coop_edges)
    cgood = backward_reach(coop_edges, [s for s in coop_edges if s.st == CONNECTED])
    r["coop: CONNECTED reachable from every coop state"] = len(cgood) == len(coop_edges)
    # no cycle among non-CONNECTED states => every fair run reaches CONNECTED
    sub = {v: [w for w in ws if w.st != CONNECTED and w != v]
           for v, ws in coop_edges.items() if v.st != CONNECTED}
    comp2 = sccs(sub)
    sizes = {}
    for v, c in comp2.items(): sizes[c] = sizes.get(c, 0) + 1
    r["coop: no cycle avoids CONNECTED (fair run must reach CONNECTED)"] = \
        all(n == 1 for n in sizes.values())
    if flaky_edges is not None:
        # cooperative network, send_text may fail FLAKY_MAX times, fair scheduling:
        # a non-empty queue in CONNECTED eventually empties.
        stuck = {v for v in flaky_edges if v.st == CONNECTED and v.queue}
        drained = backward_reach(flaky_edges, [v for v in flaky_edges
                                               if v.st == CONNECTED and not v.queue])
        sub = {v: [w for w in flaky_edges[v] if w in stuck] for v in stuck}
        comp3 = sccs(sub)
        sz = {}
        for v, c in comp3.items(): sz[c] = sz.get(c, 0) + 1
        r["flaky: non-empty queue in CONNECTED always drains (no stuck state, no cycle)"] = (
            stuck <= drained and all(n == 1 for n in sz.values()))
    return r


def run_variant(name, **kw):
    full = Model(**kw)
    parent, edges = explore(full)
    cm = Model(coop=True, **kw)
    cparent, cedges = explore(cm)
    inv = check_invariants(parent, CORE)
    strict = check_invariants(parent, STRICT)
    fstates = 0
    fedges = None
    if kw.get("fixed", True):
        _, fedges = explore(Model(coop=True, flaky=FLAKY_MAX, **kw))
        fstates = len(fedges)
    live = liveness(parent, edges, cparent, cedges, fedges)
    return dict(parent=parent, edges=edges, cstates=len(cedges), fstates=fstates, inv=inv,
                strict=strict, live=live)


def main():
    fail = False
    print("Bounds: AUTH_ATTEMPTS=%d MAX_RETRIES=%d N_EVENTS=%d" %
          (AUTH_ATTEMPTS, MAX_RETRIES, N_EVENTS))
    outcome = {}
    for vname, kw in (("fixed", {}), ("asis", {"fixed": False})):
        r = run_variant(vname, **kw)
        outcome[vname] = r
        ntr = sum(len(v) for v in r["edges"].values())
        print("\n=== variant: %s  (%d reachable states, %d transitions; "
              "%d coop states, %d flaky-coop states) ===" %
              (vname, len(r["edges"]), ntr, r["cstates"], r["fstates"]))
        print("-- core safety --")
        for n, (ok, bad) in r["inv"].items():
            print("  [%s] %s" % ("PASS" if ok else "FAIL", n))
            if not ok:
                fail = True; print("       trace:", trace(r["parent"], bad))
        print("-- liveness (graph analysis) --")
        for n, ok in r["live"].items():
            print("  [%s] %s" % ("PASS" if ok else "FAIL", n))
            fail |= not ok
        print("-- strict properties --")
        for n, (ok, bad) in r["strict"].items():
            if vname == "asis":
                tag = "legacy FINDING (violated)" if not ok else "not violated"
            elif n.startswith("S4"):
                tag = "accepted limit (violated, expected)" if not ok else "FAIL (S4 should be violated)"
                fail |= ok
            else:
                tag = "PASS" if ok else "FAIL"
                fail |= not ok
            print("  [%s] %s" % (tag, n))
            if not ok:
                print("       shortest trace:", trace(r["parent"], bad))
    # mutants
    print("\n=== mutation tests (each mutant of 'fixed' must be killed) ===")
    mutants = {
        "no_reset_att": "do not reset _auth_attempt on a new connection",
        "keep_isauth": "do not clear is_authenticated on connection loss",
        "flush_early": "flush send_queue before auth is sent",
        "retry_off": "off-by-one in MAX_RETRIES check (> instead of >=)",
        "early_stop": "off-by-one: give up one retry too early",
        "att_off": "off-by-one in AUTH_ATTEMPTS check (> instead of >=)",
        "flush_drop": "flush drops an event when send fails and goes on",
        "clear_queue": "connection loss clears send_queue",
        "ws_kept": "do not null websocket on connection loss",
        "no_retry_reset": "do not reset _retry_amount on authentication",
        "no_stop": "never enter STOPPED",
        "send_unauth": "send_event sends when socket is open but not authenticated (S1)",
        "flush_requeue": "failed flush event is re-appended to the back (S2)",
        "auth_queued": "auth is sent through the queue (S3)",
        "no_tick_flush": "no _flush_queue() in _process while CONNECTED (queue can stall)",
        "pop_first": "flush pops the event before it sends (event lost on failure)",
    }
    for m, desc in mutants.items():
        r = run_variant(m, mutant=m)
        killers = [n for n, (ok, _) in r["inv"].items() if not ok] + \
                  [n for n, (ok, _) in r["strict"].items()
                   if not ok and not n.startswith("S4")] + \
                  [n for n, ok in r["live"].items() if not ok]
        if killers:
            print("  [KILLED]   %-15s %s\n             by: %s" % (m, desc, killers[0]))
        else:
            fail = True
            print("  [SURVIVED] %-15s %s" % (m, desc))
    print("\nRESULT:", "FAIL" if fail else "ALL CHECKS PASSED")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
