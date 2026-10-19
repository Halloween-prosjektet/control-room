// Timestamp rules (plan section 7.3).
//
// - Client timestamps are ISO 8601 with an offset ("Z", "+00:00", "+02:00", ...).
//   The fraction can have 0, 3 or 6 digits. Digits after the millisecond are cut.
// - A missing, bad, or far (more than 24 h from server time) timestamp is
//   replaced by the server receive time, with a warning.
// - The server writes timestamps in a named time zone with the correct offset.

export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}|\d{6}))?(Z|[+-]\d{2}:\d{2})$/;

/** Parses an ISO 8601 timestamp with an offset. Returns epoch ms, or null if not valid. */
export function parseIsoWithOffset(text: string): number | null {
  const m = ISO_RE.exec(text);
  if (!m) return null;
  const [, ys, mos, ds, hs, mis, ss, frac, off] = m;
  const year = Number(ys);
  const month = Number(mos);
  const day = Number(ds);
  const hour = Number(hs);
  const minute = Number(mis);
  const second = Number(ss);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  const ms = frac === undefined ? 0 : Number(frac.slice(0, 3));
  let offsetMin = 0;
  if (off !== undefined && off !== "Z") {
    const sign = off[0] === "-" ? -1 : 1;
    const oh = Number(off.slice(1, 3));
    const om = Number(off.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetMin = sign * (oh * 60 + om);
  }
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  return utc - offsetMin * 60_000;
}

export interface ResolvedTime {
  /** Epoch ms to use for the event. */
  ms: number;
  /** Set when the server used its own time in place of the client time. */
  warning?: string;
}

/** Applies the rules of section 7.3: client time if valid and within 24 h, else server time. */
export function resolveClientTime(timestamp: unknown, nowMs: number): ResolvedTime {
  if (timestamp === undefined || timestamp === null) {
    return { ms: nowMs, warning: "timestamp missing; used server time" };
  }
  if (typeof timestamp !== "string") {
    return { ms: nowMs, warning: "timestamp is not a string; used server time" };
  }
  const parsed = parseIsoWithOffset(timestamp);
  if (parsed === null) {
    return {
      ms: nowMs,
      warning: `timestamp not valid (${JSON.stringify(timestamp)}); used server time`,
    };
  }
  if (Math.abs(parsed - nowMs) > MAX_CLOCK_SKEW_MS) {
    return {
      ms: nowMs,
      warning: `timestamp ${timestamp} is more than 24 h from server time; used server time`,
    };
  }
  return { ms: parsed };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tzName: string): Intl.DateTimeFormat {
  let f = formatters.get(tzName);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tzName,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tzName, f);
  }
  return f;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Formats epoch ms as ISO 8601 in the time zone `tzName`, with milliseconds and the
 * correct offset. Example: "2026-10-31T19:56:21.624+01:00".
 */
export function formatInZone(ms: number, tzName: string): string {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(tzName).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const y = parts.year ?? 0;
  const mo = parts.month ?? 1;
  const d = parts.day ?? 1;
  const h = parts.hour ?? 0;
  const mi = parts.minute ?? 0;
  const s = parts.second ?? 0;
  const millis = ((ms % 1000) + 1000) % 1000;
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s, millis);
  const offsetMin = Math.round((wallAsUtc - ms) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  return (
    `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}.${pad(millis, 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
