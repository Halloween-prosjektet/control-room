// HTTP endpoints (plan section 10).
//
// createHttpHandler(queries) returns a function for Bun.serve's fetch. The
// function returns undefined for the path "/", because the WebSocket upgrade
// uses that path and index.ts handles it. For all other paths, the function
// returns a Response:
//
// - GET /leaderboard?limit=&offset=  -> rows (limit 1..500, default 50; offset >= 0, default 0)
// - GET /leaderboard/:player_id      -> one row, or 404 when the run is missing or not completed
// - GET /state                       -> the operator state from queries.state()
// - GET /health                      -> {"ok":true}
// - OPTIONS on a known path          -> 204 (CORS preflight)
// - other method on a known path     -> 405
// - unknown path                     -> 404
//
// All responses are JSON (except the 204) and have Access-Control-Allow-Origin: *.

import type { Queries } from "./queries-interface.ts";

export const LEADERBOARD_DEFAULT_LIMIT = 50;
export const LEADERBOARD_MAX_LIMIT = 500;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...CORS_HEADERS, ...extra } });
}

function errorResponse(
  status: number,
  error: string,
  message: string,
  extra: Record<string, string> = {},
): Response {
  return json({ error, message }, status, extra);
}

/** Parses a non-negative decimal integer. Returns undefined when the text is not valid. */
function parseNonNegativeInt(text: string): number | undefined {
  if (!/^[0-9]{1,15}$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
}

type Route =
  | { kind: "leaderboard" }
  | { kind: "leaderboard_one"; playerId: string }
  | { kind: "state" }
  | { kind: "health" };

/** Finds the route for a path. Returns null for an unknown path, "bad" for a bad escape. */
function matchRoute(path: string): Route | null | "bad" {
  if (path === "/leaderboard" || path === "/leaderboard/") return { kind: "leaderboard" };
  if (path === "/state") return { kind: "state" };
  if (path === "/health") return { kind: "health" };
  const m = /^\/leaderboard\/([^/]+)\/?$/.exec(path);
  if (m?.[1] !== undefined) {
    try {
      return { kind: "leaderboard_one", playerId: decodeURIComponent(m[1]) };
    } catch {
      return "bad";
    }
  }
  return null;
}

export function createHttpHandler(queries: Queries): (req: Request) => Response | undefined {
  return (req: Request): Response | undefined => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/") return undefined;

    const route = matchRoute(path);
    if (route === null) return errorResponse(404, "not_found", `no endpoint at ${path}`);
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (req.method !== "GET") {
      return errorResponse(405, "method_not_allowed", `method ${req.method} is not allowed`, {
        Allow: "GET, OPTIONS",
      });
    }
    if (route === "bad") return errorResponse(400, "bad_request", "player_id is not valid");

    try {
      switch (route.kind) {
        case "health":
          return json({ ok: true });
        case "state":
          return json(queries.state());
        case "leaderboard_one": {
          const row = queries.leaderboardOne(route.playerId);
          if (row === null) {
            return errorResponse(404, "not_found", "no completed run with this player_id");
          }
          return json(row);
        }
        case "leaderboard": {
          let limit = LEADERBOARD_DEFAULT_LIMIT;
          let offset = 0;
          const rawLimit = url.searchParams.get("limit");
          const rawOffset = url.searchParams.get("offset");
          if (rawLimit !== null) {
            const n = parseNonNegativeInt(rawLimit);
            if (n === undefined || n < 1 || n > LEADERBOARD_MAX_LIMIT) {
              return errorResponse(
                400,
                "bad_request",
                `limit must be an integer from 1 to ${LEADERBOARD_MAX_LIMIT}`,
              );
            }
            limit = n;
          }
          if (rawOffset !== null) {
            const n = parseNonNegativeInt(rawOffset);
            if (n === undefined) {
              return errorResponse(400, "bad_request", "offset must be an integer of 0 or more");
            }
            offset = n;
          }
          return json(queries.leaderboard(limit, offset));
        }
      }
    } catch (err) {
      console.error("http: query failed", err);
      return errorResponse(500, "internal_error", "the server could not read the data");
    }
  };
}
