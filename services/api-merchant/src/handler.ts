import { Logger } from '@aws-lambda-powertools/logger';
import { AppError, requireMerchant, systemClock } from '@catalograil/core';
import { getDb } from '@catalograil/db';
import { S3ObjectStore } from '@catalograil/aws';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createUpload, getTemplate, type UploadDeps } from './handlers/uploads.js';
import { deepHealth, shallowHealth } from './handlers/health.js';
import { getProduct, listIngestionJobs, listProducts } from './handlers/lists.js';
import {
  connectPaymentConfig,
  disconnectPaymentConfig,
  readPaymentConfig,
  testWebhook,
  webhookUrlFor,
  type PaymentConfigDeps,
} from './handlers/payment-config.js';
import {
  ClaudePolicyExtractor,
  HttpPolicyFetcher,
  KmsTokenCipher,
} from '@catalograil/razorpay';
import { submitPolicies, type PolicyDeps } from './handlers/onboarding.js';
import {
  catalogueSummary,
  getPipelineStatus,
  retryAllFailed,
  retryProducts,
} from './handlers/pipeline.js';
import { listInventory, updateStock } from './handlers/inventory.js';
import { getOrder, listOrders, orderSummary, transitionOrder } from './handlers/orders.js';
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
 * Every route below `/merchant` is authenticated by the merchant Cognito pool's JWT
 * authorizer at the gateway, and the caller's identity comes from the validated claim
 * rather than from anything in the request. That matters most for `POST /merchant/uploads`,
 * which derives an S3 prefix from the merchant id: a client-supplied id there would let
 * any caller write into any merchant's prefix.
 *
 * `/health` is the one unauthenticated route, and it deliberately returns nothing that
 * belongs to anybody.
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

    // ── Pipeline status and retry (Block E) ─────────────────────────────────────

    if (method === 'GET' && path === '/merchant/summary') {
      const merchantId = requireMerchantId(event);
      const [catalogue, orderCounts] = await Promise.all([
        catalogueSummary(deps().db, merchantId),
        orderSummary(deps().db, merchantId),
      ]);
      return json(200, { catalogue, orders: orderCounts });
    }

    const statusMatch = /^\/merchant\/products\/([0-9a-fA-F-]{36})\/status$/.exec(path);
    if (method === 'GET' && statusMatch) {
      return json(
        200,
        await getPipelineStatus(deps().db, requireMerchantId(event), statusMatch[1]!),
      );
    }

    if (method === 'POST' && path === '/merchant/products/retry') {
      const merchantId = requireMerchantId(event);
      const body = parseBody(event) as { productIds?: string[]; all?: boolean };
      const result = body.all
        ? await retryAllFailed(productDeps(), merchantId)
        : await retryProducts(productDeps(), merchantId, body.productIds ?? []);
      return json(200, result);
    }

    // ── Inventory (Block F) ─────────────────────────────────────────────────────

    if (method === 'GET' && path === '/merchant/inventory') {
      const q = event.queryStringParameters ?? {};
      return json(
        200,
        await listInventory(deps().db, requireMerchantId(event), {
          ...(q.lowStockBelow ? { lowStockBelow: Number(q.lowStockBelow) } : {}),
          ...(q.outOfStockOnly === 'true' ? { outOfStockOnly: true } : {}),
        }),
      );
    }

    if (method === 'POST' && path === '/merchant/inventory') {
      return json(
        200,
        await updateStock(
          { db: deps().db, clock: systemClock },
          requireMerchantId(event),
          parseBody(event),
        ),
      );
    }

    // ── Orders (Block F) ────────────────────────────────────────────────────────

    if (method === 'GET' && path === '/merchant/orders') {
      const q = event.queryStringParameters ?? {};
      return json(
        200,
        await listOrders(deps().db, requireMerchantId(event), {
          ...(q.status ? { status: q.status } : {}),
        }),
      );
    }

    const orderMatch = /^\/merchant\/orders\/([0-9a-fA-F-]{36})$/.exec(path);
    if (orderMatch) {
      const merchantId = requireMerchantId(event);
      if (method === 'GET') {
        return json(200, await getOrder(deps().db, merchantId, orderMatch[1]!));
      }
      if (method === 'PATCH') {
        return json(
          200,
          await transitionOrder(
            { db: deps().db, clock: systemClock },
            merchantId,
            orderMatch[1]!,
            parseBody(event),
          ),
        );
      }
    }

    // ── Policies (T1.9) ─────────────────────────────────────────────────────────

    if (method === 'POST' && path === '/merchant/policies') {
      /**
       * The last gate before a merchant goes active.
       *
       * The three URLs are fetched and summarised here rather than trusted, because rule 4
       * snapshots the summary onto every order — a policy we never read is a contract we
       * cannot show a buyer later.
       */
      return json(200, await submitPolicies(policyDeps(), requireMerchantId(event), parseBody(event)));
    }

    // ── Razorpay connection (Block C) ───────────────────────────────────────────

    if (path === '/merchant/payment-config') {
      const merchantId = requireMerchantId(event);

      if (method === 'GET') {
        const config = await readPaymentConfig(deps().db, merchantId);
        return json(200, {
          ...config,
          // The merchant needs this to register the webhook; it contains no secret.
          webhookUrl: webhookUrlFor(process.env.API_BASE_URL ?? '', merchantId),
        });
      }
      if (method === 'POST') {
        return json(200, await connectPaymentConfig(paymentDeps(), merchantId, parseBody(event)));
      }
      if (method === 'DELETE') {
        return json(200, await disconnectPaymentConfig(paymentDeps(), merchantId));
      }
    }

    if (method === 'POST' && path === '/merchant/payment-config/test-webhook') {
      return json(200, await testWebhook(paymentDeps(), requireMerchantId(event)));
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

let cachedPolicyDeps: PolicyDeps | undefined;

/**
 * Policy dependencies.
 *
 * Deliberately narrower than the onboarding set: policies have nothing to do with Razorpay
 * OAuth, and requiring that config was why this endpoint went unrouted long after the
 * handler behind it was written and tested. The extractor reaches Claude through the
 * Lambda's own IAM role on Bedrock — there is no Anthropic key anywhere in this system.
 */
function policyDeps(): PolicyDeps {
  if (!cachedPolicyDeps) {
    cachedPolicyDeps = {
      db: getDb(),
      policyFetcher: new HttpPolicyFetcher(),
      policyExtractor: new ClaudePolicyExtractor(),
      clock: systemClock,
    };
  }
  return cachedPolicyDeps;
}

let cachedPaymentDeps: Omit<PaymentConfigDeps, 'cipherFor'> | undefined;

/**
 * Payment dependencies, with a cipher built per merchant.
 *
 * `KmsTokenCipher` binds the merchant id as KMS encryption context, so a ciphertext
 * encrypted for one merchant cannot be decrypted while claiming to be another — swapping
 * rows fails loudly instead of handing over someone else's credentials. That binding is
 * why the cipher is a factory rather than a singleton.
 */
function paymentDeps(): PaymentConfigDeps {
  if (!cachedPaymentDeps) {
    cachedPaymentDeps = {
      db: getDb(),
      clock: systemClock,
      stage: process.env.STAGE ?? 'dev',
    };
  }
  const keyId = required('KMS_TOKEN_KEY_ID');
  return { ...cachedPaymentDeps, cipherFor: (id) => new KmsTokenCipher(keyId, id) };
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

/**
 * The merchant this request is for, from the verified JWT claim.
 *
 * This used to read `x-merchant-id` from the headers. Any caller past the gateway could
 * act as any merchant by editing one value — horizontal privilege escalation whose only
 * mitigation was that IAM authorization kept browsers out entirely, which is also why the
 * dashboards could not work. The claim is validated by API Gateway before this Lambda
 * runs, and `requireMerchant` never consults the request for an identity.
 */
function requireMerchantId(event: APIGatewayProxyEventV2): string {
  return requireMerchant(event as never).id;
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
