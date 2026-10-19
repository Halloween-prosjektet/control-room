# Control Room Client

Med denne Godot-tillegget kan spillet ditt snakke med kontrollrommet:
registrere spilleren, si fra når spillet starter og slutter, og sende
beskjeder til de andre rommene. Krever Godot 4.

## 1. Legg til tillegget

1. Last ned prosjektet som ZIP fra GitHub og pakk det ut.
2. Kopier mappen `godot/addons/control_room_client` inn i `addons`-mappen i
   Godot-prosjektet ditt. Lag `addons` hvis den ikke finnes.

Det er alt. Du trenger ikke slå på noe under *Project Settings → Plugins*.

Bruker du git? Da kan du heller kjøre dette i prosjektmappen, så får du
oppdateringer enkelt:

```sh
git submodule add -b addon https://github.com/halloween-prosjektet/control-room.git addons/control_room_client
```

## 2. Koble til

Lag et nytt skript på en `Node` i scenen din, og lim inn dette:

```gdscript
extends Node

var client: ControlRoomClient


func _ready() -> void:
	# Adressen får du av kontrollrom-gruppen. Rom nummer er 1 til 5.
	client = ControlRoomClient.new("ws://ADRESSE:PORT", 1)
	add_child(client)
	client.run()
```

Bytt ut `ADRESSE:PORT` med serveradressen, og `1` med rommet ditt.
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
