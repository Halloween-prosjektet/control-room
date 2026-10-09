# Control Room Client

WebSocket-klient for kontrollrommet. Port av `refrence.py`. Krever Godot 4.x.

## Installasjon

Anbefalt (får oppdateringer via git), kjør i prosjektets rotmappe:

```sh
git submodule add -b addon https://github.com/halloween-prosjektet/control-room.git addons/control_room_client
```

Oppdater senere med `git submodule update --remote addons/control_room_client`.
Se hoved-README-en for detaljer. Du kan også bare kopiere mappen inn i `addons/`.
Aktivering under *Project Settings → Plugins* er valgfritt; klassen er
tilgjengelig uansett.

## Bruk

```gdscript
extends Node

var client: ControlRoomClient

func _ready() -> void:
	# uri, og gruppen din sitt rom nummer (pi_id, 1-5)
	client = ControlRoomClient.new("ws://example.com:443", 1)
	add_child(client)
	client.authenticated.connect(_on_authenticated)
	client.gave_up.connect(_on_gave_up)
	client.run()

func _on_authenticated() -> void:
	client.register_player("John Doe")
	client.start_game()
	client.share("sword", true, 2)   # kun til pi 2
	client.share("key_1", true)      # til alle
	client.finish_game()
```

Hendelser som sendes mens forbindelsen er nede legges i en kø og sendes
etter at klienten har koblet til og autentisert seg på nytt.

## API

| Medlem | Beskrivelse |
| --- | --- |
| `ControlRoomClient.new(uri, pi_id)` | Oppretter klienten. `uri` er server-adressen (`ws://` / `wss://`), `pi_id` er rom nummer |
| `uri`, `pi_id` | Kan også endres etter opprettelse, før `run()` |
| `current_player` | Dictionary med `username` og `data` for nåværende spiller |
| `is_authenticated` | `true` når `auth_ok` er mottatt |
| `run()` | Kobler til; kobler til på nytt automatisk hvis forbindelsen mistes |
| `register_player(username)` / `leave_player()` | Spiller inn / ut |
| `start_game()` / `finish_game()` | Spillstatus |
| `share(key, value, pi = null)` | Deler en verdi. `pi` er `null` (alle), en int eller en Array med ints |
| `send_event(payload)` | Sender en vilkårlig hendelse (køes hvis frakoblet) |
| `event_handler(data)` | Håndterer innkommende hendelser; overstyr/utvid ved behov |
| signal `authenticated` | Utløses etter vellykket autentisering (også etter reconnect) |
| signal `gave_up` | Utløses når 10 forsøk på å koble til på nytt har feilet |

Eksempel på et helt spill: `example/main.tscn` (endre uri og pi id i `example/main.gd`).
