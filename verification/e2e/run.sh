#!/usr/bin/env bash
# End-to-end test: real GDScript client against a scripted fake server.
# Usage: run.sh [scenario ...]   (default: all)
# Env: GODOT_BIN (default /opt/homebrew/bin/godot), VERBOSE=1 for full logs.
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$HERE/../../godot"
GODOT_BIN="${GODOT_BIN:-/opt/homebrew/bin/godot}"
OUT="$(mktemp -d)"

# name  port  hard-time-limit-seconds  label
SCENARIOS=(
  "normal 18701 40 a_normal_flow"
  "early  18702 40 b_events_before_auth_ok"
  "auth2  18703 40 c_first_auth_ignored"
  "auth3  18704 70 c2_three_auths_ignored_reconnect"
  "drop   18705 60 d_connection_dropped_reconnect"
  "lost_after_send 18707 60 g_event_not_acked_then_connection_killed_resend"
  "events 18706 40 e_server_events_and_acks"
  "giveup 18799 70 f_ten_failed_connects_gave_up"
)

# hard limit: perl alarm survives exec and kills the process (macOS has no timeout)
limited() { local secs=$1; shift; perl -e 'alarm shift; exec @ARGV' "$secs" "$@"; }

want=("$@")
overall=0
for entry in "${SCENARIOS[@]}"; do
  read -r name port limit label <<<"$entry"
  if [ ${#want[@]} -gt 0 ]; then
    match=0; for w in "${want[@]}"; do [ "$w" = "$name" ] && match=1; done
    [ $match -eq 1 ] || continue
  fi
  srv_out="$OUT/$name.server.txt"; cli_out="$OUT/$name.client.txt"
  srv_pid=""
  if [ "$name" != "giveup" ]; then   # giveup: nothing listens on the port
    bun "$HERE/fake_server.ts" "$name" "$port" >"$srv_out" 2>&1 &
    srv_pid=$!
    for _ in $(seq 1 50); do nc -z 127.0.0.1 "$port" 2>/dev/null && break; sleep 0.1; done
  else
    : >"$srv_out"
  fi

  limited "$limit" "$GODOT_BIN" --headless --path "$PROJECT" -s "$HERE/client_test.gd" -- "$name" "$port" >"$cli_out" 2>&1
  cli_rc=$?

  srv_rc=0
  if [ -n "$srv_pid" ]; then
    kill -TERM "$srv_pid" 2>/dev/null
    wait "$srv_pid"; srv_rc=$?
  fi

  ok=1
  [ $cli_rc -eq 0 ] || ok=0
  grep -q "^CLIENT_RESULT PASS" "$cli_out" || ok=0
  [ $srv_rc -eq 0 ] || ok=0
  if [ $ok -eq 1 ]; then echo "PASS  $label"; else echo "FAIL  $label (godot rc=$cli_rc, server rc=$srv_rc; rc 142 = hard time limit hit)"; overall=1; fi
  grep -h -E "^(CHECK|INFO|SERVER (CHECK|INFO))" "$cli_out" "$srv_out" | sed 's/^/        /'
  if [ $ok -eq 0 ] || [ -n "${VERBOSE:-}" ]; then
    echo "        --- godot output (tail) ---"; tail -n 25 "$cli_out" | sed 's/^/        /'
    echo "        --- server output ---"; sed 's/^/        /' "$srv_out"
  fi
done
echo "logs: $OUT"
[ $overall -eq 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit $overall
