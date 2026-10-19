import { describe, expect, test } from "bun:test";
import { createHttpHandler } from "../src/http.ts";
import type { LeaderboardRow, Queries } from "../src/queries-interface.ts";

// The example row from plan section 10.
const PLAN_EXAMPLE: LeaderboardRow = {
  rank: 1,
  player_id: "fa0aa55e-defd-4a91-b11d-a1e409973a6e",
  username: "John Doe",
  total_time_ms: 21100,
  room_times_ms: {
    room_1: 4500,
    room_2: 4800,
    room_3: 4200,
    room_4: 3100,
    room_5: 4500,
  },
  completed_at: "2026-10-31T19:56:21.624+01:00",
};

function makeRows(n: number): LeaderboardRow[] {
  const rows: LeaderboardRow[] = [PLAN_EXAMPLE];
  for (let i = 2; i <= n; i++) {
    rows.push({
      ...PLAN_EXAMPLE,
      rank: i,
      player_id: `p-${i}`,
      username: `Player ${i}`,
      total_time_ms: PLAN_EXAMPLE.total_time_ms + i,
    });
  }
  return rows;
}

interface FakeQueries extends Queries {
  calls: { limit: number; offset: number }[];
}

function fakeQueries(rows: LeaderboardRow[] = makeRows(3), fail = false): FakeQueries {
  const calls: { limit: number; offset: number }[] = [];
  return {
    calls,
    leaderboard(limit, offset) {
      if (fail) throw new Error("db down");
      calls.push({ limit, offset });
      return rows.slice(offset, offset + limit);
    },
    leaderboardOne(playerId) {
      return rows.find((r) => r.player_id === playerId) ?? null;
    },
    state() {
      return { rooms: [{ room: 1, state: "empty" }], connected: [1, 3], outbox_size: 2 };
    },
  };
}

const BASE = "http://localhost:7321";

function call(q: Queries, path: string, init?: RequestInit): Response {
  const res = createHttpHandler(q)(new Request(BASE + path, init));
  if (res === undefined) throw new Error(`handler returned undefined for ${path}`);
  return res;
}

function expectJsonCors(res: Response): void {
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(res.headers.get("content-type") ?? "").toContain("application/json");
}

