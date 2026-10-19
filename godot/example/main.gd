extends Node

var client: ControlRoomClient


func _ready() -> void:
	client = ControlRoomClient.new("ws://0.0.0.0:443", 1)  # Eksempel uri og pi id
	add_child(client)
	client.gave_up.connect(get_tree().quit.bind(1))
	client.game_finish_wait.connect(func(max_wait: String) -> void: print("vent til ", max_wait))
	client.game_finish_ok.connect(func() -> void: print("ferdig, videre til neste rom"))
	client.player_incoming.connect(func(username: String, player_data: Variant) -> void: print("ny spiller ", username, " ", player_data))
	client.player_left.connect(func(username: String) -> void: print("spiller dro ", username))
	client.server_error.connect(func(code: String, message: String, event: String) -> void: print("feil ", code, ": ", message, " (", event, ")"))
	client.run()
	simulate_game()


func simulate_game() -> void:
	while not client.is_authenticated:
		await get_tree().create_timer(0.5).timeout

	# Later som at jeg er pi 1
	client.register_player("John Doe")
	await get_tree().create_timer(3).timeout

	client.start_game()
	await get_tree().create_timer(8).timeout

	client.share("sword", true, 2)
	client.share("key_1", true)

	client.finish_game()
	await get_tree().create_timer(5).timeout
