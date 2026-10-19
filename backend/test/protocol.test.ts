import { describe, expect, test } from "bun:test";
import { isJson, isPiId, msg, parseClientMessage, parseClientObject } from "../src/protocol.ts";

const TS = "2026-10-31T19:56:21.624416+02:00";

function ok(text: string) {
  const r = parseClientMessage(text);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.event;
}
function bad(text: string) {
  const r = parseClientMessage(text);
  if (r.ok) throw new Error(`expected error, got ${JSON.stringify(r)}`);
  return r;
}

describe("parse: JSON errors", () => {
  test("not valid JSON gives bad_json", () => {
    expect(bad("{nope")).toMatchObject({ code: "bad_json", eventName: "" });
  });
  test.each(["[]", "1", '"x"', "null", "true"])("%s is not an object: bad_json", (t) => {
    expect(bad(t).code).toBe("bad_json");
  });
  test("unknown event gives unknown_event with its name and seq", () => {
    expect(bad('{"event":"dance","seq":4}')).toMatchObject({
      code: "unknown_event",
      eventName: "dance",
      seq: 4,
    });
  });
  test("missing or non-string event gives bad_request", () => {
    expect(bad("{}").code).toBe("bad_request");
    expect(bad('{"event":5,"seq":2}')).toMatchObject({ code: "bad_request", seq: 2 });
  });
  test("prototype names are not events", () => {
    expect(bad('{"event":"__proto__"}').code).toBe("unknown_event");
    expect(bad('{"event":"toString"}').code).toBe("unknown_event");
  });
});

describe("parse: seq", () => {
  test("seq is optional (old clients)", () => {
    expect(ok('{"event":"game_start"}')).toEqual({ event: "game_start" });
  });
  test("seq is kept", () => {
    expect(ok('{"event":"player_leave","seq":7}')).toEqual({ event: "player_leave", seq: 7 });
  });
  test("seq null is the same as no seq", () => {
    expect(ok('{"event":"player_leave","seq":null}')).toEqual({ event: "player_leave" });
  });
  test.each(["0", "-1", "1.5", '"3"', "true", "9007199254740993"])("seq %s is bad", (s) => {
    const r = bad(`{"event":"game_start","seq":${s}}`);
    expect(r.code).toBe("bad_request");
    expect(r.seq).toBeUndefined();
  });
});

describe("parse: auth", () => {
  test.each([1, 2, 3, 4, 5])("pi %d", (pi) => {
    expect(ok(`{"event":"auth","pi":${pi}}`)).toEqual({ event: "auth", pi });
  });
  test.each(["0", "6", "1.5", '"1"', "null"])("pi %s is bad", (pi) => {
    expect(bad(`{"event":"auth","pi":${pi}}`).code).toBe("bad_request");
  });
  test("auth with session", () => {
    expect(ok(`{"event":"auth","pi":2,"session":"ab12"}`)).toEqual({
      event: "auth",
      pi: 2,
      session: "ab12",
    });
  });
  test.each(['""', "5", "null", '["a"]', JSON.stringify("x".repeat(129))])(
    "session %s is ignored",
    (session) => {
      expect(ok(`{"event":"auth","pi":2,"session":${session}}`)).toEqual({ event: "auth", pi: 2 });
    },
  );
});

describe("parse: player_register", () => {
  test("player_register with timestamp and seq", () => {
    expect(
      ok(JSON.stringify({ event: "player_register", username: "  Ola ", timestamp: TS, seq: 1 })),
    ).toEqual({ event: "player_register", username: "Ola", timestamp: TS, seq: 1 });
  });
  test("alias register", () => {
    expect(ok('{"event":"register","username":"Kari"}')).toEqual({
      event: "player_register",
      username: "Kari",
    });
  });
  test.each([
    ['""', "empty"],
    ['"   "', "only spaces"],
    [JSON.stringify("x".repeat(65)), "65 characters"],
    ["5", "number"],
    ["null", "null"],
  ])("username %s (%s) is bad_request", (u) => {
    const r = bad(`{"event":"register","username":${u},"seq":3}`);
    expect(r).toMatchObject({ code: "bad_request", eventName: "register", seq: 3 });
  });
  test("64 characters is ok", () => {
    expect(ok(JSON.stringify({ event: "player_register", username: "x".repeat(64) }))).toBeTruthy();
  });
  test("missing username is bad_request", () => {
    expect(bad('{"event":"player_register"}').code).toBe("bad_request");
  });
});

