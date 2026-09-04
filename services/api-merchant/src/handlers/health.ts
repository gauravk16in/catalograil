import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Sql } from 'postgres';

/**
 * S1.5 — health, shallow and deep.
 *
 * This exists because of how the Phase 1 outage was diagnosed: the only way to ask "is the
 * API alive" was to make an IAM-signed call to a business route, which is useless when
 * auth is the thing that is broken. `/health` answers that with no dependencies at all.
 *
 * `/health/deep` checks each dependency separately and reports latency per dependency,
 * because "the API is slow" and "Aurora is resuming from zero ACU" need different
 * responses and only a per-dependency number tells them apart.
 *
 * Deliberately returns no catalogue data, no merchant data and no identifiers — that is
 * what makes it safe to leave unauthenticated, which is the whole point of it.
 */

export interface DependencyStatus {
  readonly name: string;
  readonly status: 'ok' | 'degraded' | 'down';
  readonly latencyMs: number;
  /** Present only when something is wrong; never contains credentials or identifiers. */
  readonly detail?: string;
}

export interface DeepHealth {
  readonly status: 'ok' | 'degraded' | 'down';
  readonly checkedAt: string;
  readonly dependencies: readonly DependencyStatus[];
}

export interface HealthDeps {
  readonly sql: Sql;
  readonly region: string;
  readonly queryCacheTable?: string;
  readonly uploadsBucket?: string;
  readonly enrichmentQueueUrl?: string;
  readonly embeddingModelId?: string;
}

/** A dependency that hangs must not hang the health check that reports it. */
const CHECK_TIMEOUT_MS = 4000;

export function shallowHealth(): { status: 'ok'; checkedAt: string } {
  return { status: 'ok', checkedAt: new Date().toISOString() };
}

export async function deepHealth(deps: HealthDeps): Promise<DeepHealth> {
  const checks = [
    check('aurora', () => pingAurora(deps.sql)),
    ...(deps.queryCacheTable
      ? [check('dynamodb', () => pingDynamo(deps.region, deps.queryCacheTable!))]
      : []),
    ...(deps.uploadsBucket ? [check('s3', () => pingS3(deps.region, deps.uploadsBucket!))] : []),
    ...(deps.enrichmentQueueUrl
      ? [check('sqs', () => pingSqs(deps.region, deps.enrichmentQueueUrl!))]
      : []),
    ...(deps.embeddingModelId
      ? [check('bedrock', () => pingBedrock(deps.region, deps.embeddingModelId!))]
      : []),
  ];

  // Run them concurrently: sequential checks would make the endpoint's own latency the sum
  // of every dependency's, which is exactly when you least want to wait for it.
  const dependencies = await Promise.all(checks);

  const status = dependencies.some((d) => d.status === 'down')
    ? 'down'
    : dependencies.some((d) => d.status === 'degraded')
      ? 'degraded'
      : 'ok';

  return { status, checkedAt: new Date().toISOString(), dependencies };
}

async function check(name: string, run: () => Promise<void>): Promise<DependencyStatus> {
  const started = Date.now();
  try {
    await withTimeout(run(), CHECK_TIMEOUT_MS);
    return { name, status: 'ok', latencyMs: Date.now() - started };
  } catch (err) {
    const latencyMs = Date.now() - started;
    return {
      name,
      // A timeout is reported as degraded rather than down: a cold Aurora Serverless v2
      // cluster resuming from zero ACU is slow and healthy, and calling that "down" would
      // page someone for a working system.
      status: latencyMs >= CHECK_TIMEOUT_MS ? 'degraded' : 'down',
      latencyMs,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms.`)), ms),
    ),
  ]);
}

async function pingAurora(sql: Sql): Promise<void> {
  // Through RDS Proxy with IAM auth, so this exercises the token, the network path and the
  // proxy — not merely whether a connection object exists.
  await sql`SELECT 1`;
}

async function pingDynamo(region: string, table: string): Promise<void> {
  await new DynamoDBClient({ region }).send(new DescribeTableCommand({ TableName: table }));
}

async function pingS3(region: string, bucket: string): Promise<void> {
  await new S3Client({ region }).send(new HeadBucketCommand({ Bucket: bucket }));
}

async function pingSqs(region: string, queueUrl: string): Promise<void> {
  await new SQSClient({ region }).send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
}

/**
 * Bedrock is checked with a real embedding call rather than a metadata read.
 *
 * Model access on Bedrock fails at invocation, not at listing: an account can see a model
 * it cannot call, which is exactly the failure that blocked this project for a day. Only
 * an invoke distinguishes them, and one short string is cheap.
 */
async function pingBedrock(region: string, modelId: string): Promise<void> {
  await new BedrockRuntimeClient({ region }).send(
    new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        texts: ['health'],
        input_type: 'search_query',
        embedding_types: ['int8'],
        output_dimension: 1024,
      }),
    }),
  );
}
