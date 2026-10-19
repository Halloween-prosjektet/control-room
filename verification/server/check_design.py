#!/usr/bin/env python3
"""Independent explicit-state checker for the room pipeline design.

This file is a second implementation of the model in ControlRoomServer.tla
(docs/PLAN.md section 8). It does not read the TLA+ file. It explores all
reachable states (breadth first), checks the safety invariants on each state
and each step, checks the liveness properties with a fairness-aware SCC
analysis, runs the plan as written (to show the findings), and runs mutants
of the fixed design that must all be killed.

Run:  python3 -I verification/server/check_design.py   (exit code 0 = pass)
"""

import sys
import time
from collections import deque

EMPTY = ("empty", 0)


class Cfg:
    def __init__(self, **kw):
        self.ROOMS = 3
        self.RUNS = 2
        self.KEYS = ("a",)
        self.TARGETS = None  # default below
        self.MAX_SHARES = 0
        self.MAX_RESTARTS = 0
        self.MAX_DISC = 0
        self.MAX_DROPS = 0
        self.MAX_DUPS = 0
        self.DROP_REQUESTS = False
        self.MAX_UP = 1
        self.RETRY = True
        self.LEAVES = True
        self.ARBITRARY = False
        self.MAX_JUNK = 0
        self.FIX_ACK_ID = True
        self.FIX_NAME_CHECK = True
        self.FIX_STALE_INC = True
        self.FIX_PERSIST_SENT = True
        self.FIX_FINOK_ACK = True
        self.PI_DEDUP = True
        self.PI_SHARES_BEFORE_FINISH = True
        self.MUTANT = None
        for k, v in kw.items():
            if not hasattr(self, k):
                raise KeyError(k)
            setattr(self, k, v)
        if self.TARGETS is None:
            r = self.ROOMS
            self.TARGETS = (frozenset({0}), frozenset({r}), frozenset({1, r}))
        self.MAX_IDS = self.RUNS * 2 * self.ROOMS + 1


# State layout (a flat tuple, one field per TLA+ variable).
FIELDS = ("slot lastLeft status started fin shares outbox nextId conn cursor "
          "sent up down view ps seen entered got gsent quit pstart bad nextRun "
          "nShares restarts discs drops dups junk lastSent").split()
IX = {f: i for i, f in enumerate(FIELDS)}
NOMSG = ("none", 0, "-", frozenset(), 0)  # (ev, who, key, targets, id)


def setf(t, i, v):
    return t[:i] + (v,) + t[i + 1:]


def init_state(c):
    R, N = c.ROOMS, c.RUNS
    return (
        (EMPTY,) * R,                                   # slot
        (0,) * R,                                       # lastLeft
        ("none",) * N,                                  # status
        (frozenset(),) * N,                             # started
        (frozenset(),) * N,                             # fin
        tuple(tuple((frozenset(), 0) for _ in c.KEYS) for _ in range(N)),  # shares
        (),                                             # outbox
        1,                                              # nextId
        (True,) * R,                                    # conn
        (0,) * R,                                       # cursor
        frozenset(),                                    # sent
        ((),) * R,                                      # up
        ((),) * R,                                      # down
        (0,) * R,                                       # view
        ("idle",) * R,                                  # ps
        (0,) * R,                                       # seen
        (0,) * N,                                       # entered
        frozenset(), frozenset(), frozenset(),          # got gsent quit
        (0,) * N,                                       # pstart
        frozenset(),                                    # bad
        1, 0, 0, 0, 0, 0, 0,                            # nextRun..junk
        (NOMSG,) * R,                                   # lastSent
    )


# ---------------------------------------------------------------------------
# Server logic. W is a dict with the server fields that one event can change.

