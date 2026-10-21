class_name Tile
extends PanelContainer
## One "computer": a header with the connection state, the game scene, the last
## message from the server, and a short log.

signal logged(room: int, text: String, color: Color)

const DIM := Color(0.55, 0.58, 0.62)
const SERVER := Color(0.45, 0.85, 1.0)
const GOOD := Color(0.5, 0.9, 0.5)
const WARN := Color(1.0, 0.8, 0.4)
const BAD := Color(1.0, 0.45, 0.4)

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
var _loading_screen: Node


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
	_queue_label.add_theme_color_override("font_color", DIM)
	box.add_child(_queue_label)

	_game_holder = MarginContainer.new()
	box.add_child(_game_holder)
	_load_game()

	_last_message = Label.new()
	_last_message.text = "Last: none"
	_last_message.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_last_message.add_theme_color_override("font_color", SERVER)
	box.add_child(_last_message)

	_log = RichTextLabel.new()
	_log.bbcode_enabled = true
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
	_drop.disabled = client == null
	if client == null:
		_set_status("disconnected", DIM)
		_toggle.text = "Connect"
		_queue_label.text = ""
		return
	_toggle.text = "Disconnect"
	if _gave_up:
		_set_status("gave up", BAD)
	elif client.is_authenticated:
		_set_status("authenticated", GOOD)
	else:
		_set_status(String(ControlRoomClient.State.keys()[client._state]).to_lower().replace("_", " "), WARN)
	_queue_label.text = uri
	if client.send_queue.size() + client.unacked.size() > 0:
		_queue_label.text += "   queued: %d   waiting for ack: %d" % [client.send_queue.size(), client.unacked.size()]


func _set_status(text: String, color: Color) -> void:
	_status.text = text
	_status.add_theme_color_override("font_color", color)


func connect_to(p_uri: String) -> void:
	if client != null:
		disconnect_client()
	uri = p_uri
	_gave_up = false
	client = ControlRoomClient.new(uri, room)
	add_child(client)
	client.authenticated.connect(func() -> void: _say("authenticated", GOOD))
	client.gave_up.connect(func() -> void:
		_gave_up = true
		_say("gave up connecting", BAD))
	client.game_finish_wait.connect(func(max_wait: String) -> void: _message("game_finish_wait: wait until %s" % max_wait))
	client.game_finish_ok.connect(func() -> void: _message("game_finish_ok: go to the next room"))
	client.player_incoming.connect(func(username: String, player_data: Variant) -> void:
		_message("player_incoming: %s, data %s" % [username, JSON.stringify(player_data)]))
	client.player_left.connect(func(username: String) -> void: _message("player_left: %s" % username))
	client.server_error.connect(func(code: String, message: String, event: String) -> void:
		_message("server_error %s: %s (%s)" % [code, message, event], BAD))
	game.attach(client, room)
	_add_loading_screen()
	_say("connecting to %s" % uri, DIM)
	client.run()


## Puts the loading screen over the game only (not over the whole window).
## An older addon version has no add_loading_screen(), so check first.
func _add_loading_screen() -> void:
	if not client.has_method("add_loading_screen"):
		return
	_loading_screen = client.call("add_loading_screen", null, game)
	_loading_screen.reparent(_game_holder, false)


func disconnect_client() -> void:
	if client == null:
		return
	game.detach()
	if _loading_screen != null:
		game.process_mode = Node.PROCESS_MODE_INHERIT  # The screen may have stopped the game
		_loading_screen.queue_free()
		_loading_screen = null
	client.queue_free()
	client = null
	_say("disconnected", DIM)


func drop_link() -> void:
	if client != null and client.websocket != null:
		client.websocket.close()
		_say("link dropped (the client reconnects on its own)", WARN)


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


func _message(text: String, color := SERVER) -> void:
	_last_message.text = "Last: " + text
	_last_message.add_theme_color_override("font_color", color)
	_say("server → " + text, color)


func _say(text: String, color := Color.WHITE) -> void:
	_log.append_text("[color=#%s]%s[/color]\n" % [color.to_html(false), text.replace("[", "[lb]")])
	logged.emit(room, text, color)
