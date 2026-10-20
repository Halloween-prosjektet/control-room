# Control Room Client

Med denne Godot-tillegget kan spillet ditt snakke med kontrollrommet:
registrere spilleren, si fra når spillet starter og slutter, og sende
beskjeder til de andre rommene. Krever Godot 4.

> **Viktig:** Pi-en må være koblet til WiFi-et **BakkaIM**. Ellers kommer den
> ikke fram til serveren.
>
> WebSocket-adressen (ws-url) er: `ws://172.31.0.200:7321`

## 1. Legg til tillegget

Alle grupper bruker git. Åpne en terminal i mappen til Godot-prosjektet ditt
(der `project.godot` ligger) og kjør:

```sh
git submodule add -b addon https://github.com/halloween-prosjektet/control-room.git addons/control_room_client
```

Oppdater senere med:

```sh
git submodule update --remote addons/control_room_client
```

### Last opp endringene

Kjør dette i prosjektmappen for å få tillegget inn i repoet deres på GitHub:

```sh
git add .
git commit -m "Legg til control room client"
git push
```

Når andre på gruppen henter prosjektet, må de kjøre
`git submodule update --init` én gang for å få med tillegget.

## 2. Koble til

Lag et nytt skript på en `Node` i scenen din, og lim inn dette:

```gdscript
extends Node

var client: ControlRoomClient


func _ready() -> void:
	# Rom nummer er 1 til 5.
	client = ControlRoomClient.new("ws://172.31.0.200:7321", 1)
	add_child(client)
	client.run()
```

Bytt ut `1` med rommet ditt.
Klienten kobler til selv, og kobler til på nytt hvis nettet faller ut.

## 3. Si fra til kontrollrommet

Bruk disse i spillet ditt når det skjer:

| Når | Skriv |
| --- | --- |
| Spilleren skriver inn navn (kun rom 1) | `client.register_player("Navn")` |
| Spilleren starter spillet ditt | `client.start_game()` |
| Spilleren er ferdig i rommet ditt | `client.finish_game()` |
| Spilleren gir opp og går | `client.leave_player()` |
| Spilleren har funnet noe andre rom trenger | `client.share("nøkkel", true, 3)` |

Ved `share` er siste tall rommet som skal få beskjeden. Utelat det for å
sende til alle rom, eller bruk en liste, for eksempel `[2, 3]`.

Du kan kalle alt dette med en gang. Er nettet nede, venter klienten og sender
det senere.

## 4. Ta imot beskjeder

Koble til disse signalene (etter `add_child`, før `client.run()`):

| Signal | Betyr |
| --- | --- |
| `player_incoming(username, player_data)` | En spiller er på vei til rommet ditt. `player_data` er det forrige rom delte |
| `player_left(username)` | Spilleren gikk, og kommer ikke likevel |
| `game_finish_wait(max_wait)` | Neste rom er opptatt. Be spilleren vente |
| `game_finish_ok` | Spilleren kan gå videre til neste rom |
| `server_error(code, message, event)` | Serveren avviste noe. Feilen står også i konsollen |
| `authenticated` | Klar til bruk |
| `gave_up` | Klarte ikke å koble til |

Eksempel:

```gdscript
client.player_incoming.connect(_on_player_incoming)

func _on_player_incoming(username: String, player_data: Variant) -> void:
	print("Velkommen, ", username)
```

## Prøv det

Åpne `godot/example/main.tscn` og kjør scenen. Endre adresse og rom nummer
øverst i `example/main.gd` først.

## Feil?

- Ingenting skjer: sjekk adressen, og at serveren kjører.
- Skriv `ws://` foran adressen (eller `wss://` hvis serveren bruker det).
- Les konsollen i Godot. Klienten skriver hva som er galt.
