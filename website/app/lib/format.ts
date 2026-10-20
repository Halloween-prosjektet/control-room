/** Total time: m:ss,t (h:mm:ss,t from one hour). Norwegian decimal comma. */
export function formatTotal(ms: number): string {
  const t = Math.max(0, Math.round(ms / 100)); // tenths
  const d = t % 10;
  const s = Math.floor(t / 10) % 60;
  const m = Math.floor(t / 600) % 60;
  const h = Math.floor(t / 36000);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")},${d}`;
}

/** Live timer: m:ss. */
export function formatClock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}
