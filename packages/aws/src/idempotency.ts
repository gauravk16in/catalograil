import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Rule 2 — a conditional write, which is the only thing that makes a webhook idempotent
 * under concurrency.
 *
 * Reading first and then writing has a window: two deliveries of the same event arriving
 * together both read "not seen" and both proceed. A conditional put lets exactly one win,
 * decided by DynamoDB rather than by luck.
 */
export interface IdempotencyStore {
  claim(key: string): Promise<boolean>;
}

/** 48 hours, per §7 — comfortably longer than any retry schedule Razorpay uses. */
export const IDEMPOTENCY_TTL_SECONDS = 48 * 3600;

export class DynamoIdempotencyStore implements IdempotencyStore {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client?: DynamoDBClient,
  ) {
    this.client = DynamoDBDocumentClient.from(client ?? new DynamoDBClient({}));
  }

  async claim(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: `KEY#${key}`,
            sk: 'META',
            claimedAt: new Date().toISOString(),
            ttl: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      /**
       * Anything else rethrows rather than assuming "already seen".
       *
       * Swallowing a DynamoDB outage here would silently drop real payment events — the one
       * failure mode worse than processing one twice.
       */
      throw err;
    }
  }
}

/** For tests. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly seen = new Set<string>();
  async claim(key: string): Promise<boolean> {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}
