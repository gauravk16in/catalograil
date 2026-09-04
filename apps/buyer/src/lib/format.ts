/**
 * Display formatting. All amounts arrive as paise strings and are formatted here — never
 * parsed into a number for arithmetic, which is where rule 13 gets broken by accident.
 */

export function formatPaise(paise: string | bigint | null | undefined): string {
  if (paise === null || paise === undefined) return '—';
  const value = BigInt(paise);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 100n).toString();
  const frac = abs % 100n;

  const grouped =
    whole.length <= 3
      ? whole
      : `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}`;

  return `${negative ? '-' : ''}₹${frac === 0n ? grouped : `${grouped}.${frac.toString().padStart(2, '0')}`}`;
}

/** Timestamps are stored UTC and rendered IST at the edge (conventions §9). */
export function formatIst(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86_400)} days ago`;
}
