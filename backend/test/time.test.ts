import { describe, expect, test } from "bun:test";
import {
  formatInZone,
  MAX_CLOCK_SKEW_MS,
  parseIsoWithOffset,
  resolveClientTime,
} from "../src/time.ts";

const T = Date.UTC(2026, 9, 31, 18, 56, 21, 624); // 2026-10-31T18:56:21.624Z

describe("parseIsoWithOffset", () => {
  test("accepts 6 fractional digits and cuts after ms", () => {
    expect(parseIsoWithOffset("2026-10-31T18:56:21.624416+00:00")).toBe(T);
  });
  test("accepts Z, +00:00, +02:00 and -05:30 as the same instant", () => {
    expect(parseIsoWithOffset("2026-10-31T18:56:21.624Z")).toBe(T);
    expect(parseIsoWithOffset("2026-10-31T20:56:21.624416+02:00")).toBe(T);
    expect(parseIsoWithOffset("2026-10-31T13:26:21.624-05:30")).toBe(T);
  });
  test("accepts no fraction", () => {
    expect(parseIsoWithOffset("2026-10-31T18:56:21Z")).toBe(T - 624);
    expect(parseIsoWithOffset("2026-10-31T19:56:21+01:00")).toBe(T - 624);
  });
  test("client +02:00 after the DST change still gives the correct instant", () => {
    // Real Oslo time 19:56 (+01:00) = 18:56Z; the client writes 20:56+02:00.
    expect(parseIsoWithOffset("2026-10-31T20:56:21.624416+02:00")).toBe(T);
  });
  test.each([
    "",
    "2026-10-31",
    "2026-10-31T18:56:21",
    "2026-10-31T18:56:21.62Z",
    "2026-10-31T18:56:21.6244Z",
    "2026-13-01T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-10-31T24:00:00Z",
    "2026-10-31T18:60:00Z",
    "2026-10-31T18:56:21+2:00",
    "2026-10-31 18:56:21Z",
    "2026-10-31T18:56:21+24:00",
    "garbage",
  ])("rejects %p", (s) => {
    expect(parseIsoWithOffset(s)).toBeNull();
  });
  test("accepts 29 February in a leap year only", () => {
    expect(parseIsoWithOffset("2028-02-29T00:00:00Z")).not.toBeNull();
    expect(parseIsoWithOffset("2026-02-29T00:00:00Z")).toBeNull();
  });
});

describe("resolveClientTime", () => {
  test("uses a valid client time", () => {
    expect(resolveClientTime("2026-10-31T18:56:21.624Z", T + 5000)).toEqual({ ms: T });
  });
  test("missing, null, non-string or bad timestamp gives server time with a warning", () => {
    for (const ts of [undefined, null, 123, "nope"]) {
      const r = resolveClientTime(ts, T);
      expect(r.ms).toBe(T);
      expect(r.warning).toBeString();
    }
  });
  test("24 h rule", () => {
    const iso = new Date(T).toISOString();
    expect(resolveClientTime(iso, T + MAX_CLOCK_SKEW_MS)).toEqual({ ms: T });
    expect(resolveClientTime(iso, T - MAX_CLOCK_SKEW_MS)).toEqual({ ms: T });
    const far = resolveClientTime(iso, T + MAX_CLOCK_SKEW_MS + 1);
    expect(far.ms).toBe(T + MAX_CLOCK_SKEW_MS + 1);
    expect(far.warning).toContain("24 h");
  });
});

describe("formatInZone", () => {
  test("Europe/Oslo winter time is +01:00", () => {
    expect(formatInZone(T, "Europe/Oslo")).toBe("2026-10-31T19:56:21.624+01:00");
  });
  test("Europe/Oslo summer time is +02:00", () => {
    expect(formatInZone(Date.UTC(2026, 6, 1, 10, 0, 0, 5), "Europe/Oslo")).toBe(
      "2026-07-01T12:00:00.005+02:00",
    );
  });
  test("DST change on 25 October 2026", () => {
    expect(formatInZone(Date.UTC(2026, 9, 25, 0, 59, 59, 999), "Europe/Oslo")).toBe(
      "2026-10-25T02:59:59.999+02:00",
    );
    expect(formatInZone(Date.UTC(2026, 9, 25, 1, 0, 0, 0), "Europe/Oslo")).toBe(
      "2026-10-25T02:00:00.000+01:00",
    );
  });
  test("UTC and a negative offset", () => {
    expect(formatInZone(T, "UTC")).toBe("2026-10-31T18:56:21.624+00:00");
    expect(formatInZone(T, "America/New_York")).toBe("2026-10-31T14:56:21.624-04:00");
  });
  test("round trip through parseIsoWithOffset", () => {
    for (let i = 0; i < 200; i++) {
      const ms = Date.UTC(2026, 0, 1) + i * 1_234_567_891;
      expect(parseIsoWithOffset(formatInZone(ms, "Europe/Oslo"))).toBe(ms);
    }
  });
});
