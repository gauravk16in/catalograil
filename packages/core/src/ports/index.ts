/**
 * The narrow interfaces the workers depend on, so the logic that matters can be tested
 * without AWS in the room.
 *
 * Deliberately smaller than the services behind them. `ObjectStore` is not S3 — it is the
 * four things ingestion actually does with S3. Keeping it that small is what makes an
 * in-memory implementation honest rather than a mock that agrees with whatever the test
 * expects.
 *
 * Byte streams are `AsyncIterable<Uint8Array>` rather than a Node `Readable`, because that
 * is what an S3 response body, a local file and an in-memory buffer can all be.
 */

export interface PresignedUpload {
  readonly url: string;
  readonly key: string;
  readonly expiresAt: Date;
  /** Form fields for a POST policy, when the implementation uses one. */
  readonly fields?: Record<string, string>;
}

export interface PresignOptions {
  readonly expiresInSeconds?: number;
  readonly contentType?: string;
  readonly maxBytes?: number;
}

export interface PutOptions {
  readonly contentType?: string;
}

export interface ObjectStore {
  /** Streams an object. Throws `NOT_FOUND` if the key does not exist. */
  readStream(key: string): Promise<AsyncIterable<Uint8Array>>;
  put(key: string, body: string | Uint8Array, options?: PutOptions): Promise<void>;
  presignPut(key: string, options?: PresignOptions): Promise<PresignedUpload>;
  exists(key: string): Promise<boolean>;
}

export interface Queue<TMessage> {
  send(message: TMessage): Promise<void>;
  /** Implementations chunk to whatever the transport allows; callers pass any length. */
  sendBatch(messages: readonly TMessage[]): Promise<void>;
}

export interface EmailAttachment {
  readonly filename: string;
  readonly content: string;
  readonly contentType: string;
}

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly attachments?: readonly EmailAttachment[];
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

/** Injected so anything time-dependent stays testable at a fixed instant. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock frozen at one instant, for tests. */
export function fixedClock(at: Date): Clock {
  return { now: () => new Date(at.getTime()) };
}

// ─── Queue message shapes ─────────────────────────────────────────────────────────

/** S3 ObjectCreated → SQS `ingestion` → the ingestion worker (T1.11). */
export interface IngestionMessage {
  readonly jobId: string;
  readonly merchantId: string;
  readonly s3Key: string;
}

/** One message per product, enqueued after a successful import (T1.13). */
export interface EnrichmentMessage {
  readonly productId: string;
  readonly merchantId: string;
}

/** Emitted after enrichment, and directly on a manual edit (T1.15). */
export interface EmbeddingMessage {
  readonly productId: string;
  readonly merchantId: string;
  readonly reason: 'ingested' | 'enriched' | 'edited';
}

// ─── Search-path ports (T1.19, T1.20) ─────────────────────────────────────────────

/**
 * Caches a query's embedding by hash, so a repeated question does not pay Bedrock twice.
 *
 * Deliberately not the same interface as the image cache in `@catalograil/embeddings`:
 * that one caches by URL and tolerates a negative result, this one is keyed by the hash of
 * the query text and never stores a miss.
 */
export interface QueryEmbeddingCache {
  get(queryHash: string): Promise<number[] | undefined>;
  set(queryHash: string, vector: readonly number[]): Promise<void>;
}

/** Per-stage timings, so a slow search can be attributed rather than guessed at. */
export interface SearchStageLatencies {
  readonly embedMs: number;
  readonly queryMs: number;
  readonly rerankMs: number;
  readonly hydrateMs: number;
  readonly totalMs: number;
}

export interface SearchLogEntry {
  readonly searchId: string;
  readonly at: Date;
  readonly query?: string;
  readonly hasImage: boolean;
  readonly filters: Record<string, unknown>;
  /** Whether the query embedding came from cache. The cost signal worth watching. */
  readonly embeddingCacheHit: boolean;
  /** Unit ids in the order returned, so ranking can be replayed and scored later. */
  readonly resultIds: string[];
  readonly resultCount: number;
  readonly noResultsReason?: string;
  readonly latencies: SearchStageLatencies;
  readonly source: string;
  readonly sessionId?: string;
}

/**
 * T1.20. Every search is written here — this is both the only debugging tool for ranking
 * and the training set for the learned re-ranker in T4.3, so a search that is not logged
 * is a search that cannot be improved on later.
 */
export interface SearchLogger {
  log(entry: SearchLogEntry): Promise<void>;
}
