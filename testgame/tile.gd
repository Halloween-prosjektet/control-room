class_name Tile
extends PanelContainer
## One "computer": a header with the connection state, the game scene, the last
## message from the server, and a short log.

signal logged(room: int, text: String)

var room: int
var game: RoomGame
var client: ControlRoomClient
var uri := ""
## Returns the server address from the field at the top of the window.
var address_provider: Callable

var _game_scene: PackedScene
var _status: Label
var _queue_label: Label
var _toggle: Button
var _drop: Button
var _last_message: Label
var _log: RichTextLabel
var _game_holder: Control
var _gave_up := false


func _init(p_room: int, p_game_scene: PackedScene) -> void:
	room = p_room
	_game_scene = p_game_scene
	size_flags_horizontal = Control.SIZE_EXPAND_FILL
	size_flags_vertical = Control.SIZE_EXPAND_FILL


func _ready() -> void:
	var box := VBoxContainer.new()
	add_child(box)

	var header := HBoxContainer.new()
	box.add_child(header)
	var title := Label.new()
	title.text = "Computer %d" % room
	title.add_theme_font_size_override("font_size", 20)
	header.add_child(title)
	_status = Label.new()
	_status.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_status.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	header.add_child(_status)
	_drop = Button.new()
	_drop.text = "Drop link"
	_drop.tooltip_text = "Close the socket. The client must reconnect and send again."
	_drop.pressed.connect(drop_link)
	header.add_child(_drop)
	_toggle = Button.new()
	_toggle.pressed.connect(_on_toggle)
	header.add_child(_toggle)

	_queue_label = Label.new()
	_queue_label.add_theme_font_size_override("font_size", 12)
	box.add_child(_queue_label)

	_game_holder = MarginContainer.new()
	box.add_child(_game_holder)
	_load_game()

	_last_message = Label.new()
	_last_message.text = "Last server message: none"
	_last_message.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_last_message.add_theme_color_override("font_color", Color(0.6, 0.9, 1.0))
	box.add_child(_last_message)

	_log = RichTextLabel.new()
	_log.scroll_following = true
	_log.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_log.custom_minimum_size.y = 80
	box.add_child(_log)


func _load_game() -> void:
	game = _game_scene.instantiate() as RoomGame
	if game == null:
		push_error("The game for room %d does not extend RoomGame." % room)
		return
	game.room = room
	game.logged.connect(_say)
	_game_holder.add_child(game)


func _process(_delta: float) -> void:
	if client == null:
		_status.text = "disconnected"
		_toggle.text = "Connect"
		_queue_label.text = ""
		_drop.disabled = true
		return
	_toggle.text = "Disconnect"
	_drop.disabled = false
	if _gave_up:
		_status.text = "gave up"
	elif client.is_authenticated:
		_status.text = "authenticated"
	else:
		_status.text = String(ControlRoomClient.State.keys()[client._state]).to_lower().replace("_", " ")
	_queue_label.text = "%s   queued: %d   waiting for ack: %d" % [uri, client.send_queue.size(), client.unacked.size()]


func connect_to(p_uri: String) -> void:
	if client != null:
		disconnect_client()
	uri = p_uri
	_gave_up = false
	client = ControlRoomClient.new(uri, room)
	add_child(client)
	client.authenticated.connect(func() -> void: _say("authenticated"))
	client.gave_up.connect(func() -> void:
		_gave_up = true
		_say("gave up connecting"))
	client.game_finish_wait.connect(func(max_wait: String) -> void: _message("game_finish_wait: wait until %s" % max_wait))
	client.game_finish_ok.connect(func() -> void: _message("game_finish_ok: the player can go to the next room"))
	client.player_incoming.connect(func(username: String, player_data: Variant) -> void:
		_message("player_incoming: %s, data %s" % [username, JSON.stringify(player_data)]))
	client.player_left.connect(func(username: String) -> void: _message("player_left: %s" % username))
	client.server_error.connect(func(code: String, message: String, event: String) -> void:
		_message("server_error %s: %s (%s)" % [code, message, event]))
	game.attach(client, room)
	_say("connecting to %s" % uri)
	client.run()


func disconnect_client() -> void:
	if client == null:
		return
	game.detach()
	client.queue_free()
	client = null
	_say("disconnected")


func drop_link() -> void:
	if client != null and client.websocket != null:
		client.websocket.close()
		_say("link dropped (the client reconnects on its own)")


## Runs a console command. Returns an error text, or "".
func command(verb: String, args: PackedStringArray) -> String:
	match verb:
		"connect":
			connect_to(address_provider.call())
		"disconnect":
			disconnect_client()
		"drop":
			drop_link()
		_:
			return game.run_action(verb, args)
	return ""


func _on_toggle() -> void:
	command("disconnect" if client != null else "connect", PackedStringArray())


func _message(text: String) -> void:
	_last_message.text = "Last server message: " + text
	_say("server → " + text)


func _say(text: String) -> void:
	var line := "[%s] %s" % [Time.get_time_string_from_system(), text]
	_log.append_text(line + "\n")
	logged.emit(room, text)
