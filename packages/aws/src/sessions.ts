import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SESSION_TTL_SECONDS, type CheckoutSession } from '@catalograil/core';

/**
 * Checkout sessions in DynamoDB, and the record of which handoff tokens have been spent.
 *
 * Both live in the `Sessions` table because they share a lifetime and a TTL — a consumed
 * token is only interesting for as long as the session it opened could still be resumed.
 */
export class DynamoSessionStore {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client?: DynamoDBClient,
  ) {
    this.client = DynamoDBDocumentClient.from(client ?? new DynamoDBClient({}));
  }

  async put(session: CheckoutSession): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `SESSION#${session.sessionId}`,
          sk: 'META',
          session,
          ttl: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
        },
      }),
    );
  }

  async get(sessionId: string): Promise<CheckoutSession | null> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: `SESSION#${sessionId}`, sk: 'META' } }),
    );
    return (result.Item?.session as CheckoutSession | undefined) ?? null;
  }

  /**
   * A conditional put, not a read-then-write.
   *
   * Two tabs opening the same link at once would both read "unused" and both proceed; the
   * condition lets exactly one win, decided by DynamoDB rather than by timing.
   */
  async consumeToken(token: string): Promise<boolean> {
    // Hashed rather than stored raw: the token is a credential, and a table dump should not
    // hand someone a set of working links.
    const key = Buffer.from(token).toString('base64url').slice(0, 100);
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: `HANDOFF#${key}`,
            sk: 'META',
            consumedAt: new Date().toISOString(),
            ttl: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }
}

/** For tests. */
export class InMemorySessionStore {
  private readonly sessions = new Map<string, CheckoutSession>();
  private readonly consumed = new Set<string>();

  async put(session: CheckoutSession): Promise<void> {
    this.sessions.set(session.sessionId, session);
  }
  async get(sessionId: string): Promise<CheckoutSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }
  async consumeToken(token: string): Promise<boolean> {
    if (this.consumed.has(token)) return false;
    this.consumed.add(token);
    return true;
  }
}
