extends Node

var client: ControlRoomClient


func _ready() -> void:
	client = ControlRoomClient.new("ws://0.0.0.0:443", 1)  # Eksempel uri og pi id
	add_child(client)
	client.gave_up.connect(get_tree().quit.bind(1))
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
