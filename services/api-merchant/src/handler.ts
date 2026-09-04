import { Logger } from '@aws-lambda-powertools/logger';
import { AppError, systemClock } from '@catalograil/core';
import { getDb } from '@catalograil/db';
import { S3ObjectStore } from '@catalograil/aws';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createUpload, getTemplate, type UploadDeps } from './handlers/uploads.js';
import { deepHealth, shallowHealth } from './handlers/health.js';
import { getProduct, listIngestionJobs, listProducts } from './handlers/lists.js';
import { getSession } from './handlers/session.js';
import {
  archiveProduct,
  createProduct,
  updateProduct,
  type ProductDeps,
} from './handlers/products.js';
import { SqsQueue } from '@catalograil/aws';
import { getSql } from '@catalograil/db';
import type { EnrichmentMessage } from '@catalograil/core';

const logger = new Logger({ serviceName: 'api-merchant' });

let cached: UploadDeps | undefined;

function deps(): UploadDeps {
  if (!cached) {
    cached = {
      db: getDb(),
      objectStore: new S3ObjectStore(required('S3_BUCKET_UPLOADS')),
      clock: systemClock,
    };
  }
  return cached;
}

/**
 * Merchant HTTP API.
 *
 * **The caller's merchant identity is not yet authenticated.** T1.6 replaces this with a
 * session derived from the Razorpay OAuth flow; until then the routes sit behind IAM
 * authorization at the gateway, because `uploadKey` derives an S3 prefix from the merchant
 * id — trusting a client-supplied one would let any caller write into any merchant's
 * prefix. The header read below is a development affordance behind that gate, not an
 * authentication mechanism, and the gateway is what makes it safe.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const correlationId = event.requestContext.requestId;
  logger.appendKeys({ correlationId });

  try {
    const method = event.requestContext.http.method;
    // Trailing slashes are normalised away: a route table that treats `/merchant/products`
    // and `/merchant/products/` as different endpoints produces 404s that look like bugs.
    const path = event.rawPath.replace(/\/+$/, '') || '/';
    const route = `${method} ${path}`;

    // ── Health, unauthenticated (S1.5) ──────────────────────────────────────────
    // Before anything that needs a merchant, because the whole point is to answer when
    // identity is what is broken.

    if (method === 'GET' && path === '/health') {
      return json(200, shallowHealth());
    }

    if (method === 'GET' && path === '/health/deep') {
      const health = await deepHealth({
        sql: getSql(),
        region: process.env.AWS_REGION ?? 'ap-south-1',
        ...(process.env.DDB_TABLE_QUERY_CACHE
          ? { queryCacheTable: process.env.DDB_TABLE_QUERY_CACHE }
          : {}),
        ...(process.env.S3_BUCKET_UPLOADS ? { uploadsBucket: process.env.S3_BUCKET_UPLOADS } : {}),
        ...(process.env.SQS_QUEUE_ENRICHMENT
          ? { enrichmentQueueUrl: process.env.SQS_QUEUE_ENRICHMENT }
          : {}),
        ...(process.env.BEDROCK_TEXT_EMBED_MODEL_ID
          ? { embeddingModelId: process.env.BEDROCK_TEXT_EMBED_MODEL_ID }
          : {}),
      });
      // 503 when a dependency is down, so an uptime check does not have to parse the body
      // to know. Degraded stays 200: a resuming Aurora cluster is slow, not broken.
      return json(health.status === 'down' ? 503 : 200, health);
    }

    // ── Templates, unauthenticated read of a static asset ───────────────────────

    if (method === 'GET' && path.startsWith('/merchant/uploads/templates/')) {
      const name = path.split('/').pop() ?? '';
      const template = getTemplate(name);
      return {
        statusCode: 200,
        headers: {
          'content-type': template.contentType,
          'content-disposition': `attachment; filename="${template.filename}"`,
        },
        body: template.body,
      };
    }

    // ── Merchant-scoped ─────────────────────────────────────────────────────────

    if (method === 'GET' && path === '/merchant/me') {
      return json(200, await getSession(deps().db, requireMerchantId(event)));
    }

    if (method === 'GET' && path === '/merchant/products') {
      const q = event.queryStringParameters ?? {};
      return json(
        200,
        await listProducts(deps().db, requireMerchantId(event), {
          ...(q.limit ? { limit: Number(q.limit) } : {}),
          ...(q.offset ? { offset: Number(q.offset) } : {}),
        }),
      );
    }

    if (method === 'POST' && path === '/merchant/products') {
      const merchantId = requireMerchantId(event);
      const result = await createProduct(productDeps(), merchantId, parseBody(event));
      return json(201, result);
    }

    const productMatch = /^\/merchant\/products\/([0-9a-fA-F-]{36})$/.exec(path);
    if (productMatch) {
      const merchantId = requireMerchantId(event);
      const productId = productMatch[1]!;

      if (method === 'GET') {
        const product = await getProduct(deps().db, merchantId, productId);
        if (!product) throw new AppError('NOT_FOUND', 'No such product.');
        return json(200, product);
      }
      if (method === 'PATCH') {
        return json(200, await updateProduct(productDeps(), merchantId, productId, parseBody(event)));
      }
      if (method === 'DELETE') {
        return json(200, await archiveProduct(productDeps(), merchantId, productId));
      }
    }

    if (method === 'GET' && path === '/merchant/uploads') {
      return json(200, await listIngestionJobs(deps().db, requireMerchantId(event)));
    }

    if (method === 'POST' && path === '/merchant/uploads') {
      const merchantId = requireMerchantId(event);
      const result = await createUpload(merchantId, parseBody(event), deps());
      return json(201, result);
    }

    logger.info('No route matched', { route });
    return json(404, { code: 'NOT_FOUND', message: `No route for ${route}.` });
  } catch (err) {
    const appError = AppError.from(err);
    logger.error('Request failed', {
      code: appError.code,
      errorMessage: appError.message,
      cause:
        appError.cause instanceof Error ? appError.cause.message : String(appError.cause ?? ''),
      stack: appError.cause instanceof Error ? appError.cause.stack : undefined,
    });
    return json(appError.httpStatus, appError.toJSON());
  } finally {
    logger.removeKeys(['correlationId']);
  }
}

function parseBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // A malformed body is the client's error, not a 500 — and saying so plainly saves a
    // round of "the API is down" when a form serialised badly.
    throw new AppError('VALIDATION_FAILED', 'Request body is not valid JSON.');
  }
}

let cachedProductDeps: ProductDeps | undefined;

/**
 * Product writes need the enrichment queue; reads do not.
 *
 * Built separately and lazily so a dashboard that only lists products never constructs an
 * SQS client, and so a missing queue URL fails the write rather than every request.
 */
function productDeps(): ProductDeps {
  if (!cachedProductDeps) {
    cachedProductDeps = {
      db: getDb(),
      enrichmentQueue: new SqsQueue<EnrichmentMessage>(required('SQS_QUEUE_ENRICHMENT')),
      clock: systemClock,
    };
  }
  return cachedProductDeps;
}

function requireMerchantId(event: APIGatewayProxyEventV2): string {
  const merchantId = event.headers['x-merchant-id'];
  if (!merchantId) {
    throw new AppError('UNAUTHENTICATED', 'No merchant session. (T1.6 replaces this header.)');
  }
  return merchantId;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    // bigint appears in nothing returned here, but a serialiser that throws on one is a
    // trap worth removing now rather than at the first checkout response.
    body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new AppError('DEPENDENCY_UNAVAILABLE', `Missing env var ${name}`);
  return value;
}
