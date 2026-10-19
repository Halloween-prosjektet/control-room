# Control Room Test Game

A small Godot 4 project to test the control room server. It shows 5 "computers"
(room 1 to 5). Each computer has its own client and its own game scene. A
console at the bottom shows all events and takes commands.

This branch (`testgame`) is not for `main`.

## Start

```sh
git submodule update --init
cd ../backend && bun start        # in a second terminal
```

Open `testgame/` in Godot 4.4 or newer and run it. Use the server address
`ws://127.0.0.1:7321` (the default), then press **Connect all**.
Use `127.0.0.1`, not `localhost`: the server listens on IPv4 only.

## Console commands

| Command | Result |
| --- | --- |
| `1 register Bob` | Register a player (room 1) |
| `2 start`, `2 finish`, `2 leave` | Start, finish or leave in room 2 |
| `3 share sword true 2` | Share `sword = true` with room 2. Rooms: empty or `all`, `3`, or `2,3` |
| `2 connect`, `2 disconnect`, `2 drop` | Connect, disconnect, or close the socket (the client must reconnect) |
| `connect`, `disconnect` | Same for all rooms |
| `state`, `leaderboard` | Read `GET /state` or `GET /leaderboard` |

The buttons on each computer and the console commands run the same code.

## Swap a computer

1. Make a scene whose root script has `extends RoomGame` (see `room_game.gd`).
2. Change one line in `rooms.gd`: `3: "res://games/my_game.tscn"`.

`RoomGame` gives your scene `client` and `room`. Use `_on_attach()` to connect
to client signals, and `run_action()` for client calls (it also logs them).
`games/default_game.gd` is a full example.
