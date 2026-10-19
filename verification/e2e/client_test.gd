extends SceneTree
# End-to-end test for control_room_client.gd.
# Run: godot --headless --path godot -s <this file> -- <scenario> <port>
# Prints "CHECK ok/FAIL" lines and "CLIENT_RESULT PASS|FAIL". Exit code 0 = pass.

const ClientScript := preload("res://addons/control_room_client/control_room_client.gd")

var scenario := ""
var port := 0
var client: Node
var t := 0.0
var deadline := 40.0
var failures: Array[String] = []
var auth_count := 0
var auth_times: Array[float] = []
var gave_up_count := 0
var sig_log: Array = []      # [name, args...] in order of emission
var done_at := -1.0
var finished := false

# scenario state
var seq_i := 0
var seq_sent_flag := false
var saw_down := false
var down_sent := 0
var max_queue := 0
var finish_sent := false
var early_c_sent := false
var attempts := 0
var last_ws_id := 0
var wait_flag_after_wait := false
var wait_flag_after_ok := true
var snap_incoming := {}
var snap_left: Variant = null


func check(cond: bool, msg: String) -> void:
	if cond:
		print("CHECK ok: ", msg)
	else:
		print("CHECK FAIL: ", msg)
		failures.append(msg)


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	scenario = args[0]
	port = int(args[1])
	client = ClientScript.new("ws://127.0.0.1:%d" % port, 3)
	root.add_child(client)
	client.authenticated.connect(_on_authenticated)
	client.gave_up.connect(func(): gave_up_count += 1)
	client.game_finish_wait.connect(func(w):
		wait_flag_after_wait = client.is_waiting_for_next_pi
		sig_log.append(["game_finish_wait", w]))
	client.game_finish_ok.connect(func():
		wait_flag_after_ok = client.is_waiting_for_next_pi
		sig_log.append(["game_finish_ok"]))
	client.player_incoming.connect(func(u, d):
		snap_incoming = client.current_player.duplicate(true)
		sig_log.append(["player_incoming", u, d]))
	client.player_left.connect(func(u):
		snap_left = client.current_player.duplicate(true)
		sig_log.append(["player_left", u]))
	client.server_error.connect(func(c, m, e): sig_log.append(["server_error", c, m, e]))

	match scenario:
		"normal":
			client.run()
		"early":
			deadline = 20.0
			client.register_player("early")
			client.start_game()
			check(client.send_queue.size() == 2, "2 events queued before run()")
			client.run()
			client.share("a", 1)
			client.share("b", {"x": 2}, 3)
		"auth2":
			deadline = 25.0
			client.run()
			client.register_player("u")
		"auth3":
			deadline = 50.0
			client.run()
			client._retry_delay = 1  # run() resets it, so set it after run()
			client.register_player("u")
		"drop":
			deadline = 40.0
			client.run()
			client._retry_delay = 1
		"events":
			deadline = 20.0
			client.run()
		"giveup":
			deadline = 40.0
			client.run()
		_:
			print("CHECK FAIL: unknown scenario ", scenario)
			quit(2)


func _on_authenticated() -> void:
	auth_count += 1
	auth_times.append(t)
	match scenario:
		"normal":
			client.register_player("bob")
			client.start_game()
			client.share("score", 42, [1, 2])
			client.finish_game()
			check(client.send_queue.is_empty(), "queue empty after in-order send")
			done_at = t + 0.7
		"early":
			check(t >= 1.3, "authenticated only after server delay (t=%.2f)" % t)
			check(client.send_queue.is_empty(), "queue flushed on auth_ok")
			client.share("after", 9)
			done_at = t + 0.7
		"auth2":
			check(t > 4.5 and t < 8.0, "authenticated after 2nd auth attempt (t=%.2f)" % t)
			done_at = t + 0.7
		"auth3":
			check(t > 14.0 and t < 30.0, "authenticated on new connection after 3 failed attempts (t=%.2f)" % t)
			done_at = t + 0.7
		"drop":
			client._retry_delay = 1  # reset to 5 by auth; shorten again
		"events":
			done_at = t + 1.5


