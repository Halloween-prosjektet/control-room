class_name ControlRoomClient
extends Node

signal authenticated
signal gave_up
signal game_finish_wait(max_wait: String)
signal game_finish_ok
signal player_incoming(username: String, player_data: Variant)
signal player_left(username: String)
signal server_error(code: String, message: String, event: String)

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

var send_queue: Array = []  # Hendelser som ikke er sendt ennå
var unacked: Array = []  # Sendt, men serveren har ikke svart med "ack" ennå

var _next_seq := 1
# Tilfeldig id for denne oppstarten. Serveren nullstiller løpenummer når den endres.
var _session := "%08x%08x" % [randi(), randi()]
var _state := State.IDLE
var _timer := 0.0
var _auth_attempt := 0
var _retry_amount := 0
var _retry_delay := INITIAL_RETRY_DELAY


func _init(p_uri: String = "ws://0.0.0.0:443", p_pi_id: int = 1) -> void:
	uri = p_uri
	pi_id = p_pi_id


func _get_timestamp() -> String:
	# Samme format som Python sin isoformat(), alltid i UTC med +00:00
	var now := Time.get_unix_time_from_system()
	var seconds := int(floor(now))
	var micros := int(round((now - seconds) * 1000000.0))
	if micros >= 1000000:
		seconds += 1
		micros -= 1000000
	var t := Time.get_datetime_dict_from_unix_time(seconds)
	return "%04d-%02d-%02dT%02d:%02d:%02d.%06d+00:00" % [
		t.year, t.month, t.day, t.hour, t.minute, t.second, micros
	]


func send_event(payload: Dictionary) -> void:
	# Hver hendelse får et løpenummer. Serveren svarer med "ack" og ignorerer
	# løpenumre den har sett før, så hendelser kan sendes på nytt uten risiko.
	payload["seq"] = _next_seq
	_next_seq += 1
	# Hendelser sendes kun når vi er autentisert og køen er tom. Da beholdes
	# rekkefølgen, og ingenting sendes før auth_ok.
	if is_authenticated and send_queue.is_empty() and _send_raw(payload):
		unacked.append(payload)
		return
	send_queue.append(payload)


func _send_raw(payload: Dictionary) -> bool:
	if websocket == null or websocket.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return false
	return websocket.send_text(JSON.stringify(payload)) == OK


func register_player(username: String) -> void:
	current_player["username"] = username
	send_event({
		"event": "player_register",
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
		"player_register_ok", "register_player_ok", "player_leave_ok", "game_start_ok":
			pass
		"ack":
			_handle_ack(int(data.get("seq", 0)))
		"game_finish_wait":
			is_waiting_for_next_pi = true
			game_finish_wait.emit(str(data.get("max_wait", "")))
		"game_finish_ok":
			is_waiting_for_next_pi = false
			game_finish_ok.emit()
		"player_left":
			current_player = {}
			send_event(_ok_with_id("player_left_ok", data))
			player_left.emit(str(data.get("username", "")))
		"player_incoming":
			current_player["username"] = data.get("username", null)
			current_player["data"] = data.get("player_data", null)
			send_event(_ok_with_id("player_incoming_ok", data))
			player_incoming.emit(str(data.get("username", "")), data.get("player_data", null))
		"error":
			var code := str(data.get("code", ""))
			var message := str(data.get("message", ""))
			# "event" er alltid "error"; hendelsen som feilet ligger i "event_name"
			var event := str(data.get("event_name", ""))
			print("server error %s: %s" % [code, message])
			server_error.emit(code, message, event)


# Svaret på player_incoming / player_left. Hvis meldingen har "id", sendes den
# samme "id" tilbake, slik at serveren bare fjerner akkurat den meldingen.
func _ok_with_id(event: String, data: Dictionary) -> Dictionary:
	var payload := {"event": event}
	var id: Variant = data.get("id", null)
	if id is int or id is float:
		payload["id"] = int(id)
	return payload


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
			_flush_queue()
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
	_send_raw({"event": "auth", "pi": pi_id, "session": _session})


# Send køen i rekkefølge. Stopp ved første feil, så rekkefølgen beholdes.
func _flush_queue() -> void:
	while not send_queue.is_empty():
		if not _send_raw(send_queue[0]):
			break
		unacked.append(send_queue.pop_front())


# "ack" bekrefter alle hendelser med seq <= n
func _handle_ack(n: int) -> void:
	unacked = unacked.filter(func(e): return e["seq"] > n)
	send_queue = send_queue.filter(func(e): return e["seq"] > n)


func _on_authenticated() -> void:
	is_authenticated = true
	_state = State.CONNECTED
	_retry_amount = 0
	_retry_delay = INITIAL_RETRY_DELAY

	# Hendelser uten ack kan ha gått tapt med forbindelsen: send dem først på nytt
	send_queue = unacked + send_queue
	unacked = []
	_flush_queue()

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
