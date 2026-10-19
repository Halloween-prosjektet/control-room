// Outbox delivery (plan section 8.10).
//
// - New entries are written at once if the Pi is connected and authenticated.
// - After auth_ok, all entries of the Pi are written again.
// - A timer writes each entry again when ACK_RETRY_MS went by since the last write,
//   while the Pi is connected and authenticated. The ack (`*_ok`) goes through
//   game.step(), which removes the entry.
// - After each write, the caller's `sent(ids)` runs step({type: "outbox_sent"}).
//   That removes entries that need no ack, and marks the others as sent.

import type { OutboxEntry } from "./game.ts";
import type { PiId, ServerMessage } from "./protocol.ts";

export interface OutboxDeps {
  /** The current outbox entries (oldest first). */
  entries(): readonly OutboxEntry[];
  /** Writes a message to the authenticated connection of the Pi. False if not written. */
  send(pi: PiId, m: ServerMessage): boolean;
  isReady(pi: PiId): boolean;
  /** Called with the ids that were written. */
  sent(ids: number[]): void;
  now(): number;
  retryMs: number;
}

export class Outbox {
  /** Time of the last write of each entry. */
  private readonly lastSent = new Map<number, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: OutboxDeps) {}

  /** Writes the entries with these ids (new entries). */
  deliver(ids: readonly number[]): void {
    const want = new Set(ids);
    this.write(this.deps.entries().filter((e) => want.has(e.id)));
  }

  /** Writes all entries of the Pi again (after auth_ok). */
  resendAll(pi: PiId): void {
    this.write(this.deps.entries().filter((e) => e.pi === pi));
  }

  /** Writes the entries that are due. The timer calls it. */
  tick(): void {
    const now = this.deps.now();
    const entries = this.deps.entries();
    const live = new Set(entries.map((e) => e.id));
    for (const id of this.lastSent.keys()) if (!live.has(id)) this.lastSent.delete(id);
    this.write(
      entries.filter((e) => {
        const last = this.lastSent.get(e.id);
        return last === undefined || now - last >= this.deps.retryMs;
      }),
    );
  }

  start(): void {
    if (this.timer !== null) return;
    const every = Math.max(10, Math.floor(this.deps.retryMs / 4));
    this.timer = setInterval(() => this.tick(), every);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private write(entries: readonly OutboxEntry[]): void {
    const now = this.deps.now();
    const written: number[] = [];
    for (const e of entries) {
      if (!this.deps.isReady(e.pi)) continue;
      if (this.deps.send(e.pi, e.payload)) {
        this.lastSent.set(e.id, now);
        written.push(e.id);
      }
    }
    if (written.length > 0) this.deps.sent(written);
  }
}
