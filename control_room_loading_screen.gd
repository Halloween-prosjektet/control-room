class_name ControlRoomLoadingScreen
extends Control
## Ventskjerm: spillet står stille til en spiller står i kø for denne Pi-en.
## Når en spiller står i kø, kan spilleren trykke på en hvilken som helst knapp
## for å starte. Da kalles client.start_game() av seg selv.
##
## Enkleste bruk (etter add_child(client), før client.run()):
##     client.add_loading_screen()
##
## Eget utseende: lag en scene der rot-noden bruker et skript som
## "extends ControlRoomLoadingScreen", og overstyr _show_idle() og _show_ready().
## Send scenen inn: client.add_loading_screen(preload("res://min_ventskjerm.tscn")).

## Spilleren trykket på en knapp, og spillet er i gang igjen.
signal started
## Spilleren er ferdig eller dro. Ventskjermen vises igjen.
signal finished

enum State { IDLE, READY, PLAYING }

## Teksten som vises når ingen står i kø.
@export var idle_text := "Venter på spiller …"
## Teksten som vises når en spiller står i kø. {name} blir brukernavnet.
@export var ready_text := "Velkommen, {name}!"
## Teksten under velkomsten.
@export var press_text := "Trykk på en knapp for å starte"
## Kall client.start_game() når spilleren trykker. Rom 1 gjør ikke dette:
## der må spillet registrere spilleren først, og så kalle start_game() selv.
@export var auto_start_game := true
## Last scenen på nytt når spilleren er ferdig eller drar, slik at neste
## spiller får et rent spill. Brukes kun når "target" er null.
@export var reload_scene_on_finish := true

## Noden som settes på pause. Null betyr hele spillet (get_tree().paused).
## Sett en node hvis ventskjermen ligger inne i en større scene.
var target: Node = null
var client: ControlRoomClient = null
var state := State.IDLE

var _title: Label
var _subtitle: Label
var _target_mode := Node.PROCESS_MODE_INHERIT


func _init() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS  # Må kjøre selv om spillet står på pause
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	z_index = RenderingServer.CANVAS_ITEM_Z_MAX


func _ready() -> void:
	_build_default_ui()
	_wait(State.IDLE)


## Kobler ventskjermen til klienten. add_loading_screen() gjør dette for deg.
func bind(p_client: ControlRoomClient) -> void:
	client = p_client
	if target == null:
		# Klienten må fortsette å snakke med serveren mens spillet står på pause
		client.process_mode = Node.PROCESS_MODE_ALWAYS
	client.player_incoming.connect(_on_player_incoming)
	client.player_left.connect(_on_player_left)
	client.game_finish_ok.connect(reset)
	# Rom 1 har ingen kø. Der trykker spilleren for å komme til navnefeltet.
	if client.pi_id == 1:
		auto_start_game = false
		set_ready("")
		return
	# Spilleren kan allerede stå i kø (player_incoming kom før vi var klare)
	var username: Variant = client.current_player.get("username", null)
	if username is String and username.strip_edges() != "":
		set_ready(username)


## Viser "trykk for å starte". Rom 1 kan kalle denne selv med et brukernavn.
func set_ready(username: String) -> void:
	if state == State.PLAYING:
		return
	_wait(State.READY)
	_show_ready(username)


## Går tilbake til ventemodus. Kalles av seg selv når spilleren er ferdig eller drar.
func reset() -> void:
	finished.emit()
	if client != null:
		client.current_player = {}
	if reload_scene_on_finish and target == null and is_inside_tree() \
			and get_tree().current_scene != null:
		get_tree().paused = false
		get_tree().reload_current_scene()
		return
	if client != null and client.pi_id == 1:
		set_ready("")
	else:
		_wait(State.IDLE)
		_show_idle()


## Overstyr for eget utseende. Kalles når ingen står i kø.
func _show_idle() -> void:
	_title.text = idle_text
	_subtitle.text = ""


## Overstyr for eget utseende. Kalles når en spiller står i kø.
func _show_ready(username: String) -> void:
	_title.text = ready_text.format({"name": username}) if username != "" else ready_text.replace(", {name}", "")
	_subtitle.text = press_text


# Viser skjermen og setter spillet på pause
func _wait(new_state: State) -> void:
	state = new_state
	_pause(true)
	visible = true


func _input(event: InputEvent) -> void:
	var is_button := event is InputEventKey or event is InputEventMouseButton \
			or event is InputEventJoypadButton or event is InputEventScreenTouch
	if state != State.READY or not is_button or event.is_echo() or not event.is_pressed():
		return
	get_viewport().set_input_as_handled()  # Trykket skal ikke gå videre til spillet
	state = State.PLAYING
	visible = false
	_pause(false)
	if auto_start_game and client != null:
		client.start_game()
	started.emit()


func _pause(paused: bool) -> void:
	if target == null:
		if is_inside_tree():
			get_tree().paused = paused
	elif paused:
		if target.process_mode != Node.PROCESS_MODE_DISABLED:
			_target_mode = target.process_mode
		target.process_mode = Node.PROCESS_MODE_DISABLED
	else:
		target.process_mode = _target_mode


func _on_player_incoming(username: String, _player_data: Variant) -> void:
	set_ready(username)


func _on_player_left(_username: String) -> void:
	reset()


func _build_default_ui() -> void:
	var background := ColorRect.new()
	background.color = Color(0.05, 0.05, 0.08, 1.0)
	background.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(background)
	var box := VBoxContainer.new()
	box.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	box.grow_horizontal = Control.GROW_DIRECTION_BOTH
	box.grow_vertical = Control.GROW_DIRECTION_BOTH
	box.alignment = BoxContainer.ALIGNMENT_CENTER
	add_child(box)
	_title = Label.new()
	_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_title.add_theme_font_size_override("font_size", 48)
	box.add_child(_title)
	_subtitle = Label.new()
	_subtitle.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_subtitle.add_theme_font_size_override("font_size", 24)
	box.add_child(_subtitle)