class Server:
    def __init__(self, c):
        self.c = c

    def flag(self, W, f):
        W["bad"] = W["bad"] | {f}

    def mis(self, W, who, q):
        if who != 0 and who != q:
            self.flag(W, "misapply")

    def name_ok(self, msg, q):
        return (not self.c.FIX_NAME_CHECK) or msg[1] == q

    def targeted(self, shares, q, m):
        out = set()
        for ki, k in enumerate(self.c.KEYS):
            t, _frm = shares[q - 1][ki]
            if self.c.MUTANT == "data_all_keys":
                if t:
                    out.add(k)
            elif 0 in t or m in t:
                out.add(k)
        return frozenset(out)

    def expected(self, shares, q, m):
        out = set()
        for ki, k in enumerate(self.c.KEYS):
            t, frm = shares[q - 1][ki]
            if (0 in t or m in t) and frm < m:
                out.add(k)
        return frozenset(out)

    def set_slot(self, W, r, v):
        s = list(W["slot"])
        s[r - 1] = v
        W["slot"] = tuple(s)

    def set_run(self, W, field, q, v):
        s = list(W[field])
        s[q - 1] = v
        W[field] = tuple(s)

    def append_out(self, W, pi, ev, q, data):
        W["outbox"] = W["outbox"] + ((W["nextId"], pi, ev, q, data),)
        W["nextId"] += 1

    def send_fin_ok(self, W, n, q):
        if W["conn"][n - 1] and not self.c.FIX_FINOK_ACK:
            d = list(W["down"])
            d[n - 1] = d[n - 1] + (("fin", q, frozenset(), 0),)
            W["down"] = tuple(d)
        else:
            self.append_out(W, n, "fin", q, frozenset())

    def handover(self, W, n):
        R = self.c.ROOMS
        q = W["slot"][n - 1][1]
        if W["slot"][n][0] != "empty":
            self.flag(W, "handover_nonempty")
        self.set_slot(W, n + 1, ("incoming", q))
        if self.c.MUTANT != "double_handover":
            self.set_slot(W, n, EMPTY)
        ll = list(W["lastLeft"])
        ll[n - 1] = q
        W["lastLeft"] = tuple(ll)
        self.set_run(W, "entered", q, n + 1)
        self.send_fin_ok(W, n, q)
        self.append_out(W, n + 1, "inc", q, self.targeted(W["shares"], q, n + 1))
        assert n + 1 <= R

    def cascade(self, W, m):
        if self.c.MUTANT == "no_cascade":
            return
        while m > 1 and W["slot"][m - 1][0] == "empty" and W["slot"][m - 2][0] == "waiting":
            self.handover(W, m - 1)
            m -= 1
            if self.c.MUTANT == "cascade_one_step":
                return

    def del_inc(self, W, q, m):
        if self.c.MUTANT == "leave_keeps_inc":
            return
        W["outbox"] = tuple(e for e in W["outbox"]
                            if not (e[2] == "inc" and e[3] == q and e[1] == m))

    # --- events
    def do_register(self, W, pi, msg, ctx):
        u = msg[1]
        if pi != 1:
            return
        if W["slot"][0][0] == "empty":
            if W["status"][u - 1] != "none":
                if not self.c.FIX_NAME_CHECK:
                    self.flag(W, "phantom")
                return
            self.set_run(W, "status", u, "active")
            self.set_slot(W, 1, ("incoming", u))
            self.set_run(W, "entered", u, 1)

    def do_start(self, W, pi, msg, ctx):
        st, q = W["slot"][pi - 1]
        if st == "incoming" and self.name_ok(msg, q):
            self.mis(W, msg[1], q)
            self.set_slot(W, pi, ("playing", q))
            self.set_run(W, "started", q, W["started"][q - 1] | {pi})
            if self.c.FIX_STALE_INC:
                self.del_inc(W, q, pi)

    def do_finish(self, W, pi, msg, ctx):
        R = self.c.ROOMS
        st, q = W["slot"][pi - 1]
        if st not in ("playing", "waiting") or not self.name_ok(msg, q):
            return
        self.mis(W, msg[1], q)
        self.set_run(W, "fin", q, W["fin"][q - 1] | {pi})
        last = R - 1 if self.c.MUTANT == "complete_off_by_one" else R
        if pi == last:
            if W["status"][q - 1] != "active":
                self.flag(W, "status_flip")
            self.set_run(W, "status", q, "completed")
            self.set_slot(W, pi, EMPTY)
            ll = list(W["lastLeft"])
            ll[pi - 1] = q
            W["lastLeft"] = tuple(ll)
            self.send_fin_ok(W, pi, q)
            self.cascade(W, pi)
        elif W["slot"][pi][0] == "empty" or self.c.MUTANT == "handover_no_check":
            self.handover(W, pi)
            self.cascade(W, pi)
        elif self.c.MUTANT != "no_waiting_state":
            self.set_slot(W, pi, ("waiting", q))

    def leave_run(self, W, pi, msg):
        R = self.c.ROOMS
        who = msg[1]
        if self.c.FIX_NAME_CHECK:
            if who != 0 and W["slot"][pi - 1][1] == who:
                return who
            if (pi < R and who != 0 and W["lastLeft"][pi - 1] == who
                    and W["slot"][pi] == ("incoming", who)):
                return who
            return 0
        if W["slot"][pi - 1][1] != 0:
            return W["slot"][pi - 1][1]
        ll = W["lastLeft"][pi - 1]
        if pi < R and ll != 0 and W["slot"][pi] == ("incoming", ll):
            return ll
        return 0

    def do_leave(self, W, pi, msg, ctx):
        q = self.leave_run(W, pi, msg)
        if q == 0:
            return
        m = next(r for r in range(1, self.c.ROOMS + 1) if W["slot"][r - 1][1] == q)
        was_inc = W["slot"][m - 1][0] == "incoming"
        self.mis(W, msg[1], q)
        if W["status"][q - 1] != "active":
            self.flag(W, "status_flip")
        self.set_run(W, "status", q, "left")
        if self.c.MUTANT != "leave_keeps_room":
            self.set_slot(W, m, EMPTY)
        if was_inc and m >= 2:
            self.del_inc(W, q, m)
            if (q, m) in ctx["got"] and (q, m) not in W["sent"]:
                self.flag(W, "left_not_queued")
            if (q, m) in W["sent"] or self.c.MUTANT == "left_always":
                self.append_out(W, m, "left", q, frozenset())
        self.cascade(W, m)

    def share_run(self, W, pi, msg):
        R = self.c.ROOMS
        who = msg[1]
        ll = W["lastLeft"][pi - 1]
        l_ok = ll != 0 and (pi == R or (pi + 1) not in W["started"][ll - 1])
        if self.c.FIX_NAME_CHECK:
            if who != 0 and W["slot"][pi - 1][1] == who:
                return who
            return ll if (l_ok and ll == who) else 0
        if W["slot"][pi - 1][1] != 0:
            return W["slot"][pi - 1][1]
        return ll if l_ok else 0

    def do_share(self, W, pi, msg, ctx):
        q = self.share_run(W, pi, msg)
        if q == 0:
            return
        self.mis(W, msg[1], q)
        ki = self.c.KEYS.index(msg[2])
        sh = [list(x) for x in W["shares"]]
        sh[q - 1][ki] = (msg[3], pi)
        W["shares"] = tuple(tuple(x) for x in sh)

    def do_ack(self, W, pi, msg, kind, ctx):
        for i, e in enumerate(W["outbox"]):
            if e[1] == pi and e[2] == kind and (not self.c.FIX_ACK_ID or e[0] == msg[4]):
                if kind == "inc" and (e[3], pi) not in ctx["got"]:
                    self.flag(W, "ack_undelivered")
                W["outbox"] = W["outbox"][:i] + W["outbox"][i + 1:]
                return

    def handle(self, W, pi, msg, ctx):
        ev = msg[0]
        if ev == "reg":
            self.do_register(W, pi, msg, ctx)
        elif ev == "start":
            self.do_start(W, pi, msg, ctx)
        elif ev == "finish":
            self.do_finish(W, pi, msg, ctx)
        elif ev == "leave":
            self.do_leave(W, pi, msg, ctx)
        elif ev == "share":
            self.do_share(W, pi, msg, ctx)
        elif ev == "incok":
            self.do_ack(W, pi, msg, "inc", ctx)
        elif ev == "leftok":
            self.do_ack(W, pi, msg, "left", ctx)
        elif ev == "finok":
            self.do_ack(W, pi, msg, "fin", ctx)
        else:
            raise ValueError(ev)


