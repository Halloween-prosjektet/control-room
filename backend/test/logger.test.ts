import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileLogger } from "../src/index.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cr-log-"));
  dirs.push(dir);
  return dir;
}

describe("file logger", () => {
  test("appends each line and makes the directory", () => {
    const path = join(tempDir(), "sub", "server.log");
    const log = createFileLogger(path);
    log("info", "first");
    log("warn", "second");
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z INFO first$/);
    expect(lines[1]).toMatch(/ WARN second$/);
  });

  test("keeps old lines after a restart", () => {
    const path = join(tempDir(), "server.log");
    createFileLogger(path)("info", "before");
    createFileLogger(path)("info", "after");
    expect(readFileSync(path, "utf8").trimEnd().split("\n")).toHaveLength(2);
  });

  test("a path that cannot be written does not throw", () => {
    const log = createFileLogger(tempDir()); // a directory, not a file
    expect(() => log("info", "ok")).not.toThrow();
  });
});
