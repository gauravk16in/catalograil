import { createHash } from 'node:crypto';
import { EMBEDDING_DIMENSIONS } from '@catalograil/core';

/**
 * The embedding port and the Bedrock implementation behind it.
 *
 * Everything here is shaped by what T1.2 actually measured, not by what D5 assumed:
 *
 *   - Embed v4 refuses on-demand invocation. It is reachable only through the inference
 *     profile `global.cohere.embed-v4:0`; the bare model id is a ValidationException.
 *   - Text and image take *different request bodies on the same model*. Text uses the v3
 *     style `{ texts: [...] }`, image the v4 style `{ inputs: [{ content: [...] }] }`.
 *     This is the reason `embedTexts` and `embedImage` do not share a code path.
 *
 * See `MODELS.md`, which the verification script regenerates.
 */

/** Cohere's per-request ceiling. Batching below this is what keeps ingestion affordable. */
export const MAX_TEXTS_PER_CALL = 96;

/**
 * `search_document` for catalogue text, `search_query` for a buyer's query. Cohere embeds
 * the two asymmetrically, and using the wrong one quietly costs recall rather than failing.
 */
export type InputType = 'search_document' | 'search_query';

export interface Embedder {
  embedTexts(texts: readonly string[], inputType: InputType): Promise<number[][]>;
  /** Returns null when the image cannot be embedded; the unit still indexes (T1.15). */
  embedImage(image: ImagePayload): Promise<number[] | null>;
}

export interface ImagePayload {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface BedrockEmbedderOptions {
  readonly textModelId?: string;
  readonly imageModelId?: string;
  readonly dimensions?: number;
  /** D5 asks for int8. See the note in `parseEmbeddings` on what that does and does not buy. */
  readonly embeddingType?: 'int8' | 'float';
}

/** Minimal shape of the Bedrock runtime client, so tests need no AWS SDK. */
export interface BedrockInvoker {
  invoke(modelId: string, body: unknown): Promise<unknown>;
}

export class BedrockEmbedder implements Embedder {
  private readonly textModelId: string;
  private readonly imageModelId: string;
  private readonly dimensions: number;
  private readonly embeddingType: 'int8' | 'float';

  constructor(
    private readonly invoker: BedrockInvoker,
    options: BedrockEmbedderOptions = {},
  ) {
    this.textModelId = options.textModelId ?? 'global.cohere.embed-v4:0';
    this.imageModelId = options.imageModelId ?? 'global.cohere.embed-v4:0';
    this.dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
    this.embeddingType = options.embeddingType ?? 'int8';
  }

  /**
   * Embeds up to `MAX_TEXTS_PER_CALL` per request, in order.
   *
   * Order is the contract: callers match results to inputs positionally, so a partial or
   * reordered response has to be an error rather than a silently mismatched vector — an
   * embedding attached to the wrong product is invisible until search results make no
   * sense.
   */
  async embedTexts(texts: readonly string[], inputType: InputType): Promise<number[][]> {
    if (texts.length === 0) return [];

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_TEXTS_PER_CALL) {
      const batch = texts.slice(i, i + MAX_TEXTS_PER_CALL);
      const response = await this.invoker.invoke(this.textModelId, {
        // The v3-style body. T1.2 measured this as the one that works for text.
        texts: batch,
        input_type: inputType,
        embedding_types: [this.embeddingType],
        output_dimension: this.dimensions,
      });

      const vectors = parseEmbeddings(response, this.embeddingType);
      if (vectors.length !== batch.length) {
        throw new Error(
          `Bedrock returned ${vectors.length} embeddings for ${batch.length} texts; refusing to guess the alignment.`,
        );
      }
      out.push(...vectors);
    }
    return out;
  }

  async embedImage(image: ImagePayload): Promise<number[] | null> {
    const dataUri = `data:${image.contentType};base64,${Buffer.from(image.bytes).toString('base64')}`;

    const response = await this.invoker.invoke(this.imageModelId, {
      // The v4-style body. Images are rejected by the `texts` shape above.
      inputs: [{ content: [{ type: 'image', image: dataUri }] }],
      input_type: 'image',
      embedding_types: [this.embeddingType],
      output_dimension: this.dimensions,
    });

    const vectors = parseEmbeddings(response, this.embeddingType);
    return vectors[0] ?? null;
  }
}