WKEYS = ("slot lastLeft status started fin shares outbox nextId down sent bad "
         "entered").split()


# ---------------------------------------------------------------------------
# Transition relation. Yields (label, fairness_key, next_state).

def successors(c, srv, s):
    R, N = c.ROOMS, c.RUNS
    g = lambda f: s[IX[f]]
    out = []

    def upd(state, **kw):
        lst = list(state)
        for k, v in kw.items():
            lst[IX[k]] = v
        return tuple(lst)

    def tup_set(t, i, v):
        return t[:i] + (v,) + t[i + 1:]

    def pi_send(state, pi, m):
        """Returns the new state or None when up[pi] is full."""
        up = state[IX["up"]]
        if len(up[pi - 1]) >= c.MAX_UP:
            return None
        up2 = tup_set(up, pi - 1, up[pi - 1] + (m,))
        st = upd(state, up=up2)
        if c.MAX_DUPS > 0:
            st = upd(st, lastSent=tup_set(state[IX["lastSent"]], pi - 1, m))
        return st

    conn, up, down, outbox = g("conn"), g("up"), g("down"), g("outbox")
    view, ps, quit = g("view"), g("ps"), g("quit")

    for pi in range(1, R + 1):
        i0 = pi - 1
        # ServerRecv
        if conn[i0] and up[i0]:
            msg = up[i0][0]
            W = {k: g(k) for k in WKEYS}
            W["conn"] = conn
            srv.handle(W, pi, msg, {"got": g("got")})
            ns = upd(s, **{k: W[k] for k in WKEYS})
            ns = upd(ns, up=tup_set(up, i0, up[i0][1:]))
            out.append(("ServerRecv", ("recv", pi), ns))
        # ServerSend
        if conn[i0]:
            cur = g("cursor")[i0]
            new = tuple(e for e in outbox if e[1] == pi and e[0] > cur)
            if new:
                d2 = down[i0] + tuple((e[2], e[3], e[4], e[0]) for e in new)
                ob2 = outbox if c.FIX_FINOK_ACK else tuple(
                    e for e in outbox if not (e[1] == pi and e[0] > cur and e[2] == "fin"))
                pairs = {(e[3], pi) for e in new if e[2] == "inc"}
                ns = upd(s, down=tup_set(down, i0, d2),
                         cursor=tup_set(g("cursor"), i0, new[-1][0]),
                         outbox=ob2, sent=g("sent") | pairs, gsent=g("gsent") | pairs)
                out.append(("ServerSend", ("send", pi), ns))
        # Retry
        if c.RETRY and conn[i0] and not down[i0]:
            cur = g("cursor")[i0]
            old = tuple(e for e in outbox if e[1] == pi and e[0] <= cur)
            if old:
                d2 = tuple((e[2], e[3], e[4], e[0]) for e in old)
                out.append(("Retry", ("retry", pi), upd(s, down=tup_set(down, i0, d2))))
        # Connect
        if not conn[i0]:
            out.append(("Connect", ("connect", pi), upd(s, conn=tup_set(conn, i0, True))))
        # Disconnect
        if conn[i0] and g("discs") < c.MAX_DISC:
            out.append(("Disconnect", None, upd(
                s, conn=tup_set(conn, i0, False), down=tup_set(down, i0, ()),
                cursor=tup_set(g("cursor"), i0, 0), discs=g("discs") + 1)))
        # Drop
        if up[i0] and g("drops") < c.MAX_DROPS and (
                c.DROP_REQUESTS or up[i0][0][0] in ("incok", "leftok")):
            out.append(("Drop", None, upd(s, up=tup_set(up, i0, up[i0][1:]),
                                           drops=g("drops") + 1)))
        # Dup
        if (g("dups") < c.MAX_DUPS and g("lastSent")[i0] != NOMSG
                and len(up[i0]) < c.MAX_UP):
            out.append(("Dup", None, upd(s, up=tup_set(up, i0, up[i0] + (g("lastSent")[i0],)),
                                          dups=g("dups") + 1)))
        live = view[i0] != 0 and view[i0] not in quit
        # Start
        if ps[i0] == "ready" and live:
            ns = pi_send(s, pi, ("start", view[i0], "-", frozenset(), 0))
            if ns is not None:
                out.append(("Start", ("start", pi), upd(
                    ns, ps=tup_set(ps, i0, "play"),
                    pstart=tup_set(g("pstart"), view[i0] - 1, pi))))
        # Finish
        if ps[i0] == "play" and live:
            ns = pi_send(s, pi, ("finish", view[i0], "-", frozenset(), 0))
            if ns is not None:
                out.append(("Finish", ("finish", pi), upd(ns, ps=tup_set(ps, i0, "fin"))))
        # Leave
        if c.LEAVES and ps[i0] in ("ready", "play", "fin") and live and pi >= g("pstart")[view[i0] - 1]:
            ns = pi_send(s, pi, ("leave", view[i0], "-", frozenset(), 0))
            if ns is not None:
                out.append(("Leave", None, upd(ns, quit=quit | {view[i0]},
                                               view=tup_set(view, i0, 0),
                                               ps=tup_set(ps, i0, "idle"))))
        # Share
        phases = ("play",) if c.PI_SHARES_BEFORE_FINISH else ("play", "fin")
        if ps[i0] in phases and live and g("nShares") < c.MAX_SHARES:
            for k in c.KEYS:
                for t in c.TARGETS:
                    ns = pi_send(s, pi, ("share", view[i0], k, t, 0))
                    if ns is not None:
                        out.append(("Share", None, upd(ns, nShares=g("nShares") + 1)))
        # Junk
        if c.ARBITRARY and g("junk") < c.MAX_JUNK:
            msgs = set()
            for w in range(0, N + 1):
                for e in ("start", "finish", "leave"):
                    msgs.add((e, w, "-", frozenset(), 0))
                for k in c.KEYS:
                    for t in c.TARGETS:
                        msgs.add(("share", w, k, t, 0))
            for e in ("incok", "leftok", "finok"):
                for i in {x[0] for x in outbox} | {0}:
                    msgs.add((e, 0, "-", frozenset(), i))
            for m in msgs:
                ns = pi_send(s, pi, m)
                if ns is not None:
                    out.append(("Junk", None, upd(ns, junk=g("junk") + 1)))
        # Receive
        if down[i0]:
            m = down[i0][0]
            ev, q, data, mid = m
            base = upd(s, down=tup_set(down, i0, down[i0][1:]))
            if ev == "fin":
                ns = base
                if c.FIX_FINOK_ACK:
                    ns = pi_send(base, pi, ("finok", 0, "-", frozenset(), mid))
                if ns is not None:
                    if ps[i0] == "fin" and (not c.FIX_FINOK_ACK or view[i0] == q):
                        ns = upd(ns, ps=tup_set(ps, i0, "idle"), view=tup_set(view, i0, 0))
                    out.append(("Receive", ("receive", pi), ns))
            elif ev == "inc":
                ns = pi_send(base, pi, ("incok", 0, "-", frozenset(), mid))
                if ns is not None:
                    ns = upd(ns, got=g("got") | {(q, pi)})
                    seen = g("seen")
                    if view[i0] != q and not (c.PI_DEDUP and mid <= seen[i0]):
                        b = g("bad")
                        if g("status")[q - 1] == "active" and g("entered")[q - 1] > pi:
                            b = b | {"stale_adopt"}
                            if data:
                                b = b | {"share_passed"}
                        ns = upd(ns, view=tup_set(view, i0, q), ps=tup_set(ps, i0, "ready"), bad=b)
                    if c.PI_DEDUP and mid > seen[i0]:
                        ns = upd(ns, seen=tup_set(seen, i0, mid))
                    out.append(("Receive", ("receive", pi), ns))
            elif ev == "left":
                ns = pi_send(base, pi, ("leftok", 0, "-", frozenset(), mid))
                if ns is not None:
                    if (not c.PI_DEDUP) or view[i0] == q:
                        b = g("bad")
                        if view[i0] != 0 and view[i0] != q:
                            b = b | {"left_clears_other"}
                        ns = upd(ns, view=tup_set(view, i0, 0), ps=tup_set(ps, i0, "idle"), bad=b)
                    out.append(("Receive", ("receive", pi), ns))
    # Register
    if ps[0] == "idle" and g("nextRun") <= N:
        u = g("nextRun")
        ns = pi_send(s, 1, ("reg", u, "-", frozenset(), 0))
        if ns is not None:
            out.append(("Register", None, upd(ns, view=tup_set(view, 0, u),
                                              ps=tup_set(ps, 0, "ready"), nextRun=u + 1)))
    # Restart
    if g("restarts") < c.MAX_RESTARTS:
        ob = () if c.MUTANT == "restart_loses_outbox" else outbox
        out.append(("Restart", None, upd(
            s, conn=(False,) * R, down=((),) * R, cursor=(0,) * R,
            sent=g("sent") if c.FIX_PERSIST_SENT else frozenset(),
            restarts=g("restarts") + 1, outbox=ob)))
    return out


