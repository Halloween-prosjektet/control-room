import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

describe("config", () => {
  test("defaults", () => {
    expect(loadConfig({})).toEqual(DEFAULT_CONFIG);
  });
  test("reads all variables", () => {
    expect(
      loadConfig({
        PORT: "8080",
        HOST: "127.0.0.1",
        DB_PATH: "/tmp/x.sqlite",
        LOG_FILE: "/tmp/x.log",
        ACK_RETRY_MS: "500",
        DEFAULT_ROOM_MS: "60000",
        TZ_NAME: "UTC",
      }),
    ).toEqual({
      port: 8080,
      host: "127.0.0.1",
      dbPath: "/tmp/x.sqlite",
      logFile: "/tmp/x.log",
      ackRetryMs: 500,
      defaultRoomMs: 60000,
      tzName: "UTC",
    });
  });
  test("LOG_FILE=off has no log file", () => {
    expect(loadConfig({ LOG_FILE: "off" }).logFile).toBeNull();
    expect(loadConfig({ LOG_FILE: "OFF" }).logFile).toBeNull();
  });
  test("bad values stop the start", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow("PORT");
    expect(() => loadConfig({ PORT: "70000" })).toThrow("PORT");
    expect(() => loadConfig({ ACK_RETRY_MS: "1.5" })).toThrow("ACK_RETRY_MS");
    expect(() => loadConfig({ TZ_NAME: "Mars/Olympus" })).toThrow("TZ_NAME");
  });
});
