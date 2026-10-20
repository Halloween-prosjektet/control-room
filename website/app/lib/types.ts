// The shapes of the control room server's HTTP answers
// (backend/src/queries-interface.ts and stateSnapshot in backend/src/db.ts).

export const ROOMS = [1, 2, 3, 4, 5] as const;
export type RoomNumber = (typeof ROOMS)[number];

export interface LeaderboardRow {
  rank: number;
  player_id: string;
  username: string;
  total_time_ms: number;
  room_times_ms: Record<`room_${RoomNumber}`, number>;
  completed_at: string;
}

export type SlotState = "empty" | "incoming" | "playing" | "waiting";

export interface RoomSlot {
  room: number;
  state: SlotState;
  player_id?: string | null;
  username: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface ControlRoomState {
  rooms: RoomSlot[];
  connected_pis: number[];
}

/**
 * What the page shows.
 * - "live": data from the control room server.
 * - "offline": the server did not answer; `rows` and `state` are example data.
 */
export interface Board {
  mode: "live" | "offline";
  rows: LeaderboardRow[];
  state: ControlRoomState;
  /** Clock of the web server when it made this answer (epoch ms). */
  serverNow: number;
}
