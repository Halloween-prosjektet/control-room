// Read-only queries that the HTTP layer (http.ts) uses. db.ts implements them.

/** One leaderboard row (plan section 10, format from issue 1). */
export interface LeaderboardRow {
  /** Competition rank: equal totals share a rank, and the next rank skips. Starts at 1. */
  rank: number;
  player_id: string;
  username: string;
  total_time_ms: number;
  room_times_ms: {
    room_1: number;
    room_2: number;
    room_3: number;
    room_4: number;
    room_5: number;
  };
  /** ISO 8601 in config.tzName with the correct offset, e.g. 2026-10-31T19:56:21.624+01:00. */
  completed_at: string;
}

export interface Queries {
  /** Completed runs, order total_time_ms ascending, then completed_at ascending. */
  leaderboard(limit: number, offset: number): LeaderboardRow[];
  /** One completed run with its rank, or null if the run is unknown or not completed. */
  leaderboardOne(playerId: string): LeaderboardRow | null;
  /** Operator snapshot for GET /state: room slots, connected Pis, outbox size. */
  state(): unknown;
}
