import { Logger } from '@aws-lambda-powertools/logger';
import { AppError, searchRequestSchema, systemClock } from '@catalograil/core';
import { DynamoQueryEmbeddingCache, DynamoSearchLogger } from '@catalograil/aws';
import { getSql } from '@catalograil/db';
import { BedrockEmbedder, HttpImageFetcher, createBedrockInvoker } from '@catalograil/embeddings';
import { runSearch, type SearchPipelineDeps } from '@catalograil/search';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const logger = new Logger({ serviceName: 'api-internal' });

/**
 * `POST /internal/search` (T1.19).
 *
 * Built once per execution environment. The database connection in particular has to
 * survive across invocations, or every request pays a fresh RDS Proxy handshake and the
 * 200ms p95 budget is gone before any work starts.
 */
let cached: SearchPipelineDeps | undefined;

function deps(): SearchPipelineDeps {
  if (!cached) {
    cached = {
      sql: getSql(),
      embedder: new BedrockEmbedder(createBedrockInvoker(process.env.BEDROCK_REGION), {
        ...(process.env.BEDROCK_TEXT_EMBED_MODEL_ID
          ? { textModelId: process.env.BEDROCK_TEXT_EMBED_MODEL_ID }
          : {}),
        ...(process.env.BEDROCK_IMAGE_EMBED_MODEL_ID
          ? { imageModelId: process.env.BEDROCK_IMAGE_EMBED_MODEL_ID }
          : {}),
      }),
      queryCache: new DynamoQueryEmbeddingCache(required('DDB_TABLE_QUERY_CACHE')),
      searchLogger: new DynamoSearchLogger(required('DDB_TABLE_SEARCH_LOGS')),
      imageFetcher: new HttpImageFetcher(),
      clock: systemClock,
    };
  }
  return cached;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  logger.appendKeys({ correlationId: event.requestContext.requestId });

  try {
    /**
     * Three paths, one implementation.
     *
     * `/internal/search` is SigV4 for machine callers; `/merchant/search-preview` carries a
     * merchant JWT and powers "Preview in AI"; `/buyer/search` carries a buyer JWT. They
     * deliberately share this handler — a preview that ranked differently from the real
     * search would be worse than no preview, and two copies of the query is how that
     * happens. The gateway decides who may call which; this only decides what search means.
     */
    const path = event.rawPath.replace(/\/+$/, '');
    const isSearchRoute =
      path.endsWith('/internal/search') ||
      path.endsWith('/merchant/search-preview') ||
      path.endsWith('/buyer/search');

    if (event.requestContext.http.method !== 'POST' || !isSearchRoute) {
      return json(404, { code: 'NOT_FOUND', message: `No route for ${event.rawPath}.` });
    }

    const parsed = searchRequestSchema.safeParse(event.body ? JSON.parse(event.body) : {});
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', 'The search request is not valid.', {
        details: { issues: parsed.error.issues },
      });
    }

    const response = await runSearch(parsed.data, deps());

    logger.info('Search completed', {
      searchId: response.searchId,
      resultCount: response.results.length,
      tookMs: response.tookMs,
    });

    return json(200, response);
  } catch (err) {
    const appError = AppError.from(err);
    logger.error('Search failed', {
      code: appError.code,
      // `message` is a reserved Powertools key and is dropped silently if used.
      errorMessage: appError.message,
      cause: appError.cause instanceof Error ? appError.cause.message : undefined,
    });
    return json(appError.httpStatus, appError.toJSON());
  } finally {
    logger.removeKeys(['correlationId']);
  }
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    // Paise are bigint throughout; a plain stringify would throw on the first priced result.
    body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new AppError('DEPENDENCY_UNAVAILABLE', `Missing env var ${name}`);
  return value;
}