def terminal(c, s):
    return (s[IX["nextRun"]] == c.RUNS + 1
            and all(x in ("completed", "left") for x in s[IX["status"]])
            and s[IX["outbox"]] == ()
            and all(x == () for x in s[IX["up"]])
            and all(x == () for x in s[IX["down"]]))


# ---------------------------------------------------------------------------
# Safety properties

def invariants(c, srv, s):
    """Returns a list of names of violated invariants."""
    R, N = c.ROOMS, c.RUNS
    slot, status, entered = s[IX["slot"]], s[IX["status"]], s[IX["entered"]]
    started, fin, outbox, bad = s[IX["started"]], s[IX["fin"]], s[IX["outbox"]], s[IX["bad"]]
    bad_list = []
    rooms = range(1, R + 1)
    if not all((slot[r - 1][0] == "empty") == (slot[r - 1][1] == 0) for r in rooms):
        bad_list.append("SlotWellFormed")
    runs_in = [slot[r - 1][1] for r in rooms if slot[r - 1][1] != 0]
    if len(runs_in) != len(set(runs_in)):
        bad_list.append("OneRoomPerRun")
    if not all(entered[slot[r - 1][1] - 1] == r for r in rooms if slot[r - 1][1] != 0):
        bad_list.append("InOrder")
    if not all(status[slot[r - 1][1] - 1] == "active" for r in rooms if slot[r - 1][1] != 0):
        bad_list.append("OnlyActiveInRooms")
    if not all(r < R and slot[r][0] != "empty" for r in rooms if slot[r - 1][0] == "waiting"):
        bad_list.append("WaitingNextBusy")
    if "handover_nonempty" in bad:
        bad_list.append("NoHandoverToBusy")
    full = frozenset(rooms)
    for p in range(1, N + 1):
        if status[p - 1] == "completed" and not (
                fin[p - 1] == full and started[p - 1] == full and entered[p - 1] == R):
            bad_list.append("CompletedAllTimes")
            break
    for p in range(1, N + 1):
        if not (fin[p - 1] <= started[p - 1] and started[p - 1] <= frozenset(range(1, entered[p - 1] + 1))):
            bad_list.append("TimesConsistent")
            break
    if "status_flip" in bad:
        bad_list.append("LeftNeverCompleted")
    for e in outbox:
        if (e[2] == "inc" and status[e[3] - 1] != "active") or (
                e[2] == "left" and status[e[3] - 1] != "left"):
            bad_list.append("OutboxLive")
            break
    for e in outbox:
        if e[2] == "inc" and slot[e[1] - 1] != ("incoming", e[3]):
            bad_list.append("OutboxCurrent")
            break
    gsent = s[IX["gsent"]]
    for e in outbox:
        if e[2] == "left" and (e[3], e[1]) not in gsent:
            bad_list.append("LeftOnlyIfSent")
            break
    if "left_not_queued" in bad:
        bad_list.append("LeftQueuedIfReceived")
    if "share_passed" in bad:
        bad_list.append("NoShareToPassedRoom")
    if "stale_adopt" in bad:
        bad_list.append("NoStaleAdopt")
    shares = s[IX["shares"]]
    for e in outbox:
        if e[2] == "inc" and e[4] != srv.expected(shares, e[3], e[1]):
            bad_list.append("DataExact")
            break
    if "misapply" in bad:
        bad_list.append("NoMisapply")
    if "phantom" in bad:
        bad_list.append("NoPhantomRun")
    if "ack_undelivered" in bad:
        bad_list.append("AckOnlyDelivered")
    if "left_clears_other" in bad:
        bad_list.append("LeftOnlyForOwn")
    return bad_list


