// Reads the leaderboard and the room state from the control room server.
// Server only: the browser never talks to the control room server directly.

import { demoBoard } from "./demo";
import type { Board, ControlRoomState, LeaderboardRow } from "./types";

/** Address of the control room server. Set CONTROL_ROOM_URL to change it. */
const CONTROL_ROOM_URL = (process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:7321").replace(
  /\/$/,
  "",
);
export const LEADERBOARD_LIMIT = 200;
const TIMEOUT_MS = 1500;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(CONTROL_ROOM_URL + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Live data, or example data with mode "offline" when the server does not answer. */
export async function loadBoard(): Promise<Board> {
  const now = Date.now();
  try {
    const [rows, state] = await Promise.all([
      getJson<LeaderboardRow[]>(`/leaderboard?limit=${LEADERBOARD_LIMIT}`),
      getJson<ControlRoomState>("/state"),
    ]);
    return { mode: "live", rows, state, serverNow: now };
  } catch {
    return { ...demoBoard(now), mode: "offline", serverNow: now };
  }
}