describe("parse: game_start, game_finish, leave, oks", () => {
  test("timestamps are passed through, also when not valid", () => {
    expect(ok(`{"event":"game_start","timestamp":"${TS}"}`)).toEqual({
      event: "game_start",
      timestamp: TS,
    });
    expect(ok('{"event":"game_finish","timestamp":42}')).toEqual({
      event: "game_finish",
      timestamp: 42,
    });
  });
  test("simple events", () => {
    for (const e of ["player_leave", "player_incoming_ok", "player_left_ok"]) {
      expect(ok(`{"event":"${e}","extra":1}`)).toEqual({ event: e } as never);
    }
  });
  test("oks with id", () => {
    for (const e of ["player_incoming_ok", "player_left_ok"]) {
      expect(ok(`{"event":"${e}","id":12,"seq":3}`)).toEqual({ event: e, id: 12, seq: 3 } as never);
      expect(ok(`{"event":"${e}","id":null}`)).toEqual({ event: e } as never);
      for (const bad of ['"12"', "0", "-1", "1.5", "[1]", "1e300"]) {
        const r = parseClientMessage(`{"event":"${e}","id":${bad},"seq":4}`);
        expect(r).toMatchObject({ ok: false, code: "bad_request", eventName: e, seq: 4 });
      }
    }
  });
});

describe("parse: share", () => {
  const share = (fields: Record<string, unknown>) =>
    JSON.stringify({ event: "share", key: "k", value: 1, timestamp: TS, ...fields });

  test("pi null means all", () => {
    expect(ok(share({ pi: null }))).toMatchObject({ key: "k", value: 1, targets: null });
  });
  test("missing pi means all", () => {
    expect(ok('{"event":"share","key":"k","value":2}')).toMatchObject({ targets: null });
  });
  test("one pi", () => {
    expect(ok(share({ pi: 3 }))).toMatchObject({ targets: [3] });
  });
  test("array of pis is sorted and unique", () => {
    expect(ok(share({ pi: [5, 2, 5, 3] }))).toMatchObject({ targets: [2, 3, 5] });
  });
  test("value can be any JSON", () => {
    for (const value of [null, false, "s", 1.5, [1, [2]], { a: { b: null } }]) {
      expect(ok(share({ value, pi: null }))).toMatchObject({ value });
    }
  });
  test.each([[0], [6], ["3"], [[1, 9]], [[1, "2"]], [{ a: 1 }], [2.5]])(
    "pi %p is bad_request",
    (pi) => {
      expect(bad(share({ pi, seq: 9 }))).toMatchObject({ code: "bad_request", seq: 9 });
    },
  );
  test("key rules", () => {
    expect(bad(share({ key: "" })).code).toBe("bad_request");
    expect(bad(share({ key: 3 })).code).toBe("bad_request");
    expect(bad(share({ key: "k".repeat(129) })).code).toBe("bad_request");
    expect(ok(share({ key: "__proto__" }))).toMatchObject({ key: "__proto__" });
  });
  test("missing value is bad_request", () => {
    expect(bad('{"event":"share","key":"k","pi":null}').code).toBe("bad_request");
  });
});

describe("guards", () => {
  test("isPiId", () => {
    expect([0, 1, 5, 6, 2.5, "1", null].map(isPiId)).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
  test("isJson", () => {
    expect(isJson({ a: [1, "x", null, true] })).toBeTrue();
    expect(isJson(Number.NaN)).toBeFalse();
    expect(isJson(undefined)).toBeFalse();
    expect(isJson({ a: () => 1 })).toBeFalse();
  });
  test("parseClientObject works on decoded values", () => {
    expect(parseClientObject({ event: "game_start", seq: 2 })).toEqual({
      ok: true,
      event: { event: "game_start", seq: 2 },
    });
  });
});

describe("builders", () => {
  test("all server messages", () => {
    expect(msg.authOk()).toEqual({ event: "auth_ok" });
    expect(msg.playerRegisterOk()).toEqual({ event: "player_register_ok" });
    expect(msg.gameStartOk()).toEqual({ event: "game_start_ok" });
    expect(msg.gameFinishOk()).toEqual({ event: "game_finish_ok" });
    expect(msg.gameFinishWait("x")).toEqual({ event: "game_finish_wait", max_wait: "x" });
    expect(msg.playerLeaveOk()).toEqual({ event: "player_leave_ok" });
    expect(msg.shareOk()).toEqual({ event: "share_ok" });
    expect(msg.playerIncoming(7, "u", { a: 1 })).toEqual({
      event: "player_incoming",
      id: 7,
      username: "u",
      player_data: { a: 1 },
    });
    expect(msg.playerLeft(8, "u")).toEqual({ event: "player_left", id: 8, username: "u" });
    expect(msg.ack(4)).toEqual({ event: "ack", seq: 4 });
    expect(msg.error("room_busy", "m", "player_register")).toEqual({
      event: "error",
      code: "room_busy",
      message: "m",
      event_name: "player_register",
    });
  });
});
