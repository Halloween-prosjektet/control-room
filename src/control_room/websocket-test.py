import asyncio

import json
import websockets

URI = "wss://example.com/ws"  # Bytt ut med faktisk endpoint


async def connect_and_listen():
    # Koble til websocket serveren
    async with websockets.connect(URI) as websocket:
        
        # Identifiserer meg når koblingen er klar
        auth_payload = { 
            "pi": 0, 
        }
        await websocket.send(json.dumps(auth_payload))

        # 
        try:
            async for message in websocket:
                data = json.loads(message)
                
                # Din logikk for å håndtere inkommende traffik fra serveren

        except websockets.exceptions.ConnectionClosed as e:
            print("Connection closed")


if __name__ == "__main__":
    asyncio.run(connect_and_listen())