def enter_step_ok(c, s, t):
    a, b = s[IX["entered"]], t[IX["entered"]]
    return all(b[i] in (a[i], a[i] + 1) for i in range(c.RUNS))


ALL_INVS = ("SlotWellFormed OneRoomPerRun InOrder OnlyActiveInRooms WaitingNextBusy "
            "NoHandoverToBusy CompletedAllTimes TimesConsistent LeftNeverCompleted "
            "OutboxLive OutboxCurrent LeftOnlyIfSent LeftQueuedIfReceived "
            "NoShareToPassedRoom NoStaleAdopt DataExact NoMisapply NoPhantomRun "
            "AckOnlyDelivered LeftOnlyForOwn").split()
STRUCT_INVS = ("SlotWellFormed OneRoomPerRun InOrder OnlyActiveInRooms WaitingNextBusy "
               "NoHandoverToBusy CompletedAllTimes TimesConsistent LeftNeverCompleted "
               "OutboxLive LeftOnlyIfSent").split()


# ---------------------------------------------------------------------------
# Exploration

def explore(c, check=ALL_INVS, keep_graph=False, stop_on_error=True):
    srv = Server(c)
    s0 = init_state(c)
    idx = {s0: 0}
    states = [s0]
    parent = [None]
    edges = [] if keep_graph else None
    q = deque([0])
    n_edges = 0
    errors = []
    depth = {0: 1}
    max_depth = 1
    check = set(check)
    deadlocks = 0

    def trace(i):
        out = []
        while i is not None:
            out.append(i)
            i = parent[i][0] if parent[i] else None
        return [(parent[j][1] if parent[j] else "Init", states[j]) for j in reversed(out)]

    v0 = [x for x in invariants(c, srv, s0) if x in check]
    if v0:
        return {"errors": [(v0, trace(0))]}
    while q:
        i = q.popleft()
        s = states[i]
        succ = successors(c, srv, s)
        if not succ and not terminal(c, s):
            deadlocks += 1
        el = [] if keep_graph else None
        for label, fair, t in succ:
            n_edges += 1
            if "EnterStep" in check and not enter_step_ok(c, s, t):
                errors.append((["EnterStep"], trace(i)))
                if stop_on_error:
                    return {"errors": errors}
            j = idx.get(t)
            if j is None:
                j = len(states)
                idx[t] = j
                states.append(t)
                parent.append((i, label))
                depth[j] = depth[i] + 1
                max_depth = max(max_depth, depth[j])
                v = [x for x in invariants(c, srv, t) if x in check]
                if v:
                    errors.append((v, trace(j)))
                    if stop_on_error:
                        return {"errors": errors, "states": len(states)}
                q.append(j)
            if keep_graph:
                el.append((fair, j))
        if keep_graph:
            el.append((None, i))  # stutter step (allowed by [Next]_vars)
            edges.append(el)
    return {"errors": errors, "states": len(states), "edges": n_edges,
            "depth": max_depth, "deadlocks": deadlocks,
            "graph": (states, edges) if keep_graph else None}


