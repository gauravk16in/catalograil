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

/**
 * No API key to resolve.
 *
 * Enrichment runs Claude on Bedrock, so it authenticates with the Lambda's own IAM role —
 * the same credential that reaches the embedding models. There is no Anthropic key to
 * store, rotate, or accidentally log, and one fewer secret is one fewer thing to get wrong.
 */
function deps(): EnrichmentDeps {
  if (!cached) {
    cached = {
      db: getDb(),
      model: new ClaudeEnrichmentModel({
        ...(process.env.BEDROCK_REGION ? { region: process.env.BEDROCK_REGION } : {}),
      }),
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
      deps(),
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