/**
 * Pulls vectors out of a Cohere response.
 *
 * On `int8`: the values come back in [-128, 127], and pgvector's `vector` stores float32
 * regardless, so requesting int8 saves response bytes but no database storage. Cosine
 * distance is scale-invariant, so the quantisation costs nothing in ranking. If storage
 * were the goal it would need `halfvec` and a schema change — worth knowing before anyone
 * assumes D5's `int8` is buying disk space.
 */
function parseEmbeddings(response: unknown, embeddingType: 'int8' | 'float'): number[][] {
  if (typeof response !== 'object' || response === null) return [];
  const embeddings = (response as { embeddings?: unknown }).embeddings;

  // `{ embeddings: number[][] }`
  if (Array.isArray(embeddings)) {
    return embeddings.filter((row): row is number[] => Array.isArray(row));
  }

  // `{ embeddings: { int8: number[][], float: number[][] } }`
  if (typeof embeddings === 'object' && embeddings !== null) {
    const byType = embeddings as Record<string, unknown>;
    for (const key of [embeddingType, 'int8', 'float', 'ubinary']) {
      const rows = byType[key];
      if (Array.isArray(rows) && rows.every((r) => Array.isArray(r))) return rows as number[][];
    }
  }

  return [];
}

// ─── Image fetching ───────────────────────────────────────────────────────────────

export interface ImageFetcher {
  /** Returns null for anything that cannot be fetched or is not an image. */
  fetch(url: string): Promise<ImagePayload | null>;
}

/** Beyond this an image is not worth embedding, and is probably not a product photo. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 5_000;

export class HttpImageFetcher implements ImageFetcher {
  constructor(private readonly timeoutMs = IMAGE_FETCH_TIMEOUT_MS) {}

  /**
   * Never throws. A merchant's broken image URL is an ordinary occurrence, and T1.15
   * requires the unit to index anyway with `v_visual` null — so failure is a null return,
   * not an exception that would take the whole product's embedding down with it.
   */
  async fetch(url: string): Promise<ImagePayload | null> {
    try {
      const response = await globalThis.fetch(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'follow',
      });
      if (!response.ok) return null;

      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (!contentType.startsWith('image/')) return null;

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;

      return { bytes, contentType };
    } catch {
      return null;
    }
  }
}

// ─── Image embedding cache ────────────────────────────────────────────────────────

export interface EmbeddingCache {
  get(key: string): Promise<number[] | null | undefined>;
  set(key: string, value: number[] | null): Promise<void>;
}

/**
 * Keys the cache by image URL.
 *
 * T1.15 calls for this because merchants reuse one photo across every variant of a
 * product — a shirt in three colours and five sizes is fifteen units sharing at most three
 * images. Without it, image embedding dominates the cost of ingesting a variant catalogue.
 */
export function imageCacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

export class InMemoryEmbeddingCache implements EmbeddingCache {
  private readonly entries = new Map<string, number[] | null>();

  async get(key: string): Promise<number[] | null | undefined> {
    return this.entries.has(key) ? this.entries.get(key) : undefined;
  }

  async set(key: string, value: number[] | null): Promise<void> {
    this.entries.set(key, value);
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Embeds an image with caching, including caching the failures.
 *
 * A negative result is remembered deliberately: without it, a product whose image URL
 * 404s would re-fetch and re-fail once per variant on every run.
 */
export async function embedImageCached(
  url: string,
  deps: { embedder: Embedder; fetcher: ImageFetcher; cache: EmbeddingCache },
): Promise<number[] | null> {
  const key = imageCacheKey(url);

  const cached = await deps.cache.get(key);
  if (cached !== undefined) return cached;

  const image = await deps.fetcher.fetch(url);
  let vector: number[] | null = null;
  if (image) {
    try {
      vector = await deps.embedder.embedImage(image);
    } catch {
      vector = null;
    }
  }

  await deps.cache.set(key, vector);
  return vector;
}
