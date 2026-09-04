import { Logger } from '@aws-lambda-powertools/logger';
import {
  AppError,
  systemClock,
  type EnrichmentMessage,
  type IngestionMessage,
} from '@catalograil/core';
import { getDb } from '@catalograil/db';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { S3ObjectStore, SesMailer, SqsQueue } from '@catalograil/aws';
import { runIngestion, type IngestionDeps } from './ingest.js';

const logger = new Logger({ serviceName: 'ingestion-worker' });

/** Built once per execution environment; the DB connection is reused across invocations. */
let cached: IngestionDeps | undefined;

function deps(): IngestionDeps {
  if (!cached) {
    cached = {
      db: getDb(),
      objectStore: new S3ObjectStore(required('S3_BUCKET_UPLOADS')),
      enrichmentQueue: new SqsQueue<EnrichmentMessage>(required('SQS_QUEUE_ENRICHMENT')),
      mailer: new SesMailer(required('SES_FROM_ADDRESS')),
      clock: systemClock,
    };
  }
  return cached;
}

/**
 * SQS consumer for the `ingestion` queue.
 *
 * Reports partial batch failures rather than throwing, so one poisoned message does not
 * send its nine healthy neighbours back to the queue and eventually to the DLQ with it.
 * Requires `ReportBatchItemFailures` on the event source mapping (T1.4).
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const correlationId = record.messageId;
    logger.appendKeys({ correlationId });

    try {
      const message = parseMessage(record);
      logger.info('Starting ingestion', { jobId: message.jobId, merchantId: message.merchantId });

      const outcome = await runIngestion(message, deps());

      logger.info('Ingestion finished', {
        jobId: outcome.jobId,
        status: outcome.status,
        rowsImported: outcome.rowsImported,
        rowsFailed: outcome.rowsFailed,
        skipped: outcome.skipped ?? false,
      });
    } catch (err) {
      const appError = AppError.from(err);
      logger.error('Ingestion failed', { code: appError.code, message: appError.message });
      // A non-retryable error would only fail again; let it go to the DLQ immediately.
      if (appError.retryable) batchItemFailures.push({ itemIdentifier: record.messageId });
    } finally {
      logger.removeKeys(['correlationId']);
    }
  }

  return { batchItemFailures };
}

function parseMessage(record: SQSRecord): IngestionMessage {
  let body: unknown;
  try {
    body = JSON.parse(record.body);
  } catch {
    throw new AppError('INGESTION_FAILED', 'Message body is not JSON.', { retryable: false });
  }

  const { jobId, merchantId, s3Key } = (body ?? {}) as Partial<IngestionMessage>;
  if (!jobId || !merchantId || !s3Key) {
    throw new AppError('INGESTION_FAILED', 'Message is missing jobId, merchantId or s3Key.', {
      retryable: false,
      details: { body },
    });
  }
  return { jobId, merchantId, s3Key };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new AppError('DEPENDENCY_UNAVAILABLE', `Missing env var ${name}`);
  return value;
}
