import { Logger } from '@aws-lambda-powertools/logger';
import { AppError, systemClock } from '@catalograil/core';
import { getDb } from '@catalograil/db';
import { S3ObjectStore } from '@catalograil/aws';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createUpload, getTemplate, type UploadDeps } from './handlers/uploads.js';

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
    const route = `${event.requestContext.http.method} ${event.rawPath}`;

    if (
      event.requestContext.http.method === 'GET' &&
      event.rawPath.startsWith('/merchant/uploads/templates/')
    ) {
      const name = event.rawPath.split('/').pop() ?? '';
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

    if (event.requestContext.http.method === 'POST' && event.rawPath === '/merchant/uploads') {
      const merchantId = requireMerchantId(event);
      const body = event.body ? JSON.parse(event.body) : {};
      const result = await createUpload(merchantId, body, deps());
      return json(201, result);
    }

    logger.info('No route matched', { route });
    return json(404, { code: 'NOT_FOUND', message: `No route for ${route}.` });
  } catch (err) {
    const appError = AppError.from(err);
    logger.error('Request failed', { code: appError.code, message: appError.message });
    return json(appError.httpStatus, appError.toJSON());
  } finally {
    logger.removeKeys(['correlationId']);
  }
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
