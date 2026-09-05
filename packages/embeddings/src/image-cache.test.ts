import { describe, expect, it } from 'vitest';
import { embedImageCached } from './embedder.js';
import type { EmbeddingCache, Embedder, ImageFetcher, ImagePayload } from './embedder.js';

/**
 * T2.9's caching, which exists because an assistant passes the same `image_url` on every
 * turn and each uncached pass costs an HTTP fetch plus a Bedrock call inside a 200ms budget.
 */
class MemoryCache implements EmbeddingCache {
  readonly store = new Map<string, number[] | null>();
  async get(key: string) {
    return this.store.has(key) ? this.store.get(key)! : undefined;
  }
  async set(key: string, value: number[] | null) {
    this.store.set(key, value);
  }
}

function fixtures(bytes: Uint8Array) {
  let fetches = 0;
  let embeds = 0;
  const fetcher: ImageFetcher = {
    async fetch() {
      fetches++;
      return { bytes, contentType: 'image/jpeg' } as ImagePayload;
    },
  };
  const embedder = {
    async embedImage() {
      embeds++;
      return [0.1, 0.2, 0.3];
    },
  } as unknown as Embedder;
  return { fetcher, embedder, counts: () => ({ fetches, embeds }) };
}

describe('embedImageCached', () => {
  it('skips both the fetch and the model on a repeated URL', async () => {
    // The common case: an assistant re-sends the same image_url every turn.
    const cache = new MemoryCache();
    const { fetcher, embedder, counts } = fixtures(new Uint8Array([1, 2, 3]));

    await embedImageCached('https://img.test/a.jpg', { embedder, fetcher, cache });
    await embedImageCached('https://img.test/a.jpg', { embedder, fetcher, cache });

    expect(counts()).toEqual({ fetches: 1, embeds: 1 });
  });

  it('skips the model when the same bytes arrive under a different URL', async () => {
    /**
     * The correct case. A re-uploaded photo gets a fresh signed URL every time, so URL
     * keying alone would embed identical bytes over and over. The fetch still happens; the
     * expensive half does not.
     */
    const cache = new MemoryCache();
    const { fetcher, embedder, counts } = fixtures(new Uint8Array([9, 9, 9]));

    await embedImageCached('https://img.test/signed?sig=1', { embedder, fetcher, cache });
    await embedImageCached('https://img.test/signed?sig=2', { embedder, fetcher, cache });

    expect(counts()).toEqual({ fetches: 2, embeds: 1 });
  });

  it('remembers that an image could not be fetched', async () => {
    // A broken URL in a conversation is retried on every turn otherwise, and each retry
    // costs the full fetch timeout.
    const cache = new MemoryCache();
    let fetches = 0;
    const fetcher: ImageFetcher = {
      async fetch() {
        fetches++;
        return null;
      },
    };
    const embedder = { async embedImage() { return [1]; } } as unknown as Embedder;

    expect(await embedImageCached('https://img.test/404', { embedder, fetcher, cache })).toBeNull();
    expect(await embedImageCached('https://img.test/404', { embedder, fetcher, cache })).toBeNull();
    expect(fetches).toBe(1);
  });

  it('returns null rather than failing the search when embedding throws', async () => {
    // A text query alongside the image is still worth answering; the caller sees fewer
    // channels rather than an error.
    const cache = new MemoryCache();
    const fetcher: ImageFetcher = {
      async fetch() {
        return { bytes: new Uint8Array([1]), contentType: 'image/jpeg' } as ImagePayload;
      },
    };
    const embedder = {
      async embedImage() {
        throw new Error('Bedrock refused the image.');
      },
    } as unknown as Embedder;

    expect(await embedImageCached('https://img.test/x.jpg', { embedder, fetcher, cache })).toBeNull();
  });
});