# ---------------------------------------------------------------------------
# Liveness: P ~> Q under WF/SF, by SCC analysis (Emerson-Lei style).

def tarjan(nodes, adj):
    """Iterative Tarjan on the subgraph `nodes` (a set). adj(i) -> iterable."""
    index, low, on, st, out = {}, {}, set(), [], []
    counter = [0]
    for root in nodes:
        if root in index:
            continue
        work = [(root, iter(adj(root)))]
        index[root] = low[root] = counter[0]
        counter[0] += 1
        st.append(root)
        on.add(root)
        while work:
            v, it = work[-1]
            advanced = False
            for w in it:
                if w not in nodes:
                    continue
                if w not in index:
                    index[w] = low[w] = counter[0]
                    counter[0] += 1
                    st.append(w)
                    on.add(w)
                    work.append((w, iter(adj(w))))
                    advanced = True
                    break
                if w in on:
                    low[v] = min(low[v], index[w])
            if advanced:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[v])
            if low[v] == index[v]:
                comp = []
                while True:
                    w = st.pop()
                    on.discard(w)
                    comp.append(w)
                    if w == v:
                        break
                out.append(comp)
    return out


WF_KINDS = ("recv", "send", "retry", "connect", "receive", "start", "finish")
SF_KINDS = ()


def fair_bad_sccs(states, edges, region, R):
    """Sets of states in `region` that hold a fair cycle (or a deadlock)."""
    enabled = {}

    def en(i):
        e = enabled.get(i)
        if e is None:
            e = {f for f, _ in edges[i] if f is not None}
            enabled[i] = e
        return e

    result = set()
    work = [set(region)]
    while work:
        sub = work.pop()
        for comp in tarjan(sub, lambda i: [j for _, j in edges[i]]):
            cs = set(comp)
            internal = [(i, f, j) for i in comp for f, j in edges[i] if j in cs]
            if not internal:
                continue
            taken = {f for _, f, _ in internal if f is not None}
            # weak fairness: an action that is enabled in every state of the
            # SCC must be taken in the SCC.
            ok = True
            for k in WF_KINDS:
                for pi in range(1, R + 1):
                    f = (k, pi)
                    if f not in taken and all(f in en(i) for i in comp):
                        ok = False
            if not ok:
                continue
            # strong fairness: an action enabled somewhere must be taken;
            # else remove the states where it is enabled and look again.
            rm = set()
            for k in SF_KINDS:
                for pi in range(1, R + 1):
                    f = (k, pi)
                    if f not in taken:
                        rm |= {i for i in comp if f in en(i)}
            if rm:
                rest = cs - rm
                if rest:
                    work.append(rest)
                continue
            result |= cs
    return result


def leads_to(states, edges, R, P, Q):
    """Returns a state index that violates P ~> Q, or None."""
    nq = {i for i in range(len(states)) if not Q(states[i])}
    bad = fair_bad_sccs(states, edges, nq, R)
    if not bad:
        return None
    # backward reachability inside nq from bad
    rev = {}
    for i in nq:
        for _, j in edges[i]:
            if j in nq:
                rev.setdefault(j, []).append(i)
    seen = set(bad)
    stack = list(bad)
    while stack:
        j = stack.pop()
        for i in rev.get(j, ()):
            if i not in seen:
                seen.add(i)
                stack.append(i)
    for i in seen:
        if P(states[i]):
            return i
    return None


