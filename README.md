# Control Room Client

Godot 4-tillegg som kobler spillet ditt til kontrollrommet.

**Kom i gang:** se [godot/addons/control_room_client/README.md](godot/addons/control_room_client/README.md).
Der står installasjon, kode du kan kopiere, og hva du skal kalle når.

Kort fortalt:

```gdscript
client = ControlRoomClient.new("ws://ADRESSE:PORT", 1)  # 1 = rom nummer (1-5)
add_child(client)
client.run()

client.register_player("Navn")  # kun rom 1
client.start_game()
client.finish_game()
```

Et fullt eksempel ligger i `godot/example/`.

For utviklere av serveren og beviset for at klienten virker: se
`verification/README.md`.
