import { Logger } from '@aws-lambda-powertools/logger';
import { AppError, requireBuyer } from '@catalograil/core';
import { getDb, type Database } from '@catalograil/db';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  createAddress,
  deleteAddress,
  getProfile,
  listAddresses,
  listBuyerOrders,
  setDefaultAddress,
  updateProfile,
} from './handlers/profile.js';

const logger = new Logger({ serviceName: 'api-buyer' });

let cached: Database | undefined;
function db(): Database {
  if (!cached) cached = getDb();
  return cached;
}

/**
 * Buyer HTTP API.
 *
 * Every route here is behind the buyer pool's JWT authorizer, and the buyer's identity comes
 * from the validated claim rather than anything in the request.
 *
 * Note what is *not* here: search. Browsing is public (`POST /search`), because a buyer who
 * has to create an account before they can look at anything will not create an account.
 * Only the things that are personal — a profile, an address, an order history — require one.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  logger.appendKeys({ correlationId: event.requestContext.requestId });

  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath.replace(/\/+$/, '') || '/';
    const caller = requireBuyer(event as never);

    if (path === '/buyer/me') {
      if (method === 'GET') return json(200, await getProfile(db(), caller.id));
      if (method === 'PATCH') {
        return json(200, await updateProfile(db(), caller.id, parseBody(event)));
      }
    }

    if (path === '/buyer/addresses') {
      if (method === 'GET') return json(200, await listAddresses(db(), caller.id));
      if (method === 'POST') {
        return json(201, await createAddress(db(), caller.id, parseBody(event)));
      }
    }

    const addressMatch = /^\/buyer\/addresses\/([0-9a-fA-F-]{36})$/.exec(path);
    if (addressMatch) {
      if (method === 'PATCH') {
        return json(200, await setDefaultAddress(db(), caller.id, addressMatch[1]!));
      }
      if (method === 'DELETE') {
        return json(200, await deleteAddress(db(), caller.id, addressMatch[1]!));
      }
    }

    if (method === 'GET' && path === '/buyer/orders') {
      return json(200, await listBuyerOrders(db(), caller.id, caller.email ?? null));
    }

    return json(404, { code: 'NOT_FOUND', message: `No route for ${method} ${path}.` });
  } catch (err) {
    const appError = AppError.from(err);
    logger.error('Buyer request failed', {
      code: appError.code,
      errorMessage: appError.message,
      // The real cause, which AppError.from replaces with a generic sentence.
      cause: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
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
    throw new AppError('VALIDATION_FAILED', 'Request body is not valid JSON.');
  }
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  };
}
