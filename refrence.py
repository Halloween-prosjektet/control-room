import asyncio
import json
from collections import deque
from datetime import datetime, timezone

import websockets as ws


SEEN_MAX = 200  # Antall meldings-id-er klienten husker (for å kjenne igjen kopier)


def has_id(data):
    msg_id = data.get("id")
    return isinstance(msg_id, (int, float)) and not isinstance(msg_id, bool)


def ok_with_id(event, data):
    # Svaret på player_incoming / player_left / game_finish_ok. Hvis meldingen har
    # "id", sendes den samme "id" tilbake, slik at serveren bare fjerner akkurat den
    # meldingen.
    payload = {"event": event}
    if has_id(data):
        payload["id"] = int(data["id"])
    return payload


class Client:
    def __init__(self) -> None:
        self.uri = "0.0.0.0:443"  # Eksempel uri
        self.pi_id = 1  # Gruppen din sitt rom nummer. 1-5
        self.websocket: ws.ClientConnection | None = None

        self.current_player = {}  # Informasjon om nåværende spiller, brukervavn osv

        self.is_waiting_for_next_pi = False
        self.is_authenticated = False

        self.send_queue = deque()  # hendelser som ikke er sendt ennå
        self.unacked = deque()  # sendt, men serveren har ikke svart med "ack" ennå

        self._next_seq = 1
        # Meldinger fra serveren som klienten allerede har handlet på
        # ("hendelse:id:brukernavn"). Serveren sender en melding på nytt til den får
        # svar, så samme melding kan komme flere ganger.
        self._seen = deque(maxlen=SEEN_MAX)
        self._send_lock = asyncio.Lock()  # holder rekkefølgen når flere tasks sender

    def _get_timestamp(self):
        # Alltid UTC med +00:00 (mikrosekunder beholdes)
        time_now = datetime.now(timezone.utc)
        time_now_iso = time_now.isoformat()
        return time_now_iso

    async def _send_raw(self, payload) -> bool:
        if self.websocket is None:
            return False
        try:
            await self.websocket.send(json.dumps(payload))
        except ws.WebSocketException:
            return False
        return True

    async def send_event(self, payload):
        # Hver hendelse får et løpenummer. Serveren svarer med "ack" og ignorerer
        # løpenumre den har sett før, så hendelser kan sendes på nytt uten risiko.
        async with self._send_lock:
            payload["seq"] = self._next_seq
            self._next_seq += 1
            # Hendelser sendes kun når vi er autentisert og køen er tom. Da beholdes
            # rekkefølgen, og ingenting sendes før auth_ok.
            if (
                self.is_authenticated
                and not self.send_queue
                and await self._send_raw(payload)
            ):
                self.unacked.append(payload)
                return
            self.send_queue.append(payload)

    async def _flush_queue(self):
        # Send køen i rekkefølge. Stopp ved første feil, så rekkefølgen beholdes.
        async with self._send_lock:
            while self.send_queue:
                if not await self._send_raw(self.send_queue[0]):
                    break
                self.unacked.append(self.send_queue.popleft())

    def _handle_ack(self, n: int):
        # "ack" bekrefter alle hendelser med seq <= n
        self.unacked = deque(e for e in self.unacked if e["seq"] > n)
        self.send_queue = deque(e for e in self.send_queue if e["seq"] > n)

    async def authenticate(self):
        if not self.websocket:
            raise RuntimeError("websocket needs to be connected before authenticating.")

        for attempt in range(1, 4):
            # auth går rett ut (aldri i køen), og feil ignoreres
            # "features": klienten svarer game_finish_ack på game_finish_ok
            await self._send_raw(
                {"event": "auth", "pi": self.pi_id, "features": ["game_finish_ack"]}
            )
            try:
                message = await asyncio.wait_for(self.websocket.recv(), 5)

                data = json.loads(message)

                if data.get("event", None) == "auth_ok":
                    self.is_authenticated = True
                    return
            except (asyncio.TimeoutError, json.JSONDecodeError, ws.WebSocketException):
                pass

        raise RuntimeError(
            "Could not authenticate with controll server after 3 attempts."
        )

    async def register_player(self, username: str):
        self.current_player["username"] = username
        await self.send_event(
            {
                "event": "player_register",
                "username": username,
                "timestamp": self._get_timestamp(),
            }
        )

    def _current_username(self) -> str:
        username = self.current_player.get("username")
        return username.strip() if isinstance(username, str) else ""

    def _with_username(self, payload):
        # Legger til brukernavnet til nåværende spiller (hvis kjent), slik at
        # serveren kan sjekke at hendelsen gjelder riktig spiller.
        username = self._current_username()
        if username:
            payload["username"] = username
        return payload

    def _first_copy(self, data) -> bool:
        # Sann første gang en melding med denne id-en kommer. En melding uten id er
        # alltid ny.
        if not has_id(data):
            return True
        key = f"{data.get('event', '')}:{int(data['id'])}:{data.get('username', '')}"
        if key in self._seen:
            return False
        self._seen.append(key)
        return True

    async def leave_player(self):
        await self.send_event(
            self._with_username(
                {
                    "event": "player_leave",
                }
            )
        )
        self.current_player = {}

    async def start_game(self):
        await self.send_event(
            self._with_username(
                {
                    "event": "game_start",
                    "timestamp": self._get_timestamp(),
                }
            )
        )

    async def finish_game(self):
        await self.send_event(
            self._with_username(
                {
                    "event": "game_finish",
                    "timestamp": self._get_timestamp(),
                }
            )
        )

    async def share(self, key, value, pi: int | list[int] | None = None):
        await self.send_event(
            self._with_username(
                {
                    "event": "share",
                    "key": key,
                    "value": value,
                    "pi": pi,
                    "timestamp": self._get_timestamp(),
                }
            )
        )

    # Hooks: overstyr i en subklasse (tilsvarer signalene i Godot-klienten)
    def on_game_finish_wait(self, max_wait):
        pass

    def on_game_finish_ok(self):
        pass

    def on_player_incoming(self, username, player_data):
        pass

    def on_player_left(self, username):
        pass

    def on_server_error(self, code, message, event):
        pass

    async def event_handler(self, data):
        match data.get("event", None):
            case None:
                pass
            case "ack":
                self._handle_ack(int(data.get("seq", 0)))
            case (
                "player_register_ok"
                | "register_player_ok"
                | "player_leave_ok"
                | "game_start_ok"
            ):
                pass
            case "game_finish_wait":
                self.is_waiting_for_next_pi = True
                self.on_game_finish_wait(data.get("max_wait", ""))
            case "game_finish_ok":
                # Svar med id, så serveren slutter å sende meldingen på nytt
                if has_id(data):
                    await self.send_event(ok_with_id("game_finish_ack", data))
                # Ignorer en kopi, og en melding om en annen spiller enn den som vises
                if not self._first_copy(data):
                    return
                finished_user = data.get("username")
                current = self._current_username()
                if (
                    isinstance(finished_user, str)
                    and current
                    and finished_user.strip() != current
                ):
                    return
                self.is_waiting_for_next_pi = False
                self.on_game_finish_ok()
            case "error":
                code = data.get("code", "")
                message = data.get("message", "")
                print(f"server error {code}: {message}")
                # "event" er alltid "error"; hendelsen som feilet ligger i "event_name"
                self.on_server_error(code, message, data.get("event_name", ""))
            case "player_left":
                await self.send_event(ok_with_id("player_left_ok", data))
                # Ignorer en kopi, og player_left for en annen spiller enn den som vises
                if not self._first_copy(data):
                    return
                left_user = str(data.get("username", "")).strip()
                if not left_user or left_user != self._current_username():
                    return
                self.current_player = {}
                self.on_player_left(data.get("username", ""))
            case "player_incoming":
                await self.send_event(ok_with_id("player_incoming_ok", data))
                # Ignorer en kopi av en melding som allerede er tatt imot
                if not self._first_copy(data):
                    return
                self.current_player["username"] = data.get("username")
                self.current_player["data"] = data.get("player_data", None)
                self.on_player_incoming(
                    data.get("username", ""), data.get("player_data", None)
                )

    async def run(self) -> None:
        retry_amount = 0
        retry_delay = 5
        while True:
            try:
                async with ws.connect(self.uri) as websocket:
                    self.websocket = websocket

                    await self.authenticate()

                    retry_amount = 0
                    retry_delay = 5

                    # Hendelser uten ack kan ha gått tapt med forbindelsen:
                    # send dem først på nytt, foran køen.
                    async with self._send_lock:
                        self.send_queue = self.unacked + self.send_queue
                        self.unacked = deque()
                    await self._flush_queue()

                    async for message in self.websocket:
                        await self._flush_queue()  # som _flush_queue() i hver _process
                        try:
                            data = json.loads(message)
                            await self.event_handler(data)
                        except json.JSONDecodeError as e:
                            print(f"server sent non valid json package {e}")
            except (ws.WebSocketException, OSError, RuntimeError) as e:
                print(f"server connection lost \n{e}")

            self.is_authenticated = False
            self.websocket = None
            if retry_amount >= 10:
                raise RuntimeError(
                    "Connection couldn't be established with control room."
                )
            retry_amount += 1
            retry_delay = retry_amount**2 if retry_amount > 2 else retry_delay
            await asyncio.sleep(retry_delay)


async def simulate_game(client: Client):
    while not client.is_authenticated:
        await asyncio.sleep(0.5)

    # Later som at jeg er pi 1
    await client.register_player("John Doe")
    await asyncio.sleep(3)

    await client.start_game()
    await asyncio.sleep(8)

    await client.share("sword", True, 2)
    await client.share("key_1", True)

    await client.finish_game()
    await asyncio.sleep(5)


async def main():
    client = Client()
    await asyncio.gather(client.run(), simulate_game(client))


if __name__ == "__main__":
    asyncio.run(main())
