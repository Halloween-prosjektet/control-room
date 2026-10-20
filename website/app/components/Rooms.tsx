import { useEffect, useState } from "react";
import { formatClock } from "~/lib/format";
import { ROOMS, type ControlRoomState, type RoomSlot, type SlotState } from "~/lib/types";

const STATE_TEXT: Record<SlotState, string> = {
  empty: "Ledig",
  incoming: "På vei",
  playing: "Spiller",
  waiting: "Venter",
};

/** The current time, updated each `ms`. Null on the server and in the first render. */
function useNow(ms: number): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Playing: counts up from the start. Waiting: the time the player used in the room. */
function clockText(slot: RoomSlot, now: number | null, skew: number): string {
  if (now === null || !slot.started_at) return "";
  const start = Date.parse(slot.started_at);
  const end = slot.state === "playing" ? now - skew : Date.parse(slot.finished_at ?? "");
  return Number.isNaN(start) || Number.isNaN(end) ? "" : formatClock(end - start);
}

/** Each digit in a fixed-width cell, so the timer does not move while it counts. */
function Clock({ text }: { text: string }) {
  return (
    <span className="clock">
      {text.split("").map((c, i) =>
        c === ":" ? (
          <span key={i} className="sep">
            :
          </span>
        ) : (
          <span key={i}>{c}</span>
        ),
      )}
    </span>
  );
}

/**
 * The five rooms, live. `skew` is the browser clock minus the web server clock, so
 * a wrong clock on the screen does not change the timers.
 */
export function Rooms({ state, skew }: { state: ControlRoomState; skew: number }) {
  const now = useNow(250);
  return (
    <section className="rooms" aria-label="Rommene nå">
      {ROOMS.map((n) => {
        const slot: RoomSlot = state.rooms.find((s) => s.room === n) ?? {
          room: n,
          state: "empty",
          username: null,
          started_at: null,
          finished_at: null,
        };
        const st: SlotState = slot.state in STATE_TEXT ? slot.state : "empty";
        return (
          <article key={n} className="room" data-state={st}>
            <div className="sign" aria-label={`Underetasje ${n}`}>
              U{n}
            </div>
            <span className="chip">{STATE_TEXT[st]}</span>
            <span className="room__name">{slot.username ?? ""}</span>
            <Clock text={clockText(slot, now, skew)} />
          </article>
        );
      })}
    </section>
  );
}
