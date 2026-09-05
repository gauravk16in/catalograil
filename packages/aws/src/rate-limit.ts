import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { AppError } from '@catalograil/core';

/**
 * T2.8 — token buckets in DynamoDB.
 *
 * A fixed window rather than a sliding one, deliberately. A sliding window needs either a
 * list of timestamps per subject or a read-modify-write, and both cost more than the
 * protection is worth here: the thing being defended against is a script hammering the MCP
 * endpoint, not a caller who carefully bursts across a window boundary.
 *
 * The counter is a single atomic `ADD`, so concurrent Lambdas cannot race it — which
 * matters because the MCP server has no session affinity and every request may land on a
 * different container.
 */

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the window resets. Sent to the caller as `retry_after`. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(subject: string, action: string): Promise<RateLimitResult>;
}

export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

/** T2.8's numbers: searching is cheap and frequent, checkout is neither. */
export const RATE_LIMITS: Readonly<Record<string, RateLimitRule>> = {
  search: { limit: 30, windowSeconds: 60 },
  checkout: { limit: 10, windowSeconds: 3600 },
};

export class DynamoRateLimiter implements RateLimiter {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client?: DynamoDBClient,
  ) {
    this.client = DynamoDBDocumentClient.from(client ?? new DynamoDBClient({}));
  }

  async consume(subject: string, action: string): Promise<RateLimitResult> {
    const rule = RATE_LIMITS[action];
    if (!rule) throw new AppError('INTERNAL_ERROR', `No rate limit configured for "${action}".`);

    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % rule.windowSeconds);
    const resetAt = windowStart + rule.windowSeconds;

    const result = await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: `RL#${subject}`, sk: `WINDOW#${action}#${windowStart}` },
        UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
        ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          // The row expires with its window, so the table never accumulates history for a
          // decision that only concerns the next sixty seconds.
          ':ttl': resetAt + 60,
        },
        ReturnValues: 'UPDATED_NEW',
      }),
    );

    const used = Number(result.Attributes?.count ?? 1);

    return {
      allowed: used <= rule.limit,
      remaining: Math.max(rule.limit - used, 0),
      retryAfterSeconds: Math.max(resetAt - now, 1),
    };
  }
}

/**
 * Fails open when the limiter itself is broken.
 *
 * A DynamoDB outage should degrade abuse protection, not take the product down with it —
 * refusing every request because we cannot count them punishes every honest caller for a
 * problem none of them caused.
 *
 * `onError` is not optional in practice even though it is in the type. Failing open
 * *silently* means abuse protection can be off for weeks with every dashboard green, and the
 * only symptom is a bill. Whoever wires this should log it loudly.
 */
export function failOpen(
  limiter: RateLimiter,
  onError?: (err: unknown) => void,
): RateLimiter {
  return {
    async consume(subject, action) {
      try {
        return await limiter.consume(subject, action);
      } catch (err) {
        onError?.(err);
        return { allowed: true, remaining: 0, retryAfterSeconds: 0 };
      }
    },
  };
}

/** For tests and local runs. Counts in memory and forgets on restart. */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly counts = new Map<string, { count: number; resetAt: number }>();

  async consume(subject: string, action: string): Promise<RateLimitResult> {
    const rule = RATE_LIMITS[action] ?? { limit: 30, windowSeconds: 60 };
    const now = Math.floor(Date.now() / 1000);
    const key = `${subject}#${action}`;
    const existing = this.counts.get(key);

    if (!existing || existing.resetAt <= now) {
      this.counts.set(key, { count: 1, resetAt: now + rule.windowSeconds });
      return { allowed: true, remaining: rule.limit - 1, retryAfterSeconds: rule.windowSeconds };
    }

    existing.count += 1;
    return {
      allowed: existing.count <= rule.limit,
      remaining: Math.max(rule.limit - existing.count, 0),
      retryAfterSeconds: Math.max(existing.resetAt - now, 1),
    };
  }
}
