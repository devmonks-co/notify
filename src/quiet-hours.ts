const cache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = cache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
    } catch {
      f = fmt('UTC');
    }
    cache.set(tz, f);
  }
  return f;
}

/** Minutes since local midnight for [now] in [tz] (bad zones fall back to UTC). */
function localMinutes(now: Date, tz: string): number {
  let h = 0;
  let m = 0;
  for (const p of fmt(tz).formatToParts(now)) {
    if (p.type === 'hour') h = Number(p.value) % 24;
    if (p.type === 'minute') m = Number(p.value);
  }
  return h * 60 + m;
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** True when the recipient's local time is inside [from, to). Crosses midnight when from > to; from == to is "never". */
export function inQuietHours(now: Date, tz: string, q: { from: string; to: string } | undefined): boolean {
  if (!q) return false;
  const from = parseHHMM(q.from);
  const to = parseHHMM(q.to);
  if (from === null || to === null || from === to) return false;
  const t = localMinutes(now, tz);
  return from < to ? t >= from && t < to : t >= from || t < to;
}
