import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Logger } from '@aws-lambda-powertools/logger';
import {
  AppError,
  systemClock,
  type EmbeddingMessage,
  type EnrichmentMessage,
} from '@catalograil/core';
import { SqsQueue } from '@catalograil/aws';
import { getDb } from '@catalograil/db';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { ClaudeEnrichmentModel } from './claude-model.js';
import { runEnrichment, type EnrichmentDeps } from './enrich.js';

const logger = new Logger({ serviceName: 'enrichment-worker' });

let cached: EnrichmentDeps | undefined;
const secrets = new SecretsManagerClient({});

/**
 * Resolves the Anthropic key once per execution environment.
 *
 * The key lives in Secrets Manager rather than a Lambda environment variable, because an
 * environment variable is visible to anyone who can describe the function. Resolved at
 * cold start and held in the closure, so a warm invocation costs nothing — fetching per
 * message would add a Secrets Manager round trip to every batch.
 */
async function resolveApiKey(): Promise<string | undefined> {
  const secretId = process.env.ANTHROPIC_API_KEY_SECRET;
  if (!secretId) return process.env.ANTHROPIC_API_KEY;

  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!result.SecretString) return undefined;

  // Tolerates both a bare string and a JSON secret with an `apiKey` field, since the AWS
  // console creates the latter by default and a mismatch here is a confusing failure.
  try {
    const parsed = JSON.parse(result.SecretString) as Record<string, string>;
    return parsed.apiKey ?? parsed.ANTHROPIC_API_KEY ?? result.SecretString;
  } catch {
    return result.SecretString;
  }
}

async function deps(): Promise<EnrichmentDeps> {
  if (!cached) {
    const apiKey = await resolveApiKey();
    cached = {
      db: getDb(),
      model: new ClaudeEnrichmentModel(apiKey ? { apiKey } : {}),
      embeddingQueue: new SqsQueue<EmbeddingMessage>(required('SQS_QUEUE_EMBEDDING')),
      clock: systemClock,
    };
  }
  return cached;
}

/**
 * SQS consumer for the `enrichment` queue (T1.13).
 *
 * The whole batch is handed to `runEnrichment` at once rather than looped over, because
 * batching is the point: the event source is configured to deliver up to 20 messages, and
 * those become one Claude call rather than twenty.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const messages: { record: SQSRecord; message: EnrichmentMessage }[] = [];
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      messages.push({ record, message: parseMessage(record) });
    } catch (err) {
      // A malformed message cannot be retried into validity; let it reach the DLQ.
      logger.error('Unparseable enrichment message', {
        code: AppError.from(err).code,
        errorMessage: AppError.from(err).message,
      });
    }
  }

  if (messages.length === 0) return { batchItemFailures };

  try {
    const outcome = await runEnrichment(
      messages.map((m) => m.message),
      await deps(),
    );

    logger.info('Enrichment finished', {
      requested: outcome.requested,
      enriched: outcome.enriched,
      failed: outcome.failed,
      categoriesCreated: outcome.categoriesCreated,
      categoriesPendingReview: outcome.categoriesPendingReview,
    });
  } catch (err) {
    const appError = AppError.from(err);
    logger.error('Enrichment failed', {
      code: appError.code,
      // `message` is reserved by Powertools and dropped silently.
      errorMessage: appError.message,
    });

    // The batch shares one model call, so a failure is a failure for all of them.
    if (appError.retryable) {
      batchItemFailures.push(...messages.map((m) => ({ itemIdentifier: m.record.messageId })));
    }
  }

  return { batchItemFailures };
}

function parseMessage(record: SQSRecord): EnrichmentMessage {
  const body = JSON.parse(record.body) as Partial<EnrichmentMessage>;
  if (!body.productId || !body.merchantId) {
    throw new AppError('ENRICHMENT_FAILED', 'Message is missing productId or merchantId.', {
      retryable: false,
    });
  }
  return { productId: body.productId, merchantId: body.merchantId };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new AppError('DEPENDENCY_UNAVAILABLE', `Missing env var ${name}`);
  return value;
}
