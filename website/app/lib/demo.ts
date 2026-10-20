// Example data, shown when the control room server does not answer.
// The same seed gives the same list each time, so the page does not jump.

import { ROOMS, type ControlRoomState, type LeaderboardRow } from "./types";

const NAMES = [
  "Ingrid",
  "Mathias",
  "Sara & Emil",
  "Noah",
  "Thea",
  "Jakob",
  "Maja",
  "Filip",
  "Aksel",
  "Nora",
  "Ida",
  "William",
  "Olivia",
  "Lucas",
  "Emma",
  "Oskar",
  "Frida",
  "Henrik",
  "Selma",
  "Isak",
  "Vilde",
  "Sander",
  "Live",
  "Magnus",
  "Tiril",
  "Kasper",
  "Hedda",
  "Tobias",
  "Astrid",
  "Elias",
];

function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function demoBoard(now: number): { rows: LeaderboardRow[]; state: ControlRoomState } {
  const rnd = rng(31);
  const rows: LeaderboardRow[] = NAMES.map((username, i) => {
    let total = 0;
    const times = {} as LeaderboardRow["room_times_ms"];
    for (const n of ROOMS) {
      const ms = Math.round((38 + rnd() * 110) * 1000 + rnd() * 999);
      times[`room_${n}`] = ms;
      total += ms;
    }
    return {
      rank: 0,
      player_id: `demo-${i}`,
      username,
      total_time_ms: total,
      room_times_ms: times,
      completed_at: "",
    };
  });
  rows.sort((a, b) => a.total_time_ms - b.total_time_ms);
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    r.rank = prev && prev.total_time_ms === r.total_time_ms ? prev.rank : i + 1;
  });

  // The timers run from a start that moves with the clock, in a 5 minute cycle.
  const cycle = (now / 1000) % 300;
  const ago = (s: number) => new Date(now - ((s + cycle) % 300) * 1000).toISOString();
  const state: ControlRoomState = {
    rooms: [
      { room: 1, state: "playing", username: "Sofie", started_at: ago(34), finished_at: null },
      { room: 2, state: "incoming", username: "Adrian", started_at: null, finished_at: null },
      {
        room: 3,
        state: "waiting",
        username: "Jonas",
        started_at: new Date(now - 140_000).toISOString(),
        finished_at: new Date(now - 12_000).toISOString(),
      },
      { room: 4, state: "empty", username: null, started_at: null, finished_at: null },
      {
        room: 5,
        state: "playing",
        username: "Marte & Leah",
        started_at: ago(83),
        finished_at: null,
      },
    ],
    connected_pis: [1, 2, 3, 5],
  };
  return { rows, state };
}
