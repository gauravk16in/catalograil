import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { QueryEmbeddingCache, SearchLogEntry, SearchLogger } from '@catalograil/core';

/**
 * The DynamoDB-backed halves of the search path (T1.19, T1.20).
 *
 * Both tables are declared with a `ttl` attribute in the data stack, so nothing here has to
 * clean up after itself — expiry is the table's job, and these only ever write.
 */

const documentClient = (client?: DynamoDBClient): DynamoDBDocumentClient =>
  DynamoDBDocumentClient.from(client ?? new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

/** Context §7: `QueryCache`, keyed `Q#<queryHash>` / `META`, 24h TTL. */
const QUERY_CACHE_TTL_SECONDS = 24 * 60 * 60;

export class DynamoQueryEmbeddingCache implements QueryEmbeddingCache {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client?: DynamoDBClient,
  ) {
    this.client = documentClient(client);
  }

  async get(queryHash: string): Promise<number[] | undefined> {
    try {
      const result = await this.client.send(
        new GetCommand({ TableName: this.tableName, Key: { pk: `Q#${queryHash}`, sk: 'META' } }),
      );
      const vector = result.Item?.vector as number[] | undefined;
      return Array.isArray(vector) ? vector : undefined;
    } catch {
      /**
       * A cache that cannot be read is a slower search, not a failed one. Swallowing here
       * rather than at the call site keeps that decision in one place — the pipeline treats
       * a miss and an outage identically, which is what makes the cache genuinely optional.
       */
      return undefined;
    }
  }

  async set(queryHash: string, vector: readonly number[]): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `Q#${queryHash}`,
          sk: 'META',
          vector: [...vector],
          ttl: Math.floor(Date.now() / 1000) + QUERY_CACHE_TTL_SECONDS,
        },
      }),
    );
  }
}

/** Context §7: `SearchLogs`, keyed `DAY#<yyyy-mm-dd>` / `TS#<ts>#<id>`, 90d TTL. */
const SEARCH_LOG_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * T1.20.
 *
 * The partition key is the day and the sort key is the timestamp, which is what makes
 * "every search on this date, in order" a single cheap query — the shape the ranking work
 * in Phase 4 needs, and the reason the key is not simply the search id.
 */
export class DynamoSearchLogger implements SearchLogger {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client?: DynamoDBClient,
  ) {
    this.client = documentClient(client);
  }

  async log(entry: SearchLogEntry): Promise<void> {
    const at = entry.at;
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `DAY#${at.toISOString().slice(0, 10)}`,
          sk: `TS#${at.toISOString()}#${entry.searchId}`,
          searchId: entry.searchId,
          query: entry.query,
          hasImage: entry.hasImage,
          filters: entry.filters,
          embeddingCacheHit: entry.embeddingCacheHit,
          resultIds: entry.resultIds,
          resultCount: entry.resultCount,
          noResultsReason: entry.noResultsReason,
          latencies: entry.latencies,
          source: entry.source,
          sessionId: entry.sessionId,
          ttl: Math.floor(at.getTime() / 1000) + SEARCH_LOG_TTL_SECONDS,
        },
      }),
    );
  }

  /** Reads a day back, newest first. The acceptance check for T1.20, and the debugging tool. */
  async listForDay(day: string, limit = 100): Promise<SearchLogEntry[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `DAY#${day}` },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );

    return (result.Items ?? []).map((item) => ({
      searchId: item.searchId as string,
      at: new Date(String(item.sk).split('#')[1]!),
      query: item.query as string | undefined,
      hasImage: Boolean(item.hasImage),
      filters: (item.filters ?? {}) as Record<string, unknown>,
      embeddingCacheHit: Boolean(item.embeddingCacheHit),
      resultIds: (item.resultIds ?? []) as string[],
      resultCount: Number(item.resultCount ?? 0),
      noResultsReason: item.noResultsReason as string | undefined,
      latencies: item.latencies as SearchLogEntry['latencies'],
      source: item.source as string,
      sessionId: item.sessionId as string | undefined,
    }));
  }
}

// ─── In-memory equivalents, for tests ─────────────────────────────────────────────

export class InMemoryQueryEmbeddingCache implements QueryEmbeddingCache {
  private readonly entries = new Map<string, number[]>();
  hits = 0;
  misses = 0;

  async get(queryHash: string): Promise<number[] | undefined> {
    const hit = this.entries.get(queryHash);
    if (hit) this.hits++;
    else this.misses++;
    return hit;
  }

  async set(queryHash: string, vector: readonly number[]): Promise<void> {
    this.entries.set(queryHash, [...vector]);
  }
}

export class InMemorySearchLogger implements SearchLogger {
  readonly entries: SearchLogEntry[] = [];

  async log(entry: SearchLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}