def check_liveness(c, res):
    states, edges = res["graph"]
    R, N = c.ROOMS, c.RUNS
    fails = []
    for p in range(1, N + 1):
        P = lambda s, p=p: s[IX["status"]][p - 1] == "active"
        Q = lambda s, p=p: s[IX["status"]][p - 1] in ("completed", "left")
        if leads_to(states, edges, R, P, Q) is not None:
            fails.append("RunsEnd(run %d)" % p)
    for r in range(1, R + 1):
        for p in range(1, N + 1):
            P = lambda s, r=r, p=p: s[IX["slot"]][r - 1] == ("waiting", p)
            Q = lambda s, r=r, p=p: s[IX["slot"]][r - 1][1] != p
            if leads_to(states, edges, R, P, Q) is not None:
                fails.append("WaitingMovesOn(room %d, run %d)" % (r, p))
    for i in range(1, c.MAX_IDS + 1):
        P = lambda s, i=i: any(e[0] == i for e in s[IX["outbox"]])
        Q = lambda s, i=i: not any(e[0] == i for e in s[IX["outbox"]])
        if leads_to(states, edges, R, P, Q) is not None:
            fails.append("OutboxDrains(id %d)" % i)
    for pi in range(1, R + 1):
        for p in range(1, N + 1):
            P = lambda s, pi=pi, p=p: s[IX["view"]][pi - 1] == p and s[IX["status"]][p - 1] == "left"
            Q = lambda s, pi=pi, p=p: s[IX["view"]][pi - 1] != p
            if leads_to(states, edges, R, P, Q) is not None:
                fails.append("GhostCleared(pi %d, run %d)" % (pi, p))
    return fails


# ---------------------------------------------------------------------------
# Configurations (the TLC .cfg files with the same names use the same bounds)

def small_cfg(**kw):  # ServerSmall.cfg
    base = dict(ROOMS=3, RUNS=2, MAX_DROPS=1, MAX_UP=1, RETRY=True)
    base.update(kw)
    return Cfg(**base)


def share_cfg(**kw):  # ServerShareSmall.cfg
    base = dict(ROOMS=3, RUNS=2, MAX_SHARES=1, MAX_UP=1, RETRY=False)
    base.update(kw)
    return Cfg(**base)


def arb_cfg(**kw):  # ServerArbitrary.cfg
    base = dict(ROOMS=3, RUNS=2, MAX_UP=1, ARBITRARY=True, MAX_JUNK=1, RETRY=False)
    base.update(kw)
    return Cfg(**base)


def live_cfg(**kw):  # ServerLiveSmall.cfg
    base = dict(ROOMS=3, RUNS=2, MAX_SHARES=0, MAX_UP=1, RETRY=True)
    base.update(kw)
    return Cfg(**base)


def fmt_trace(tr, limit=40):
    lines = []
    prev = None
    for label, s in tr[-limit:]:
        ch = []
        for f in ("slot", "status", "outbox", "up", "down", "view", "ps", "bad"):
            v = s[IX[f]]
            if prev is None or prev[IX[f]] != v:
                ch.append("%s=%s" % (f, fmt_val(v)))
        lines.append("  %-11s %s" % (label, "; ".join(ch)))
        prev = s
    return "\n".join(lines)


def fmt_val(v):
    if isinstance(v, frozenset):
        return "{" + ",".join(sorted(map(str, v))) + "}"
    if isinstance(v, tuple):
        return "(" + ",".join(fmt_val(x) for x in v) + ")"
    return str(v)