describe("GET /health", () => {
  test("gives ok true", async () => {
    const res = call(fakeQueries(), "/health");
    expect(res.status).toBe(200);
    expectJsonCors(res);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("GET /leaderboard", () => {
  test("default limit 50 and offset 0", async () => {
    const q = fakeQueries();
    const res = call(q, "/leaderboard");
    expect(res.status).toBe(200);
    expectJsonCors(res);
    expect(q.calls).toEqual([{ limit: 50, offset: 0 }]);
    const body = (await res.json()) as LeaderboardRow[];
    expect(body).toHaveLength(3);
  });

  test("JSON shape is equal to the plan example", async () => {
    const res = call(fakeQueries([PLAN_EXAMPLE]), "/leaderboard");
    expect(await res.json()).toEqual([
      {
        rank: 1,
        player_id: "fa0aa55e-defd-4a91-b11d-a1e409973a6e",
        username: "John Doe",
        total_time_ms: 21100,
        room_times_ms: { room_1: 4500, room_2: 4800, room_3: 4200, room_4: 3100, room_5: 4500 },
        completed_at: "2026-10-31T19:56:21.624+01:00",
      },
    ]);
  });

  test("passes limit and offset", async () => {
    const q = fakeQueries(makeRows(10));
    const res = call(q, "/leaderboard?limit=3&offset=4");
    expect(res.status).toBe(200);
    expect(q.calls).toEqual([{ limit: 3, offset: 4 }]);
    const body = (await res.json()) as LeaderboardRow[];
    expect(body.map((r) => r.rank)).toEqual([5, 6, 7]);
  });

  test("accepts the limits 1 and 500", () => {
    const q = fakeQueries();
    expect(call(q, "/leaderboard?limit=1").status).toBe(200);
    expect(call(q, "/leaderboard?limit=500").status).toBe(200);
    expect(call(q, "/leaderboard?offset=0").status).toBe(200);
    expect(q.calls).toEqual([
      { limit: 1, offset: 0 },
      { limit: 500, offset: 0 },
      { limit: 50, offset: 0 },
    ]);
  });

  test("accepts a trailing slash", () => {
    expect(call(fakeQueries(), "/leaderboard/").status).toBe(200);
  });

  const badLimits = ["0", "501", "-1", "abc", "1.5", "", "1e2", " 5", "0x10", "99999999999999999"];
  for (const bad of badLimits) {
    test(`400 for limit=${JSON.stringify(bad)}`, async () => {
      const q = fakeQueries();
      const res = call(q, `/leaderboard?limit=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expectJsonCors(res);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("bad_request");
      expect(body.message).toContain("limit");
      expect(q.calls).toEqual([]);
    });
  }

  for (const bad of ["-1", "abc", "2.5", "", "1e3", "99999999999999999"]) {
    test(`400 for offset=${JSON.stringify(bad)}`, async () => {
      const q = fakeQueries();
      const res = call(q, `/leaderboard?offset=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.message).toContain("offset");
      expect(q.calls).toEqual([]);
    });
  }

  test("500 JSON when the query throws", async () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const res = call(fakeQueries(makeRows(1), true), "/leaderboard");
      expect(res.status).toBe(500);
      expectJsonCors(res);
      expect(((await res.json()) as { error: string }).error).toBe("internal_error");
    } finally {
      console.error = orig;
    }
  });
});

describe("GET /leaderboard/:player_id", () => {
  test("gives one row with its rank", async () => {
    const res = call(fakeQueries(), "/leaderboard/p-2");
    expect(res.status).toBe(200);
    expectJsonCors(res);
    const body = (await res.json()) as LeaderboardRow;
    expect(body.rank).toBe(2);
    expect(body.player_id).toBe("p-2");
  });

  test("row is equal to the plan example", async () => {
    const res = call(fakeQueries(), `/leaderboard/${PLAN_EXAMPLE.player_id}`);
    expect(await res.json()).toEqual(PLAN_EXAMPLE);
  });

  test("decodes the player_id", async () => {
    const row = { ...PLAN_EXAMPLE, player_id: "a b" };
    const res = call(fakeQueries([row]), "/leaderboard/a%20b");
    expect(res.status).toBe(200);
  });

  test("404 JSON when missing or not completed", async () => {
    const res = call(fakeQueries(), "/leaderboard/unknown-id");
    expect(res.status).toBe(404);
    expectJsonCors(res);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  test("400 for a bad escape", () => {
    expect(call(fakeQueries(), "/leaderboard/%E0%A4%A").status).toBe(400);
  });

  test("404 for a deeper path", () => {
    expect(call(fakeQueries(), "/leaderboard/p-2/extra").status).toBe(404);
  });
});

describe("GET /state", () => {
  test("gives the value of queries.state()", async () => {
    const res = call(fakeQueries(), "/state");
    expect(res.status).toBe(200);
    expectJsonCors(res);
    expect(await res.json()).toEqual({
      rooms: [{ room: 1, state: "empty" }],
      connected: [1, 3],
      outbox_size: 2,
    });
  });
});

describe("routing", () => {
  test("returns undefined for / (WebSocket upgrade path)", () => {
    const handler = createHttpHandler(fakeQueries());
    expect(handler(new Request(`${BASE}/`))).toBeUndefined();
    expect(handler(new Request(`${BASE}/?x=1`))).toBeUndefined();
  });

  test("404 JSON for an unknown path", async () => {
    for (const path of ["/nope", "/healthz", "/state/1", "/leaderboards"]) {
      const res = call(fakeQueries(), path);
      expect(res.status).toBe(404);
      expectJsonCors(res);
      expect(((await res.json()) as { error: string }).error).toBe("not_found");
    }
  });

  test("405 JSON for a method that is not GET", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      for (const path of ["/health", "/leaderboard", "/leaderboard/p-2", "/state"]) {
        const res = call(fakeQueries(), path, { method });
        expect(res.status).toBe(405);
        expectJsonCors(res);
        expect(res.headers.get("allow")).toBe("GET, OPTIONS");
        expect(((await res.json()) as { error: string }).error).toBe("method_not_allowed");
      }
    }
  });

  test("OPTIONS preflight gives 204 with CORS headers", async () => {
    for (const path of ["/health", "/leaderboard", "/leaderboard/p-2", "/state"]) {
      const res = call(fakeQueries(), path, {
        method: "OPTIONS",
        headers: {
          Origin: "http://example.test",
          "Access-Control-Request-Method": "GET",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("GET");
      expect(await res.text()).toBe("");
    }
  });
});
