extends Control
## The test game: 5 "computers" (one per room) and a console.
## Which game each computer runs is set in rooms.gd.

const DEFAULT_ADDRESS := "ws://127.0.0.1:7321"
const HELP := """Commands (room = 1 to 5):
  <room> register <name>      room 1: register a player
  <room> start | finish | leave
  <room> share <key> <value> [rooms]    rooms: empty/all, 3 or 2,3
  <room> connect | disconnect | drop
  connect | disconnect        all rooms
  state | leaderboard         read the server over HTTP
  clear | help
Example: 3 share sword true 2"""

var tiles: Array[Tile] = []

var _address: LineEdit
var _console_log: RichTextLabel
var _console_input: LineEdit
var _http: HTTPRequest


func _ready() -> void:
	var root := VBoxContainer.new()
	root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(root)

	var top := HBoxContainer.new()
	root.add_child(top)
	var label := Label.new()
	label.text = "Server"
	top.add_child(label)
	_address = LineEdit.new()
	_address.text = DEFAULT_ADDRESS
	_address.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_address.text_submitted.connect(func(_t: String) -> void: _connect_all())
	top.add_child(_address)
	top.add_child(_button("Connect all", _connect_all))
	top.add_child(_button("Disconnect all", _disconnect_all))

	var grid := GridContainer.new()
	grid.columns = 3
	grid.size_flags_vertical = Control.SIZE_EXPAND_FILL
	root.add_child(grid)
	var games: Dictionary = preload("res://rooms.gd").GAMES
	for room in range(1, 6):
		var tile := Tile.new(room, load(games[room]))
		tile.address_provider = get_server_address
		tile.logged.connect(_on_tile_logged)
		grid.add_child(tile)
		tiles.append(tile)
	var help := RichTextLabel.new()
	help.text = HELP
	help.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	help.size_flags_vertical = Control.SIZE_EXPAND_FILL
	grid.add_child(help)

	_console_log = RichTextLabel.new()
	_console_log.scroll_following = true
	_console_log.custom_minimum_size.y = 220
	root.add_child(_console_log)
	_console_input = LineEdit.new()
	_console_input.placeholder_text = "Type a command (help)"
	_console_input.text_submitted.connect(_on_console_submitted)
	root.add_child(_console_input)

	_http = HTTPRequest.new()
	add_child(_http)

	_print("Test game ready. Press Connect all, or type 'connect'. Type 'help' for the commands.")
	_apply_launch_arguments()


func get_server_address() -> String:
	return _address.text.strip_edges()


func _button(text: String, callback: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.pressed.connect(callback)
	return button


## Options after `--`: --addr=ws://host:port  --connect
func _apply_launch_arguments() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--addr="):
			_address.text = arg.trim_prefix("--addr=")
		elif arg == "--connect":
			_connect_all()


func _connect_all() -> void:
	for tile in tiles:
		tile.connect_to(get_server_address())


func _disconnect_all() -> void:
	for tile in tiles:
		tile.disconnect_client()


func _on_tile_logged(room: int, text: String) -> void:
	_print("room %d: %s" % [room, text])


func _print(text: String) -> void:
	_console_log.append_text("[%s] %s\n" % [Time.get_time_string_from_system(), text])


func _on_console_submitted(line: String) -> void:
	_console_input.clear()
	if line.strip_edges() == "":
		return
	_print("> " + line)
	run_console(line)


## Runs one console line. Also used by tests.
func run_console(line: String) -> void:
	var words := line.strip_edges().split(" ", false)
	if words.is_empty():
		return
	var first: String = words[0]
	var error := ""
	if first.is_valid_int():
		error = _room_command(int(first), words.slice(1))
	else:
		match first:
			"help":
				_print(HELP)
			"clear":
				_console_log.clear()
			"connect":
				_connect_all()
			"disconnect":
				_disconnect_all()
			"state":
				_fetch("/state")
			"leaderboard":
				_fetch("/leaderboard")
			_:
				error = "unknown command '%s' (try help)" % first
	if error != "":
		_print("error: " + error)


func _room_command(room: int, words: PackedStringArray) -> String:
	if room < 1 or room > 5:
		return "room must be 1 to 5"
	if words.is_empty():
		return "missing command (try help)"
	var tile := tiles[room - 1]
	var verb := words[0]
	match verb:
		"connect":
			tile.connect_to(get_server_address())
			return ""
		"disconnect":
			tile.disconnect_client()
			return ""
		"drop":
			tile.drop_link()
			return ""
	return tile.game.run_action(verb, words.slice(1))


func _fetch(path: String) -> void:
	var url := get_server_address()
	url = url.replace("wss://", "https://").replace("ws://", "http://")
	url = url.rstrip("/") + path
	_print("GET " + url)
	_http.cancel_request()
	var err := _http.request(url)
	if err != OK:
		_print("error: could not start the request (code %d)" % err)
		return
	var result: Array = await _http.request_completed
	if result[0] != HTTPRequest.RESULT_SUCCESS:
		_print("error: request failed (result %d)" % result[0])
		return
	var body: String = result[3].get_string_from_utf8()
	var parsed: Variant = JSON.parse_string(body)
	_print("HTTP %d\n%s" % [result[1], JSON.stringify(_intify(parsed), "  ") if parsed != null else body])


## JSON numbers load as floats. Show whole numbers without ".0".
func _intify(value: Variant) -> Variant:
	if value is float and value == floorf(value):
		return int(value)
	if value is Array:
		return value.map(_intify)
	if value is Dictionary:
		var result := {}
		for key in value:
			result[key] = _intify(value[key])
		return result
	return value
