# Control Room Client

Godot 4.x-addon for kontrollrommet.

## Installasjon

Kjør i prosjektets rotmappe (git-repo):

```sh
git submodule add -b addon https://github.com/halloween-prosjektet/control-room.git addons/control_room_client
```

## Metoder

| Medlem | Beskrivelse |
| --- | --- |
| `ControlRoomClient.new(uri, pi_id)` | Oppretter klienten. `uri` er server-adressen, `pi_id` er rom nummer (1-5) |
| `run()` | Kobler til (kobler til på nytt automatisk) |
| `register_player(username)` / `leave_player()` | Spiller inn / ut |
| `start_game()` / `finish_game()` | Spillstatus |
| `share(key, value, pi = null)` | Deler en verdi. `pi` er `null` (alle), en int eller en Array med ints |
| `send_event(payload)` | Sender en vilkårlig hendelse |
| `event_handler(data)` | Håndterer innkommende hendelser; overstyr ved behov |
| signal `authenticated` | Klar til bruk (også etter reconnect) |
| signal `gave_up` | Klarte ikke å koble til |

Se `godot/example/` for et fullt eksempel.
