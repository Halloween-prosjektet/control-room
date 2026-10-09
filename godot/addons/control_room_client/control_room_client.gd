class_name ControlRoomClient
extends Node

signal authenticated
signal gave_up

enum State { IDLE, CONNECTING, AUTHENTICATING, CONNECTED, WAITING_RETRY, STOPPED }

const AUTH_ATTEMPTS := 3
const AUTH_TIMEOUT := 5.0
const CONNECT_TIMEOUT := 10.0
const MAX_RETRIES := 10
const INITIAL_RETRY_DELAY := 5

var uri := "ws://0.0.0.0:443"  # Eksempel uri
var pi_id := 1  # Gruppen din sitt rom nummer. 1-5
var websocket: WebSocketPeer = null

var current_player := {}  # Informasjon om nåværende spiller, brukervavn osv

var is_waiting_for_next_pi := false
var is_authenticated := false

var send_queue: Array = []

var _state := State.IDLE
var _timer := 0.0
var _auth_attempt := 0
var _retry_amount := 0
var _retry_delay := INITIAL_RETRY_DELAY


func _init(p_uri: String = "ws://0.0.0.0:443", p_pi_id: int = 1) -> void:
	uri = p_uri
	pi_id = p_pi_id


func _get_timestamp() -> String:
	# Samme format som Python sin isoformat() i UTC+2
	var now := Time.get_unix_time_from_system()
	var seconds := int(floor(now))
	var micros := int(round((now - seconds) * 1000000.0))
	if micros >= 1000000:
		seconds += 1
		micros -= 1000000
	var t := Time.get_datetime_dict_from_unix_time(seconds + 2 * 3600)
	return "%04d-%02d-%02dT%02d:%02d:%02d.%06d+02:00" % [
		t.year, t.month, t.day, t.hour, t.minute, t.second, micros
	]


func send_event(payload: Dictionary) -> void:
	if websocket and websocket.get_ready_state() == WebSocketPeer.STATE_OPEN:
		if websocket.send_text(JSON.stringify(payload)) != OK:
			send_queue.append(payload)
	else:
		send_queue.append(payload)


func register_player(username: String) -> void:
	current_player["username"] = username
	send_event({
		"event": "register",
		"username": username,
		"timestamp": _get_timestamp(),
	})


func leave_player() -> void:
	send_event({
		"event": "player_leave",
	})
	current_player = {}


func start_game() -> void:
	send_event({
		"event": "game_start",
		"timestamp": _get_timestamp(),
	})


func finish_game() -> void:
	send_event({
		"event": "game_finish",
		"timestamp": _get_timestamp(),
	})


# pi: null (alle), en int, eller en Array med ints
func share(key: String, value: Variant, pi: Variant = null) -> void:
	send_event({
		"event": "share",
		"key": key,
		"value": value,
		"pi": pi,
		"timestamp": _get_timestamp(),
	})


func event_handler(data: Dictionary) -> void:
	match data.get("event", null):
		null:
			pass
		"register_player_ok", "player_leave_ok", "game_start_ok", "game_finish_ok":
			pass
		"player_left":
			current_player = {}
			send_event({
				"event": "player_left_ok",
			})
		"player_incoming":
			current_player["username"] = data.get("username", null)
			current_player["data"] = data.get("player_data", null)
			send_event({
				"event": "player_incoming_ok",
			})


# Starter tilkoblingen. Kobler til på nytt automatisk hvis forbindelsen mistes.
func run() -> void:
	_retry_amount = 0
	_retry_delay = INITIAL_RETRY_DELAY
	_connect()


func _connect() -> void:
	websocket = WebSocketPeer.new()
	var err := websocket.connect_to_url(uri)
	if err != OK:
		_connection_lost("could not connect to %s (error %d)" % [uri, err])
		return
	_state = State.CONNECTING
	_timer = CONNECT_TIMEOUT


func _process(delta: float) -> void:
	match _state:
		State.IDLE, State.STOPPED:
			return
		State.WAITING_RETRY:
			_timer -= delta
			if _timer <= 0.0:
				_connect()
			return

	websocket.poll()
	var ready_state := websocket.get_ready_state()
	if ready_state == WebSocketPeer.STATE_CLOSED:
		_connection_lost("connection closed (code %d) %s" % [
			websocket.get_close_code(), websocket.get_close_reason()
		])
		return

	match _state:
		State.CONNECTING:
			if ready_state == WebSocketPeer.STATE_OPEN:
				_state = State.AUTHENTICATING
				_auth_attempt = 0
				_begin_auth_attempt()
				return
			_timer -= delta
			if _timer <= 0.0:
				_connection_lost("timed out connecting to %s" % uri)
		State.AUTHENTICATING:
			if websocket.get_available_packet_count() > 0:
				# Akkurat som i Python brukes hver melding opp som ett forsøk
				var data = _parse(websocket.get_packet())
				if data is Dictionary and data.get("event", null) == "auth_ok":
					_on_authenticated()
				else:
					_begin_auth_attempt()
				return
			_timer -= delta
			if _timer <= 0.0:
				_begin_auth_attempt()
		State.CONNECTED:
			while websocket.get_available_packet_count() > 0:
				var data = _parse(websocket.get_packet())
				if data is Dictionary:
					event_handler(data)
				elif data != null:
					print("server sent unexpected json package %s" % [data])
				if _state != State.CONNECTED:
					break


func _parse(packet: PackedByteArray) -> Variant:
	var json := JSON.new()
	var text := packet.get_string_from_utf8()
	if json.parse(text) != OK:
		print("server sent non valid json package %s" % json.get_error_message())
		return null
	return json.data


func _begin_auth_attempt() -> void:
	if _auth_attempt >= AUTH_ATTEMPTS:
		_connection_lost("Could not authenticate with controll server after %d attempts." % AUTH_ATTEMPTS)
		return
	_auth_attempt += 1
	_timer = AUTH_TIMEOUT
	send_event({"event": "auth", "pi": pi_id})


func _on_authenticated() -> void:
	is_authenticated = true
	_state = State.CONNECTED
	_retry_amount = 0
	_retry_delay = INITIAL_RETRY_DELAY

	for _i in range(send_queue.size()):
		send_event(send_queue.pop_front())

	authenticated.emit()


func _connection_lost(reason: String) -> void:
	print("server connection lost \n%s" % reason)
	is_authenticated = false
	if websocket:
		websocket.close()
	websocket = null

	if _retry_amount >= MAX_RETRIES:
		push_error("Connection couldn't be established with control room.")
		_state = State.STOPPED
		gave_up.emit()
		return
	_retry_amount += 1
	if _retry_amount > 2:
		_retry_delay = _retry_amount ** 2
	_state = State.WAITING_RETRY
	_timer = _retry_delay
