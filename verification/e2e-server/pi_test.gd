extends SceneTree
# One simulated Pi with the REAL client (control_room_client.gd).
# Run: godot --headless --path godot -s pi_test.gd
# Settings come from environment variables:
#   PI          Pi number 1..5
#   PORT        server port
#   USERNAMES   (Pi 1 only) comma list of players to register, in order
#   N_PLAYERS   (Pi 2..5) number of players that come to this Pi
#   PLAY_MS     play time in ms (default 500)
#   USER_MS     optional per-player play time, "bob=400,carol=900"
#   MODE        normal | crash (stop after the start is acked and wait to be killed)
#               | resume (new process of a player that is already playing: only finish)
#               | leave (Pi 1: leave_player 1 s after game_finish_ok of the first player)
#               | expect_left (Pi 2..5: wait for player_incoming and player_left, then stop)
#   SHARE       optional "to_pi:key:value" sent after game_start (value is a string)
#   DEADLINE_S  hard limit of this process (default 55)
# Output lines: "EV ...", "CHECK ...", "STARTED", "PI_RESULT PASS|FAIL".

const ClientScript := preload("res://addons/control_room_client/control_room_client.gd")

var client: Node
var pi := 1
var failures: Array[String] = []
var incoming: Array = []   # [username, player_data]
var left: Array = []
var ok_count := 0
var wait_count := 0
var errors: Array = []
var auth_count := 0
var gave_up := false


func env(name: String, default: String = "") -> String:
	var v := OS.get_environment(name)
	return v if v != "" else default


func check(cond: bool, msg: String) -> void:
	if cond:
		print("CHECK ok: ", msg)
	else:
		print("CHECK FAIL: ", msg)
		failures.append(msg)


func wait_for(cond: Callable, timeout_s: float) -> bool:
	var t0 := Time.get_ticks_msec()
	while not cond.call():
		if Time.get_ticks_msec() - t0 > timeout_s * 1000.0:
			return false
		await process_frame
	return true


func sleep_s(s: float) -> void:
	var t0 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t0 < s * 1000.0:
		await process_frame


func play_ms(user: String) -> int:
	for part in env("USER_MS").split(",", false):
		var kv := part.split("=")
		if kv.size() == 2 and kv[0] == user:
			return int(kv[1])
	return int(env("PLAY_MS", "500"))


func acked() -> bool:
	return client.unacked.is_empty() and client.send_queue.is_empty()


func finish_and_wait(idx: int) -> void:
	var before_ok := ok_count
	client.finish_game()
	var good: bool = await wait_for(func(): return ok_count > before_ok, 50.0)
	check(good, "Pi %d got game_finish_ok for player #%d (wait signals so far: %d)" % [pi, idx + 1, wait_count])
	check(not client.is_waiting_for_next_pi, "is_waiting_for_next_pi is false after game_finish_ok")


func _initialize() -> void:
	pi = int(env("PI", "1"))
	var port := int(env("PORT", "7321"))
	var mode := env("MODE", "normal")
	var deadline_s := float(env("DEADLINE_S", "55"))
	client = ClientScript.new("ws://127.0.0.1:%d" % port, pi)
	root.add_child(client)
	client.authenticated.connect(func(): auth_count += 1)
	client.gave_up.connect(func(): gave_up = true)
	client.game_finish_wait.connect(func(w):
		wait_count += 1
		print("EV game_finish_wait max_wait=", w))
	client.game_finish_ok.connect(func():
		ok_count += 1
		print("EV game_finish_ok"))
	client.player_incoming.connect(func(u, d):
		incoming.append([u, d])
		print("EV player_incoming user=", u, " data=", JSON.stringify(d)))
	client.player_left.connect(func(u):
		left.append(u)
		print("EV player_left user=", u))
	client.server_error.connect(func(c, m, e):
		errors.append([c, m, e])
		print("EV server_error code=", c, " msg=", m, " event=", e))
	_main(mode, deadline_s)


func _main(mode: String, deadline_s: float) -> void:
	# global time limit
	create_timer(deadline_s).timeout.connect(func():
		print("CHECK FAIL: deadline of %.0f s reached" % deadline_s)
		print("PI_RESULT FAIL pi=", pi)
		quit(3))
	client.run()
	var authed: bool = await wait_for(func(): return auth_count > 0, 40.0)
	check(authed, "Pi %d authenticated" % pi)
	if not authed:
		_end()
		return
	print("EV authenticated")

	if mode == "resume":
		await sleep_s(0.5)
		await finish_and_wait(0)
	elif pi == 1:
		var users := env("USERNAMES", "alice").split(",", false)
		for i in users.size():
			var u: String = users[i]
			client.register_player(u)
			client.start_game()
			var sh := env("SHARE")
			if sh != "":
				var p := sh.split(":")
				client.share(p[1], p[2], int(p[0]))
			await sleep_s(play_ms(u) / 1000.0)
			await finish_and_wait(i)
			if mode == "leave":
				await sleep_s(1.0)
				client.leave_player()
				await wait_for(acked, 10.0)
				check(acked(), "player_leave was acked")
				break
	else:
		var n := int(env("N_PLAYERS", "1"))
		for i in n:
			var got: bool = await wait_for(func(): return incoming.size() > i, 55.0)
			check(got, "Pi %d got player_incoming #%d" % [pi, i + 1])
			if not got:
				break
			var u: String = incoming[i][0]
			if mode == "expect_left":
				var l: bool = await wait_for(func(): return left.size() > 0, 20.0)
				check(l, "Pi %d got player_left" % pi)
				check(left.size() > 0 and left[0] == u, "player_left username is %s" % u)
				check(client.current_player.is_empty(), "current_player is empty after player_left")
				break
			client.start_game()
			if mode == "crash":
				await wait_for(acked, 20.0)
				print("STARTED")
				await sleep_s(1000.0)
			elif i == 0:
				await wait_for(acked, 20.0)
				print("STARTED")
			await sleep_s(play_ms(u) / 1000.0)
			await finish_and_wait(i)
	# let the last events be acked
	var done: bool = await wait_for(acked, 15.0)
	check(done, "all events of Pi %d acked (unacked=%d queue=%d)" % [pi, client.unacked.size(), client.send_queue.size()])
	await sleep_s(0.5)
	_end()


func _end() -> void:
	check(not gave_up, "client did not give up")
	check(errors.is_empty(), "no server_error signals (%s)" % [errors])
	print("PI_RESULT %s pi=%d" % ["PASS" if failures.is_empty() else "FAIL", pi])
	quit(0 if failures.is_empty() else 1)
