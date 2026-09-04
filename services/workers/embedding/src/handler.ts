import { Logger } from '@aws-lambda-powertools/logger';
import { AppError, systemClock, type EmbeddingMessage } from '@catalograil/core';
import { getDb } from '@catalograil/db';
import {
  BedrockEmbedder,
  HttpImageFetcher,
  InMemoryEmbeddingCache,
  createBedrockInvoker,
} from '@catalograil/embeddings';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { runEmbedding, type EmbeddingDeps } from './embed.js';

const logger = new Logger({ serviceName: 'embedding-worker' });

/**
 * Built once per execution environment.
 *
 * The image cache lives here rather than per invocation, so a warm Lambda processing a
 * merchant's catalogue in several batches embeds a shared photo once rather than once per
 * batch. It is deliberately in-memory and therefore per-environment: DynamoDB `QueryCache`
 * would survive cold starts, but an image embedding is cheap enough that a round trip to
 * fetch one costs more than recomputing it after a cold start.
 */
let cached: EmbeddingDeps | undefined;

function deps(): EmbeddingDeps {
  if (!cached) {
    cached = {
      db: getDb(),
      embedder: new BedrockEmbedder(createBedrockInvoker(process.env.BEDROCK_REGION), {
        ...(process.env.BEDROCK_TEXT_EMBED_MODEL_ID
          ? { textModelId: process.env.BEDROCK_TEXT_EMBED_MODEL_ID }
          : {}),
        ...(process.env.BEDROCK_IMAGE_EMBED_MODEL_ID
          ? { imageModelId: process.env.BEDROCK_IMAGE_EMBED_MODEL_ID }
          : {}),
      }),
      imageFetcher: new HttpImageFetcher(),
      imageCache: new InMemoryEmbeddingCache(),
      clock: systemClock,
    };
  }
  return cached;
}

/**
 * SQS consumer for the `embedding` queue.
 *
 * Partial batch failures, so one product that cannot be embedded does not drag its
 * neighbours to the DLQ with it. T1.15 asks for two retries before a unit is marked
 * `failed`; that is the event source mapping's `maxReceiveCount` of 3 doing the counting,
 * rather than a retry loop inside the handler holding a Lambda open while it sleeps.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    logger.appendKeys({ correlationId: record.messageId });

    try {
      const message = parseMessage(record);
      const outcome = await runEmbedding(message, deps());

      logger.info('Embedded product', {
        productId: outcome.productId,
        unitsTotal: outcome.unitsTotal,
        unitsEmbedded: outcome.unitsEmbedded,
        // Worth logging on every run: it is the number that says whether rule 9 is working.
        unitsSkipped: outcome.unitsSkipped,
        imagesFailed: outcome.imagesFailed,
      });
    } catch (err) {
      const appError = AppError.from(err);
      // Powertools drops a "message" field silently (it collides with the log
      // record's own message), which had been hiding every error detail here.
      logger.error('Embedding failed', { code: appError.code, errorMessage: appError.message });
      if (appError.retryable) batchItemFailures.push({ itemIdentifier: record.messageId });
    } finally {
      logger.removeKeys(['correlationId']);
    }
  }

  return { batchItemFailures };
}

function parseMessage(record: SQSRecord): EmbeddingMessage {
  let body: unknown;
  try {
    body = JSON.parse(record.body);
  } catch {
    throw new AppError('EMBEDDING_FAILED', 'Message body is not JSON.', { retryable: false });
  }

  const { productId, merchantId, reason } = (body ?? {}) as Partial<EmbeddingMessage>;
  if (!productId || !merchantId) {
    throw new AppError('EMBEDDING_FAILED', 'Message is missing productId or merchantId.', {
      retryable: false,
      details: { body },
    });
  }
  return { productId, merchantId, reason: reason ?? 'edited' };
}
