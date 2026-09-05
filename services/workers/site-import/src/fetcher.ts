import { lookup } from 'node:dns/promises';
import type { FetchedPage, Fetcher } from '@catalograil/site-import';

/**
 * The network boundary, and the only place a merchant-supplied URL is allowed to reach.
 *
 * The URL comes from a form. That makes every request here server-side request forgery
 * unless something stops it: a merchant who types `http://169.254.169.254/` is asking this
 * Lambda to fetch its own credentials and hand them back, and one who points at a
 * ten-gigabyte file is asking it to run out of memory. Neither is hypothetical — both are
 * the first two things anyone tries.
 *
 * So every host is resolved before it is fetched and refused if it lands anywhere private,
 * every response is capped, every request has a deadline, and redirects are followed by
 * hand so a public URL cannot bounce to a private one.
 */

const TIMEOUT_MS = 8_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export function createFetcher(): Fetcher {
  return async (url: string): Promise<FetchedPage> => {
    let current = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertPublic(current);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            // Named honestly. A merchant reading their own access log should be able to tell
            // who this is, and a site that would rather we did not can say so.
            'user-agent': 'ConciergentBot/1.0 (+https://conciergent.in/bot)',
            accept: 'application/json, text/html, application/xml;q=0.9, */*;q=0.8',
          },
        });

        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location) {
          current = new URL(location, current).toString();
          continue;
        }

        return {
          url: current,
          status: response.status,
          contentType: response.headers.get('content-type') ?? '',
          body: await readCapped(response),
        };
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error('Too many redirects.');
  };
}

/**
 * Reads at most `MAX_BYTES`, then stops.
 *
 * `response.text()` would read whatever is sent, which is the merchant's decision to make
 * about our memory. Truncating mid-document is fine for every reader here: JSON that is cut
 * off fails to parse and is reported, and a sitemap or a page is matched with patterns that
 * do not care whether the tail arrived.
 */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.byteLength;
    if (total >= MAX_BYTES) {
      await reader.cancel();
      break;
    }
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Refuses anything that resolves to an address this Lambda should not be talking to.
 *
 * Resolved rather than pattern-matched on the hostname: `localtest.me` and a thousand
 * domains like it are public names that resolve to 127.0.0.1, so checking the string is
 * checking the wrong thing.
 */
export async function assertPublic(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Refusing to fetch ${parsed.protocol}//`);
  }

  const addresses = await lookup(parsed.hostname, { all: true });
  for (const { address, family } of addresses) {
    if (isPrivate(address, family)) {
      throw new Error(`${parsed.hostname} resolves to a private address.`);
    }
  }
}

export function isPrivate(address: string, family: number): boolean {
  if (family === 6) {
    const lower = address.toLowerCase();
    // Loopback, link-local, and unique-local. An IPv4-mapped address is checked as IPv4.
    if (lower === '::1' || lower.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(lower)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    return mapped ? isPrivate(mapped[1]!, 4) : false;
  }

  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts as [number, number, number, number];

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) || // link-local, which is where the instance metadata service lives
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast and reserved
  );
}
