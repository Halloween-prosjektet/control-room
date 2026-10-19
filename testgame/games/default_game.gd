extends RoomGame
## The default "game": only buttons that make the client calls.
## Room 1 also has the name field and the Register button.
## The tile sets `room` before this node is ready.

var _name_edit: LineEdit
var _key_edit: LineEdit
var _value_edit: LineEdit
var _rooms_edit: LineEdit
var _error: Label


func _ready() -> void:
	if room == 1:
		var row := HBoxContainer.new()
		add_child(row)
		_name_edit = LineEdit.new()
		_name_edit.placeholder_text = "Player name"
		_name_edit.text = "Alice"
		_name_edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		_name_edit.text_submitted.connect(func(_t: String) -> void: _register())
		row.add_child(_name_edit)
		row.add_child(_button("Register", _register))

	var row2 := HBoxContainer.new()
	add_child(row2)
	row2.add_child(_button("Start game", _act.bind("start")))
	row2.add_child(_button("Finish game", _act.bind("finish")))
	row2.add_child(_button("Leave", _act.bind("leave")))

	var row3 := HBoxContainer.new()
	add_child(row3)
	_key_edit = _field(row3, "key", "sword", 1.0)
	_value_edit = _field(row3, "value", "true", 1.0)
	_rooms_edit = _field(row3, "rooms (empty = all)", "", 1.2)
	row3.add_child(_button("Share", _share))

	_error = Label.new()
	_error.add_theme_color_override("font_color", Color(1.0, 0.5, 0.4))
	add_child(_error)


func _button(text: String, callback: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.pressed.connect(callback)
	return button


func _field(parent: Control, hint: String, text: String, stretch: float) -> LineEdit:
	var edit := LineEdit.new()
	edit.placeholder_text = hint
	edit.text = text
	edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	edit.size_flags_stretch_ratio = stretch
	edit.custom_minimum_size.x = 50
	parent.add_child(edit)
	return edit


func _act(verb: String) -> void:
	_error.text = run_action(verb)


func _register() -> void:
	_error.text = run_action("register", PackedStringArray([_name_edit.text.strip_edges()]))


func _share() -> void:
	_error.text = run_action("share", PackedStringArray([_key_edit.text, _value_edit.text, _rooms_edit.text]))