def main():
    t0 = time.time()
    failures = []
    verbose = "-v" in sys.argv

    # 1. The fixed design: safety, small bound.
    c = small_cfg()
    r = explore(c, check=ALL_INVS + ["EnterStep"])
    print("[fixed/small] states=%s edges=%s depth=%s deadlocks=%s errors=%d"
          % (r.get("states"), r.get("edges"), r.get("depth"), r.get("deadlocks"), len(r["errors"])))
    if r["errors"]:
        failures.append("fixed/small safety: %s" % r["errors"][0][0])
        print(fmt_trace(r["errors"][0][1]))

    # 1b. The fixed design: shares, small bound.
    c = share_cfg()
    r = explore(c, check=ALL_INVS + ["EnterStep"])
    print("[fixed/share] states=%s edges=%s depth=%s deadlocks=%s errors=%d"
          % (r.get("states"), r.get("edges"), r.get("depth"), r.get("deadlocks"), len(r["errors"])))
    if r["errors"]:
        failures.append("fixed/share safety: %s" % r["errors"][0][0])
        print(fmt_trace(r["errors"][0][1]))
    if r.get("deadlocks"):
        failures.append("fixed/share: %d deadlock states" % r["deadlocks"])

    # 2. The fixed design: liveness in the cooperative environment.
    c = live_cfg()
    r = explore(c, check=ALL_INVS + ["EnterStep"], keep_graph=True)
    print("[fixed/live] states=%s edges=%s depth=%s deadlocks=%s errors=%d"
          % (r.get("states"), r.get("edges"), r.get("depth"), r.get("deadlocks"), len(r["errors"])))
    if r["errors"]:
        failures.append("fixed/live safety: %s" % r["errors"][0][0])
    if r.get("deadlocks"):
        failures.append("fixed/live: %d deadlock states" % r["deadlocks"])
    lf = check_liveness(c, r) if r.get("graph") else ["no graph"]
    print("[fixed/live] liveness failures: %s" % (lf or "none"))
    if lf:
        failures.append("fixed/live liveness: %s" % lf)

    # 3. The fixed design with arbitrary Pi messages: structural invariants.
    c = arb_cfg()
    r = explore(c, check=STRUCT_INVS + ["EnterStep"])
    print("[fixed/arbitrary] states=%s edges=%s depth=%s errors=%d"
          % (r.get("states"), r.get("edges"), r.get("depth"), len(r["errors"])))
    if r["errors"]:
        failures.append("fixed/arbitrary: %s" % r["errors"][0][0])
        print(fmt_trace(r["errors"][0][1]))

    # 4. The plan as written: each finding must show up.
    findings = [
        ("F1 ack by type removes an undelivered player_incoming",
         live_cfg(FIX_ACK_ID=False), ["AckOnlyDelivered"]),
        ("F1b a late duplicate player_incoming_ok removes a newer player_incoming (no quits)",
         live_cfg(FIX_ACK_ID=False, LEAVES=False, MAX_UP=2), ["AckOnlyDelivered"]),
        ("F2 player_leave without name hits the next run",
         live_cfg(FIX_NAME_CHECK=False, MAX_RESTARTS=0, MAX_DISC=0, RETRY=False), ["NoMisapply"]),
        ("F3 stale player_incoming after the run passed the room",
         small_cfg(FIX_STALE_INC=False), ["OutboxCurrent", "NoStaleAdopt"]),
        ("F4 the sent mark is lost at restart",
         live_cfg(FIX_PERSIST_SENT=False, MAX_RESTARTS=1, RETRY=False), ["LeftQueuedIfReceived"]),
        ("F5 share after game_finish is lost or hits the next run",
         share_cfg(PI_SHARES_BEFORE_FINISH=False, TARGETS=(frozenset({0}),)),
         ["DataExact", "NoMisapply"]),
        ("F6 player_left clears another player at the Pi",
         live_cfg(PI_DEDUP=False, MAX_RESTARTS=0, MAX_UP=2), ["LeftOnlyForOwn", "NoStaleAdopt"]),
        ("F7 duplicate client message (no seq dedupe)",
         live_cfg(FIX_NAME_CHECK=False, MAX_DUPS=1, MAX_RESTARTS=0, MAX_DISC=0, RETRY=False),
         ["NoMisapply", "NoPhantomRun"]),
        ("F8 game_finish_ok without ack is lost at restart",
         live_cfg(FIX_FINOK_ACK=False, MAX_RESTARTS=1, RETRY=False), ["deadlock"]),
        ("F9 a lost Pi request is never sent again (client)",
         live_cfg(DROP_REQUESTS=True, MAX_DROPS=1, RETRY=False), ["deadlock"]),
    ]
    for name, cf, expect in findings:
        r = explore(cf, check=ALL_INVS + ["EnterStep"])
        got = r["errors"][0][0] if r["errors"] else []
        if not got and r.get("deadlocks"):
            got = ["deadlock"]
        hit = [x for x in got if x in expect]
        print("[plan] %s: %s" % (name, ("violates " + ",".join(got)) if got else "NOT FOUND"))
        if verbose and r["errors"]:
            print(fmt_trace(r["errors"][0][1]))
        if not hit:
            failures.append("finding not reproduced: %s (got %s)" % (name, got))

    # 5. Mutants of the fixed design: each must be killed.
    mutants = [
        ("handover_no_check", "hand over without a check that the next room is empty", "safety"),
        ("no_cascade", "no hand-over chain back to room 1", "safety"),
        ("cascade_one_step", "the hand-over chain stops after one step", "safety"),
        ("leave_keeps_room", "player_leave does not free the room", "safety"),
        ("leave_keeps_inc", "player_incoming not deleted when an incoming run leaves", "safety"),
        ("restart_loses_outbox", "restart loses the outbox", "live"),
        ("data_all_keys", "player_data has all keys, not only the targeted keys", "safety"),
        ("complete_off_by_one", "the run completes in room ROOMS-1", "safety"),
        ("double_handover", "hand over copies the run (room N not emptied)", "safety"),
        ("left_always", "player_left queued also if player_incoming was never sent", "safety"),
        ("no_waiting_state", "busy next room: the run is not put in waiting", "live"),
    ]
    killed = 0
    for mid, desc, kind in mutants:
        if mid == "cascade_one_step":
            cf = Cfg(ROOMS=3, RUNS=3, MAX_UP=1, RETRY=False)
        elif mid == "restart_loses_outbox":
            cf = live_cfg(MUTANT=mid, MAX_RESTARTS=1, RETRY=False)
        elif kind == "live":
            cf = live_cfg(MUTANT=mid)
        else:
            cf = share_cfg(MUTANT=mid)
        if mid == "cascade_one_step":
            cf.MUTANT = mid
        if kind == "live":
            r = explore(cf, check=ALL_INVS + ["EnterStep"], keep_graph=True)
            why = r["errors"][0][0] if r["errors"] else []
            if not why:
                why = (["deadlock"] if r.get("deadlocks") else []) + check_liveness(cf, r)
        else:
            r = explore(cf, check=ALL_INVS + ["EnterStep"])
            why = r["errors"][0][0] if r["errors"] else []
        ok = bool(why)
        killed += ok
        print("[mutant] %-22s %-60s %s" % (mid, desc, ("killed by " + ",".join(why[:3])) if ok else "SURVIVED"))
        if not ok:
            failures.append("mutant survived: %s" % mid)
    print("mutants killed: %d/%d" % (killed, len(mutants)))

    print("time: %.1f s" % (time.time() - t0))
    if failures:
        print("FAILED:")
        for f in failures:
            print("  - " + f)
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