func _process(delta: float) -> bool:
	if finished:
		return true
	t += delta
	if t > deadline:
		check(false, "scenario finished before hard deadline %.0fs" % deadline)
		return _finish()
	match scenario:
		"early":
			if not early_c_sent and t > 0.4:
				early_c_sent = true
				check(not client.is_authenticated, "not authenticated yet at t=0.4")
				client.share("c", 3)
				check(client.send_queue.size() == 5, "5 events queued while unauthenticated (got %d)" % client.send_queue.size())
		"drop":
			_tick_drop()
		"giveup":
			_tick_giveup()
	if done_at > 0.0 and t >= done_at:
		_check_end()
		return _finish()
	return false


func _tick_drop() -> void:
	max_queue = maxi(max_queue, client.send_queue.size())
	if client._state == 4:  # WAITING_RETRY
		if not saw_down:
			saw_down = true
		# events sent while the connection is down
		while down_sent < 3:
			client.share("down", down_sent)
			down_sent += 1
	# one event per 20 ms
	var target := mini(int(t / 0.02), 150)
	while seq_i < target:
		client.share("seq", seq_i)
		seq_i += 1
	if seq_i >= 150 and down_sent >= 3 and auth_count >= 2 and client.send_queue.is_empty() and not finish_sent:
		finish_sent = true
		client.finish_game()
		done_at = t + 0.8


func _tick_giveup() -> void:
	if client._state == 4:  # WAITING_RETRY: skip the long waits
		client._timer = 0.0
	var id: int = client.websocket.get_instance_id() if client.websocket != null else 0
	if id != 0 and id != last_ws_id:
		last_ws_id = id
		attempts += 1
	if gave_up_count > 0 and done_at < 0.0:
		done_at = t + 0.8


func _check_end() -> void:
	match scenario:
		"normal":
			check(auth_count == 1, "authenticated emitted once")
			check(client.is_authenticated, "is_authenticated true")
		"early":
			check(auth_count == 1, "authenticated emitted once")
		"auth2":
			check(auth_count == 1, "authenticated emitted once")
		"auth3":
			check(auth_count == 1, "authenticated emitted once")
		"drop":
			check(auth_count == 2, "authenticated emitted twice (got %d)" % auth_count)
			check(saw_down, "client noticed the drop (state WAITING_RETRY seen)")
			check(max_queue > 0, "events were queued while down (max queue %d)" % max_queue)
			check(seq_i == 150, "all 150 seq events produced")
		"events":
			var exp_names := ["game_finish_wait", "game_finish_ok", "player_incoming", "player_left", "server_error"]
			var got_names := []
			for s in sig_log:
				got_names.append(s[0])
			check(got_names == exp_names, "signal order %s" % [got_names])
			if sig_log.size() == 5:
				check(sig_log[0][1] == "10 min", "game_finish_wait max_wait = '10 min'")
				check(sig_log[2][1] == "alice", "player_incoming username = alice")
				check(sig_log[2][2] is Dictionary and sig_log[2][2].get("score") == 3, "player_incoming player_data = {score: 3}")
				check(sig_log[3][1] == "alice", "player_left username = alice")
				check(sig_log[4][1] == "E1" and sig_log[4][2] == "boom", "server_error code/message = E1/boom")
				check(sig_log[4][3] == "share", "server_error event = failing event name from event_name")
			check(wait_flag_after_wait, "is_waiting_for_next_pi true during wait")
			check(not wait_flag_after_ok, "is_waiting_for_next_pi false after game_finish_ok")
			check(snap_incoming.get("username") == "alice" and snap_incoming.get("data") is Dictionary, "current_player set on player_incoming")
			check(snap_left is Dictionary and snap_left.is_empty(), "current_player cleared on player_left")
			check(client._state == 3, "client still CONNECTED after junk/unknown packets")
		"giveup":
			check(gave_up_count == 1, "gave_up emitted exactly once (got %d)" % gave_up_count)
			check(auth_count == 0, "authenticated never emitted")
			check(client._retry_amount == 10, "_retry_amount == 10 (got %d)" % client._retry_amount)
			check(client._state == 5, "state STOPPED")
			print("INFO connection attempts observed: %d" % attempts)
			check(attempts == 11, "11 connection attempts (1 initial + 10 retries), observed %d" % attempts)


func _finish() -> bool:
	finished = true
	if failures.is_empty():
		print("CLIENT_RESULT PASS ", scenario)
	else:
		print("CLIENT_RESULT FAIL ", scenario)
	quit(0 if failures.is_empty() else 1)
	return true
