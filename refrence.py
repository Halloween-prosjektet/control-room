import asyncio
import json
from collections import deque
from datetime import datetime, timedelta, timezone

import websockets as ws


class Client:
    def __init__(self) -> None:
        self.uri = "0.0.0.0:443"  # Eksempel uri
        self.pi_id = 1  # Gruppen din sitt rom nummer. 1-5
        self.websocket: ws.ClientConnection | None = None

        self.current_player = {}  # Informasjon om nåværende spiller, brukervavn osv

        self.is_waiting_for_next_pi = False
        self.is_authenticated = False

        self.send_queue = deque()

    def _get_timestamp(self):
        tz = timezone(timedelta(hours=2), name="UTC+2")
        time_now = datetime.now(tz)
        time_now_iso = time_now.isoformat()
        return time_now_iso

    async def send_event(self, payload):
        if self.websocket:
            try:
                await self.websocket.send(json.dumps(payload))
            except ws.WebSocketException:
                self.send_queue.append(payload)
        else:
            self.send_queue.append(payload)

    async def authenticate(self):
        if not self.websocket:
            raise RuntimeError("websocket needs to be connected before authenticating.")

        for attempt in range(1, 4):
            await self.send_event({"event": "auth", "pi": self.pi_id})
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
                "event": "register",
                "username": username,
                "timestamp": self._get_timestamp(),
            }
        )

    async def leave_player(self):
        await self.send_event(
            {
                "event": "player_leave",
            }
        )
        self.current_player = {}

    async def start_game(self):
        await self.send_event(
            {
                "event": "game_start",
                "timestamp": self._get_timestamp(),
            }
        )

    async def finish_game(self):
        await self.send_event(
            {
                "event": "game_finish",
                "timestamp": self._get_timestamp(),
            }
        )

    async def share(self, key, value, pi: int | list[int] | None = None):
        await self.send_event(
            {
                "event": "share",
                "key": key,
                "value": value,
                "pi": pi,
                "timestamp": self._get_timestamp(),
            }
        )

    async def event_handler(self, data):
        match data.get("event", None):
            case None:
                pass
            case (
                "register_player_ok"
                | "player_leave_ok"
                | "game_start_ok"
                | "game_finish_ok"
            ):
                pass
            case "player_left":
                self.current_player = {}
                await self.send_event(
                    {
                        "event": "player_left_ok",
                    }
                )
            case "player_incoming":
                self.current_player["username"] = data.get("username")
                self.current_player["data"] = data.get("player_data", None)
                await self.send_event(
                    {
                        "event": "player_incoming_ok",
                    }
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

                    if len(self.send_queue) > 0:
                        for _ in range(len(self.send_queue)):
                            await self.send_event(self.send_queue.popleft())

                    async for message in self.websocket:
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
