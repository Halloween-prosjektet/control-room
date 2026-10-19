#!/usr/bin/env bash
# End-to-end test: REAL Godot client (5 headless processes, Pi 1..5) against the REAL server.
# Usage: run.sh [scenario ...]   (1..5, default: all)
# Env: GODOT_BIN (default /opt/homebrew/bin/godot), VERBOSE=1 for full logs, KEEP=1 to keep the temp dir.
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$HERE/../../godot"
BACKEND="$HERE/../../backend"
GODOT_BIN="${GODOT_BIN:-/opt/homebrew/bin/godot}"
TMP="$(mktemp -d)"
PORT_BASE=18810
SERVER_PID=""
PI_PIDS=()

# hard limit: perl alarm survives exec and kills the process (macOS has no timeout)
limited() { local secs=$1; shift; perl -e 'alarm shift; exec @ARGV' "$secs" "$@"; }

cleanup() {
  [ -n "$SERVER_PID" ] && kill -9 "$SERVER_PID" 2>/dev/null
  for p in "${PI_PIDS[@]}"; do kill -9 "$p" 2>/dev/null; done
  [ -n "${KEEP:-}" ] || rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

start_server() {  # port db log
  ( cd "$BACKEND" && PORT="$1" DB_PATH="$2" ACK_RETRY_MS=300 exec bun run src/index.ts ) >>"$3" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$1/health" >/dev/null 2>&1 && return 0; sleep 0.1; done
  echo "server did not start"; return 1
}
stop_server() { kill -9 "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""; }

# start_pi <pi> <port> <logfile> [VAR=value ...]  -> sets LAST_PID
start_pi() {
  local pi=$1 port=$2 log=$3; shift 3
  env PI="$pi" PORT="$port" "$@" perl -e 'alarm shift; exec @ARGV' 70 \
    "$GODOT_BIN" --headless --path "$PROJECT" -s "$HERE/pi_test.gd" >>"$log" 2>&1 &
  LAST_PID=$!
  PI_PIDS+=("$LAST_PID")
}

wait_log() {  # file pattern seconds
  for _ in $(seq 1 $(( $3 * 10 ))); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.1; done
  return 1
}

# run_scenario <num> <label>
run_scenario() {
  local n=$1 label=$2 port=$((PORT_BASE + $1))
  local dir="$TMP/s$n"; mkdir -p "$dir"
  local db="$dir/db.sqlite" slog="$dir/server.txt"
  PI_PIDS=()
  local rcs=() ok=1
  start_server "$port" "$db" "$slog" || { echo "FAIL  $label"; return 1; }

  local P1 P2 P3 P4 P5 extra3=() cnt=1 u1="alice" env1=() env2=() env3=() env4=() env5=()
  case $n in
    1) env1=(USERNAMES=alice PLAY_MS=500 SHARE=3:tip:hello) ;;
    2) u1="alice,carol,bob"; cnt=3
       env1=(USERNAMES=$u1 USER_MS=alice=600,carol=900,bob=300 N_PLAYERS=3)
       env2=(N_PLAYERS=3 USER_MS=alice=600,carol=900,bob=300)
       env3=(N_PLAYERS=3 USER_MS=alice=600,carol=900,bob=300)
       env4=(N_PLAYERS=3 USER_MS=alice=600,carol=900,bob=300)
       env5=(N_PLAYERS=3 USER_MS=alice=600,carol=900,bob=300) ;;
    3) env3=(MODE=crash PLAY_MS=500) ;;
    4) env3=(PLAY_MS=3000) ;;
    5) env1=(USERNAMES=alice MODE=leave PLAY_MS=500); env2=(MODE=expect_left) ;;
  esac
  [ $n -ne 2 ] && { env1+=(USERNAMES=${u1}); }

  # Pis 2..5 first, Pi 1 a little later (so the outbox and the pre-auth rules get tested)
  local pis=(2 3 4 5)
  [ $n -eq 5 ] && pis=(2)
  for pi in "${pis[@]}"; do
    local -n e="env$pi"
    start_pi "$pi" "$port" "$dir/pi$pi.txt" N_PLAYERS=$cnt "${e[@]}"
    eval "P$pi=$LAST_PID"
  done
  sleep 1
  start_pi 1 "$port" "$dir/pi1.txt" "${env1[@]}"; P1=$LAST_PID

  case $n in
    3)
      if wait_log "$dir/pi3.txt" "^STARTED" 40; then
        kill -9 "$P3"; wait "$P3" 2>/dev/null; echo "        (Pi 3 killed while playing; new process starts)" >>"$dir/orchestrator.txt"
        sleep 1
        : >"$dir/pi3.first.txt"; cp "$dir/pi3.txt" "$dir/pi3.first.txt"
        start_pi 3 "$port" "$dir/pi3.txt" MODE=resume N_PLAYERS=1; P3=$LAST_PID
      else echo "orchestrator: Pi 3 never STARTED" >>"$dir/orchestrator.txt"; ok=0; fi ;;
    4)
      if wait_log "$dir/pi3.txt" "^STARTED" 40; then
        stop_server; echo "        (server killed while Pi 3 plays; restarted on same DB)" >>"$dir/orchestrator.txt"
        sleep 1
        start_server "$port" "$db" "$slog" || ok=0
      else echo "orchestrator: Pi 3 never STARTED" >>"$dir/orchestrator.txt"; ok=0; fi ;;
  esac

  # wait for all Pis (Pi 3 of scenario 3: the killed process was already reaped)
  local names=(1 2 3 4 5); [ $n -eq 5 ] && names=(1 2)
  for pi in "${names[@]}"; do
    local v="P$pi"; wait "${!v}" 2>/dev/null; rcs+=("pi$pi=$?")
  done
  for pi in "${names[@]}"; do
    grep -q "^PI_RESULT PASS" "$dir/pi$pi.txt" || ok=0
  done
  # Scenario 3: the old Pi 3 log is overwritten by append; check only that the last result is PASS
  python3 -I "$HERE/check.py" "$n" "$port" "$dir" >"$dir/check.txt" 2>&1 || ok=0
  grep -q "CHECK FAIL" "$dir"/*.txt && ok=0

  if [ $ok -eq 1 ]; then echo "PASS  $label"; else echo "FAIL  $label (${rcs[*]}; rc 142 = hard time limit)"; fi
  [ -f "$dir/orchestrator.txt" ] && cat "$dir/orchestrator.txt"
  grep -h -E "^(CHECK|INFO)" "$dir/check.txt" | sed 's/^/        /'
  (cd "$dir" && grep -H -E "^(CHECK FAIL|PI_RESULT)" pi*.txt) | sed 's/^/        /'
  if [ $ok -eq 0 ] || [ -n "${VERBOSE:-}" ]; then
    for pi in "${names[@]}"; do echo "        --- Pi $pi (tail) ---"; tail -n 30 "$dir/pi$pi.txt" | sed 's/^/        /'; done
    echo "        --- server ---"; tail -n 60 "$slog" | sed 's/^/        /'
  fi
  stop_server
  for p in "${PI_PIDS[@]}"; do kill -9 "$p" 2>/dev/null; done
  [ $ok -eq 1 ]
}

LABELS=(x "one_player_through_all_rooms_and_share" "three_players_pipeline" "pi3_killed_and_restarted_mid_run" "server_restarted_mid_run" "player_quits_after_room_1")
want=("$@"); [ ${#want[@]} -eq 0 ] && want=(1 2 3 4 5)
overall=0
for n in "${want[@]}"; do
  run_scenario "$n" "scenario_${n}_${LABELS[$n]}" || overall=1
done
[ $overall -eq 0 ] && echo "ALL PASS" || echo "SOME FAILED"
[ -n "${KEEP:-}" ] && echo "logs: $TMP"
exit $overall
