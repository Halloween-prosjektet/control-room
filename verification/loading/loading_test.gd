extends SceneTree
# Test for control_room_loading_screen.gd (no server needed).
# Run: godot --headless --path godot -s ../verification/loading/loading_test.gd
# Prints "CHECK ok/FAIL" lines and "LOADING_RESULT PASS|FAIL". Exit code 0 = pass.

var failures := 0


func check(cond: bool, msg: String) -> void:
	print("CHECK ", "ok: " if cond else "FAIL: ", msg)
	if not cond:
		failures += 1


func press() -> void:
	var event := InputEventKey.new()
	event.keycode = KEY_SPACE
	event.pressed = true
	Input.parse_input_event(event)
	await process_frame
	await process_frame


func _initialize() -> void:
	run.call_deferred()


func run() -> void:
	var host := Node.new()
	root.add_child(host)
	var client := ControlRoomClient.new("ws://127.0.0.1:1", 3)
	host.add_child(client)
	var screen := client.add_loading_screen()
	await process_frame
	var started_count := [0]
	screen.started.connect(func() -> void: started_count[0] += 1)

	check(screen.state == ControlRoomLoadingScreen.State.IDLE, "starts idle")
	check(paused, "tree paused while idle")
	check(client.process_mode == Node.PROCESS_MODE_ALWAYS, "client keeps running while paused")

	await press()
	check(screen.state == ControlRoomLoadingScreen.State.IDLE and paused, "button ignored while idle")

	client.player_incoming.emit("Alice", {})
	check(screen.state == ControlRoomLoadingScreen.State.READY, "ready after player_incoming")
	check(paused, "still paused while ready")

	client.player_left.emit("Alice")
	check(screen.state == ControlRoomLoadingScreen.State.IDLE, "idle after player_left")

	client.current_player["username"] = "Bob"
	client.player_incoming.emit("Bob", {})
	await press()
	check(screen.state == ControlRoomLoadingScreen.State.PLAYING, "playing after button")
	check(not paused, "tree unpaused after button")
	check(started_count[0] == 1, "started emitted once")
	check(client.send_queue.size() + client.unacked.size() == 1, "start_game queued")

	# reload would end this script, so turn it off
	screen.reload_scene_on_finish = false
	client.game_finish_ok.emit()
	check(screen.state == ControlRoomLoadingScreen.State.IDLE and paused, "idle and paused after finish")
	check(client.current_player.is_empty(), "current_player cleared")

	# target mode: only the target stops
	var game := Node.new()
	host.add_child(game)
	var client2 := ControlRoomClient.new("ws://127.0.0.1:1", 2)
	host.add_child(client2)
	var screen2 := client2.add_loading_screen(null, game)
	screen2.reload_scene_on_finish = false
	paused = false
	await process_frame
	check(game.process_mode == Node.PROCESS_MODE_DISABLED, "target disabled while idle")
	check(not paused, "tree not paused in target mode")
	client2.player_incoming.emit("Cy", {})
	await press()
	check(game.process_mode == Node.PROCESS_MODE_INHERIT, "target restored after button")

	# room 1: ready at once, no start_game
	var client1 := ControlRoomClient.new("ws://127.0.0.1:1", 1)
	host.add_child(client1)
	var screen1 := client1.add_loading_screen(null, game)
	check(screen1.state == ControlRoomLoadingScreen.State.READY, "room 1 ready at once")
	await press()
	check(screen1.state == ControlRoomLoadingScreen.State.PLAYING, "room 1 playing after button")
	check(client1.send_queue.size() + client1.unacked.size() == 0, "room 1 does not call start_game")

	print("LOADING_RESULT ", "PASS" if failures == 0 else "FAIL")
	quit(0 if failures == 0 else 1)
