extends RefCounted
## Which game each "computer" runs.
##
## To swap a computer, change its line here. The scene root must use a script
## that extends RoomGame (see room_game.gd). Your real game scene can go here.

const GAMES := {
	1: "res://games/default_game.tscn",
	2: "res://games/default_game.tscn",
	3: "res://games/default_game.tscn",
	4: "res://games/default_game.tscn",
	5: "res://games/default_game.tscn",
}
