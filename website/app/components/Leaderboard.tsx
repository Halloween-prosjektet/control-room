import { useLayoutEffect, useRef } from "react";
import { formatTotal } from "~/lib/format";
import type { LeaderboardRow } from "~/lib/types";

const ONE_SCREEN = "(min-width: 760px)";

/**
 * The leaderboard in the pumpkin frame. `fresh` holds the player ids that are new
 * since the last update; those rows flash.
 */
export function Leaderboard({ rows, fresh }: { rows: LeaderboardRow[]; fresh: Set<string> }) {
  const listRef = useRef<HTMLOListElement>(null);

  // On one-screen layouts, hide the rows that do not fit, so no row is cut in half.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const fit = () => {
      const items = [...list.children] as HTMLElement[];
      for (const li of items) li.hidden = false;
      if (!matchMedia(ONE_SCREEN).matches) return;
      const bottom = list.getBoundingClientRect().bottom;
      for (const li of items) li.hidden = li.getBoundingClientRect().bottom > bottom + 1;
    };
    fit();
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, [rows]);

  return (
    <section className="board" aria-label="Toppliste">
      <ol className="list" ref={listRef}>
        {rows.length === 0 ? (
          <li className="empty">Ingen har kommet seg ut ennå.</li>
        ) : (
          rows.map((r) => {
            const cls = ["row"];
            if (r.rank <= 3) cls.push(`row--${r.rank}`);
            if (fresh.has(r.player_id)) cls.push("row--new");
            return (
              <li key={r.player_id} className={cls.join(" ")}>
                <span className="rank">{r.rank}</span>
                <span className="name">{r.username}</span>
                <span className="time">{formatTotal(r.total_time_ms)}</span>
              </li>
            );
          })
        )}
      </ol>
    </section>
  );
}
