import { describe, expect, it } from 'vitest';
import { BedrockEmbedder, InMemoryEmbeddingCache, embedImageCached } from './embedder.js';
import { createBedrockInvoker } from './bedrock.js';

/**
 * Calls Bedrock for real.
 *
 * Everything else about embedding is tested against a fake invoker, but two things can
 * only be established against the live service, and both were wrong in the original
 * assumptions: that the request bodies are the right shape, and that the vectors come back
 * at 1024 dimensions. A fake would have happily agreed with a body Bedrock rejects.
 *
 * Opt-in via BEDROCK_LIVE_TEST=1, since it costs money and needs credentials.
 */
const LIVE = process.env.BEDROCK_LIVE_TEST === '1';
const REGION = process.env.BEDROCK_REGION ?? 'ap-south-1';

/** A 1x1 red PNG. Enough to prove the image path; not a product photo. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe.skipIf(!LIVE)('Bedrock, live', () => {
  const embedder = new BedrockEmbedder(createBedrockInvoker(REGION));

  it('embeds text at the dimensions searchable_units expects', async () => {
    const [vector] = await embedder.embedTexts(
      ['Lilac cotton oxford shirt, size 42, ships in 3 days from Bengaluru.'],
      'search_document',
    );

    expect(vector).toBeDefined();
    // The vector(1024) columns are already migrated; a different width here would mean a
    // table rebuild, so this assertion is load-bearing rather than decorative.
    expect(vector).toHaveLength(1024);
    expect(vector!.every((v) => Number.isFinite(v))).toBe(true);
  }, 60_000);

  it('returns one vector per text, in order', async () => {
    const vectors = await embedder.embedTexts(
      ['cotton shirt', 'dashcam for a car', 'air conditioner service'],
      'search_document',
    );
    expect(vectors).toHaveLength(3);

    // The shirt and the dashcam should be further apart than either is from itself.
    expect(cosine(vectors[0]!, vectors[0]!)).toBeCloseTo(1, 5);
    expect(cosine(vectors[0]!, vectors[1]!)).toBeLessThan(0.99);
  }, 60_000);

  it('places a query nearer its own product than an unrelated one', async () => {
    // The asymmetry search depends on: documents and queries use different input types.
    const [shirt, dashcam] = await embedder.embedTexts(
      [
        'Meridian Oxford Shirt — long sleeve cotton shirt with a button-down collar',
        'RoadEye 4K Dashcam — front-facing dashcam with night mode and loop recording',
      ],
      'search_document',
    );
    const [query] = await embedder.embedTexts(['formal shirt for office'], 'search_query');

    expect(cosine(query!, shirt!)).toBeGreaterThan(cosine(query!, dashcam!));
  }, 60_000);

  it('embeds an image through the other request shape', async () => {
    // Text and image take different bodies on this same model; this is the half a fake
    // invoker cannot prove.
    const vector = await embedder.embedImage({ bytes: TINY_PNG, contentType: 'image/png' });
    expect(vector).toHaveLength(1024);
  }, 60_000);

  it('caches by URL, so repeated images cost one call', async () => {
    const cache = new InMemoryEmbeddingCache();
    let fetches = 0;
    const fetcher = {
      async fetch() {
        fetches++;
        return { bytes: TINY_PNG, contentType: 'image/png' };
      },
    };

    const url = 'https://example.com/shirt-white.jpg';
    const first = await embedImageCached(url, { embedder, fetcher, cache });
    const second = await embedImageCached(url, { embedder, fetcher, cache });

    expect(first).toHaveLength(1024);
    expect(second).toEqual(first);
    expect(fetches).toBe(1);
  }, 60_000);
});

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
