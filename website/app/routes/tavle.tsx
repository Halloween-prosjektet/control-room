import { useEffect, useMemo, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { Effects } from "~/components/Effects";
import { Leaderboard } from "~/components/Leaderboard";
import { Rooms } from "~/components/Rooms";
import { loadBoard } from "~/lib/control-room.server";
import type { Board } from "~/lib/types";
import type { Route } from "./+types/tavle";

const POLL_MS = 2000;

export function meta() {
  return [
    { title: "Underetasje 5 Toppliste" },
    {
      name: "description",
      content: "De raskeste gjennom Underetasje 5, og hvem som er i rommene nå.",
    },
  ];
}

/**
 * ?hall: the 9:16 screen in the hall (no cursor, the screen stays on, the phone
 * address in the footer). ?fx=0: no shader effects (slow hardware).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return {
    board: await loadBoard(),
    hall: url.searchParams.has("hall"),
    fx: url.searchParams.get("fx") !== "0",
  };
}

type Status = "live" | "lost" | "demo";
const STATUS_TEXT: Record<Status, string> = {
  live: "Direkte",
  lost: "Mistet kontakt",
  demo: "Eksempeldata",
};

export default function Tavle({ loaderData }: Route.ComponentProps) {
  const { board, hall, fx } = loaderData;

  // Load again every POLL_MS. Skip a tick while a load is still running.
  const revalidator = useRevalidator();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  useEffect(() => {
    const id = setInterval(() => {
      if (revalidatorRef.current.state === "idle") void revalidatorRef.current.revalidate();
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  // When the server stops answering, keep the last live data on the screen.
  const lastLive = useRef<Board | null>(null);
  if (board.mode === "live") lastLive.current = board;
  const status: Status = board.mode === "live" ? "live" : lastLive.current ? "lost" : "demo";
  const shown = status === "lost" && lastLive.current ? lastLive.current : board;

  // Rows that were not in the previous answer flash.
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const ids = shown.rows.map((r) => r.player_id);
    if (seen.current) {
      const prev = seen.current;
      const added = ids.filter((id) => !prev.has(id));
      if (added.length > 0) setFresh(new Set(added));
    }
    seen.current = new Set(ids);
  }, [shown.rows]);

  // Browser clock minus web server clock (0 on the server: the timers start empty there).
  const skew = useMemo(
    () => (typeof window === "undefined" ? 0 : Date.now() - shown.serverNow),
    [shown.serverNow],
  );

  const [host, setHost] = useState("");
  useEffect(() => {
    if (!hall) return;
    setHost(location.host);
    // Keep the hall screen on. The browser can refuse; then nothing happens.
    const lock = () => {
      navigator.wakeLock?.request("screen").catch(() => {});
    };
    lock();
    document.addEventListener("visibilitychange", lock);
    return () => document.removeEventListener("visibilitychange", lock);
  }, [hall]);

  return (
    <>
      {fx && <Effects />}
      <div className={hall ? "app kiosk" : "app"}>
        <h1 className="sr">Toppliste</h1>
        <span className="status" data-mode={status}>
          {STATUS_TEXT[status]}
        </span>
        <main className="wrap main">
          <Leaderboard rows={shown.rows} fresh={fresh} />
          <Rooms state={shown.state} skew={skew} />
        </main>
        <footer className="foot">
          <div className="foot__wall" />
          {hall && host && (
            <div className="wrap foot__line">
              <span>
                Følg med på mobilen: <strong>{host}</strong>
              </span>
            </div>
          )}
        </footer>
      </div>
    </>
  );
}
