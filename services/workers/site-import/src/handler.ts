import { Logger } from '@aws-lambda-powertools/logger';
import {
  AppError,
  systemClock,
  type EnrichmentMessage,
  type SiteImportMessage,
} from '@catalograil/core';
import { getDb } from '@catalograil/db';
import { SqsQueue } from '@catalograil/aws';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { createFetcher } from './fetcher.js';
import { runSlot, type SiteImportDeps } from './import.js';

const logger = new Logger({ serviceName: 'site-import-worker' });

let cached: SiteImportDeps | undefined;

function deps(): SiteImportDeps {
  if (!cached) {
    cached = {
      db: getDb(),
      fetch: createFetcher(),
      enrichmentQueue: new SqsQueue<EnrichmentMessage>(required('SQS_QUEUE_ENRICHMENT')),
      siteImportQueue: new SqsQueue<SiteImportMessage>(required('SQS_QUEUE_SITE_IMPORT')),
      clock: systemClock,
    };
  }
  return cached;
}

/**
 * SQS consumer for the `site-import` queue.
 *
 * Partial batch failures, like every other worker here: one merchant's unreachable site
 * must not send four healthy imports back to the queue with it.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const correlationId = record.messageId;
    logger.appendKeys({ correlationId });

    try {
      const message = parseMessage(record);
      logger.info('Importing a slot', {
        jobId: message.jobId,
        merchantId: message.merchantId,
        offset: message.offset,
      });

      const outcome = await runSlot(message, deps());

      logger.info('Slot finished', {
        jobId: outcome.jobId,
        method: outcome.method,
        found: outcome.found,
        created: outcome.created,
        updated: outcome.updated,
        done: outcome.done,
        skipped: outcome.skipped ?? false,
      });
    } catch (err) {
      const appError = AppError.from(err);
      logger.error('Site import slot failed', {
        code: appError.code,
        errorMessage: appError.message,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    } finally {
      logger.removeKeys(['correlationId']);
    }
  }

  return { batchItemFailures };
}

function parseMessage(record: SQSRecord): SiteImportMessage {
  const body = JSON.parse(record.body) as Partial<SiteImportMessage>;
  if (!body.jobId || !body.merchantId || !body.siteUrl) {
    throw new AppError('VALIDATION_FAILED', 'Site import message is missing fields.', {
      retryable: false,
    });
  }
  return {
    jobId: body.jobId,
    merchantId: body.merchantId,
    siteUrl: body.siteUrl,
    offset: body.offset ?? 0,
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}
