class_name RoomGame
extends Control
## Base class for the game on one "computer".
##
## A game scene gets `client` (the ControlRoomClient of its room) and `room`
## (1 to 5). The client can be replaced when the tile connects again, so use
## the two hooks below instead of connecting signals in _ready().
##
## Use run_action() for client calls. It logs the call. The console commands
## use the same function.

signal logged(text: String)

var client: ControlRoomClient
var room := 0


func attach(p_client: ControlRoomClient, p_room: int) -> void:
	client = p_client
	room = p_room
	_on_attach()


func detach() -> void:
	client = null
	_on_detach()


## Called when a new client exists. Connect to its signals here.
func _on_attach() -> void:
	pass


## Called when the client is gone (the tile disconnected).
func _on_detach() -> void:
	pass


## Verbs: register <name>, start, finish, leave, share <key> <value> [rooms].
## Returns "" if the call was sent, or an error text.
func run_action(verb: String, args: PackedStringArray = PackedStringArray()) -> String:
	if client == null:
		return "not connected"
	match verb:
		"register":
			if args.size() < 1:
				return "usage: register <name>"
			logged.emit("register_player(%s)" % args[0])
			client.register_player(args[0])
		"start":
			logged.emit("start_game()")
			client.start_game()
		"finish":
			logged.emit("finish_game()")
			client.finish_game()
		"leave":
			logged.emit("leave_player()")
			client.leave_player()
		"share":
			if args.size() < 2:
				return "usage: share <key> <value> [rooms]"
			var rooms: Variant = parse_rooms(args[2] if args.size() > 2 else "")
			if rooms is String:
				return rooms
			var value: Variant = parse_value(args[1])
			logged.emit("share(%s, %s, %s)" % [args[0], JSON.stringify(value), JSON.stringify(rooms)])
			client.share(args[0], value, rooms)
		_:
			return "unknown action: %s" % verb
	return ""


## "true" -> true, "3" -> 3, "[1,2]" -> array, anything else -> string.
static func parse_value(text: String) -> Variant:
	var parsed: Variant = JSON.parse_string(text)
	if parsed == null:
		return text
	if parsed is float and parsed == floorf(parsed):
		return int(parsed)
	return parsed


## "" or "all" -> null (all rooms), "3" -> 3, "2,3" -> [2, 3].
## Returns an error String if the text is not valid.
static func parse_rooms(text: String) -> Variant:
	text = text.strip_edges()
	if text == "" or text == "all":
		return null
	var rooms: Array = []
	for part in text.split(",", false):
		if not part.strip_edges().is_valid_int():
			return "rooms must be numbers like 3 or 2,3 (got '%s')" % text
		rooms.append(int(part))
	return rooms[0] if rooms.size() == 1 else rooms
