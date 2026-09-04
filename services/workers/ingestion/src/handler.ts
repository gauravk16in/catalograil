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
      // Powertools drops a "message" field silently (it collides with the log
      // record's own message), which had been hiding every error detail here.
      logger.error('Ingestion failed', { code: appError.code, errorMessage: appError.message });
      // A non-retryable error would only fail again; let it go to the DLQ immediately.
      if (appError.retryable) batchItemFailures.push({ itemIdentifier: record.messageId });
    } finally {
      logger.removeKeys(['correlationId']);
    }
  }

  return { batchItemFailures };
}

/**
 * The message on the `ingestion` queue is S3's native `ObjectCreated` event notification,
 * not a shape this service controls — `bucket.addEventNotification` in the data stack
 * wires S3 straight to SQS, and S3's notification schema (`Records[].s3.object.key`) is
 * what actually arrives. `IngestionMessage` as defined in `@catalograil/core` describes
 * what the worker needs, not what is on the wire; this function is the translation between
 * the two, and it is the whole reason a custom message shape doesn't just work here.
 *
 * `jobId` and `merchantId` are not in the S3 event at all. They come out of the object key
 * instead, via the same `uploads/{merchantId}/{jobId}.csv` convention the upload endpoint
 * uses to name the object (see `uploadKey` in services/api-merchant) — the two must agree,
 * and this is the other half of that agreement.
 */
function parseMessage(record: SQSRecord): IngestionMessage {
  let event: unknown;
  try {
    event = JSON.parse(record.body);
  } catch {
    throw new AppError('INGESTION_FAILED', 'Message body is not JSON.', { retryable: false });
  }

  const s3Record = (event as { Records?: { s3?: { object?: { key?: string } } }[] })?.Records?.[0]
    ?.s3;
  const encodedKey = s3Record?.object?.key;
  if (!encodedKey) {
    throw new AppError('INGESTION_FAILED', 'Not an S3 ObjectCreated notification.', {
      retryable: false,
      details: { event },
    });
  }

  // S3 event keys are URL-encoded, and a `+` in one represents a literal space.
  const key = decodeURIComponent(encodedKey.replace(/\+/g, ' '));
  const match = /^uploads\/([^/]+)\/([^/]+)\.csv$/.exec(key);
  if (!match) {
    throw new AppError(
      'INGESTION_FAILED',
      `Object key does not match the upload convention: "${key}".`,
      {
        retryable: false,
        details: { key },
      },
    );
  }

  const [, merchantId, jobId] = match;
  return { jobId: jobId!, merchantId: merchantId!, s3Key: key };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new AppError('DEPENDENCY_UNAVAILABLE', `Missing env var ${name}`);
  return value;
}
