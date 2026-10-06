import asyncio
from datetime import datetime, timezone
from re import A
from typing_extensions import Any
import websockets as ws
import json

async def main() -> None:
    uri = "0.0.0.0:443"

    

class Client():
    def __init__(self) -> None:
        self.uri = "0.0.0.0:443" # Eksempel uri
        self.pi_id = 1 # Gruppen din sitt rom nummer. 1-5
        self.websocket: ws.ClientConnection | None = None

        self.current_player: dict[str, Any] | None = None # Informasjon om nåværende spiller, brukervavn osv
        self.is_waiting_for_next_pi = False 
        self.is_authenticated = False

    def _get_time_stamp(self):
        return datetime.utcnow().isoformat()

    def send_event(self, payload):
        if self.websocket and not self.websocket.connect
    async def run(self) -> None:
        while True:
            try:
                async with ws.connect(self.uri) as websocket:

                    self.websocket = websocket

                    self.send_event({
                        "event": "auth",
                        "pi": self.pi_id
                    })
                    async for message in websocket:
                        try:
                            data = json.loads(message)
    
    
                        except json.JSONDecodeError:
                            # Handle invalid server packet
                            pass
    
            except (ws.ConnectionClosed, OSError):
                de
                await asyncio.sleep(2)
        

if __name__ == "__main__":
    main()
