// duration.ts — human-scale formatting of wall-clock budgets (timeoutMs) for
// tick messages, failure notes, and panel rows. One spelling for the
// operator-visible form; the machine channel (facts/queue.json) keeps raw ms.

/** Compact human form: `12h`, `90m`, `45s`, `1h30m`, `43m12s` — integer hours
 *  when exact, else minutes, else seconds (with hours when large). Negative or
 *  NaN input formats as `0s` (defensive — callers pass validated budgets). */
export function formatDurationMs(ms: number): string {
  const n = Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : 0;
  const s = Math.floor(n / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return sec > 0 ? `${m}m${sec}s` : `${m}m`;
  return `${sec}s`;
}
