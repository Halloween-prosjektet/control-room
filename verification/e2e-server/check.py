"""Checks the server state through HTTP and the Pi logs.
Usage: python3 -I check.py <scenario> <port> <logdir>
Prints "CHECK ok: ..." or "CHECK FAIL: ..." lines. Exit code 1 if a check fails."""
import json
import sys
import urllib.request

scenario, port, logdir = sys.argv[1], sys.argv[2], sys.argv[3]
failed = []


def check(cond, msg):
    print(("CHECK ok: " if cond else "CHECK FAIL: ") + msg)
    if not cond:
        failed.append(msg)


def get(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as r:
        return json.load(r)


def log(pi):
    try:
        return open(f"{logdir}/pi{pi}.txt").read()
    except OSError:
        return ""


board = get("/leaderboard")
state = get("/state")
print("INFO leaderboard:", json.dumps([{k: r[k] for k in ("rank", "username", "total_time_ms")} for r in board]))


def room_times_ok(row):
    t = row["room_times_ms"]
    return sorted(t) == [f"room_{i}" for i in range(1, 6)] and all(isinstance(v, int) and v > 0 for v in t.values()) \
        and sum(t.values()) == row["total_time_ms"]


rooms = state.get("rooms", [])
check(len(rooms) == 5 and all(r.get("state") == "empty" for r in rooms), "all 5 rooms are empty at the end")

if scenario in ("1", "3", "4"):
    check(len(board) == 1, f"exactly 1 completed run (got {len(board)})")
    if board:
        row = board[0]
        check(row["username"] == "alice", f"username is alice (got {row['username']})")
        check(room_times_ok(row), "5 room times, all > 0, sum equals total_time_ms")
        check(row["rank"] == 1, "rank is 1")
        one = get("/leaderboard/" + row["player_id"])
        check(one["username"] == "alice", "GET /leaderboard/:player_id works")
if scenario == "1":
    check('EV player_incoming user=alice data={"tip":"hello"}' in log(3),
          "share from Pi 1 to Pi 3 arrived in player_data on Pi 3")
    for pi in (2, 4, 5):
        check('EV player_incoming user=alice data={}' in log(pi) or 'EV player_incoming user=alice data=null' in log(pi),
              f"Pi {pi} got no share data (empty player_data)")
if scenario == "2":
    names = [r["username"] for r in board]
    check(names == ["bob", "alice", "carol"], f"leaderboard order is bob, alice, carol (got {names})")
    check(all(room_times_ok(r) for r in board), "every run has 5 valid room times")
    check(any("EV game_finish_wait" in log(p) for p in (1, 2, 3, 4)), "at least one game_finish_wait happened (pipeline waits)")
    for pi in (2, 3, 4, 5):
        users = [l.split("user=")[1].split()[0] for l in log(pi).splitlines() if l.startswith("EV player_incoming")]
        check(users == ["alice", "carol", "bob"], f"Pi {pi} got players in start order (got {users})")
if scenario == "5":
    check(len(board) == 0, f"no completed run (got {len(board)})")
    check("EV player_left user=alice" in log(2), "Pi 2 got player_left for alice")
    check("EV player_incoming user=alice" in log(2), "Pi 2 got player_incoming for alice before player_left")

sys.exit(1 if failed else 0)
