import { Logger } from '@aws-lambda-powertools/logger';
import { AppError, requireBuyer } from '@catalograil/core';
import { getDb, type Database } from '@catalograil/db';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoIdempotencyStore } from '@catalograil/aws';
import { KmsTokenCipher } from '@catalograil/razorpay';
import { systemClock } from '@catalograil/core';
import { handleRazorpayWebhook } from './handlers/webhook.js';
import { DynamoSessionStore } from '@catalograil/aws';
import {
  createCheckoutSession,
  redeemHandoffToken,
  updateSession,
  type SessionDeps,
} from './handlers/session.js';
import { createOrders } from './handlers/checkout.js';
import { confirmPayment } from './handlers/confirm.js';
import { KmsTokenCipher as Cipher } from '@catalograil/razorpay';
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
    /**
     * The webhook is handled before any identity is required.
     *
     * It is called by Razorpay, not by a buyer — there is no JWT and never will be. Its
     * authentication is the HMAC signature verified against the merchant's own secret,
     * which is stronger than a bearer token for this purpose because it also proves the
     * body was not altered in transit.
     */
    const webhookMatch = /^\/webhooks\/razorpay\/([0-9a-fA-F-]{36})$/.exec(path);
    if (method === 'POST' && webhookMatch) {
      const raw = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : (event.body ?? '');

      const result = await handleRazorpayWebhook(
        {
          db: db(),
          clock: systemClock,
          cipherFor: (id) => new KmsTokenCipher(required('KMS_TOKEN_KEY_ID'), id),
          idempotency: new DynamoIdempotencyStore(required('DDB_TABLE_IDEMPOTENCY')),
        },
        webhookMatch[1]!,
        raw,
        // Razorpay's header. Read case-insensitively because gateways normalise differently.
        event.headers['x-razorpay-signature'] ?? event.headers['X-Razorpay-Signature'],
      );

      // Always 200 on a handled or duplicate event: a non-2xx makes Razorpay retry, and a
      // duplicate is a success from their point of view.
      return json(200, result);
    }

    /**
     * Checkout routes, before identity is required.
     *
     * A guest checks out without an account (T2.21) — requiring one here would be the
     * clearest possible way to lose a buyer who has already chosen what they want. The
     * handoff token is what authorises these, and it is single-use.
     */
    if (method === 'POST' && path === '/checkout/session') {
      // Called by the MCP server over SigV4, not by a browser: it is how create_checkout
      // turns a tool call into a link.
      return json(201, await createCheckoutSession(sessionDeps(), parseBody(event) as never));
    }

    if (method === 'POST' && path === '/checkout/redeem') {
      const body = parseBody(event) as { token?: string };
      if (!body.token) throw new AppError('VALIDATION_FAILED', 'A token is required.');
      return json(200, await redeemHandoffToken(sessionDeps(), body.token));
    }

    const sessionMatch = /^\/checkout\/session\/([0-9a-fA-F-]{36})$/.exec(path);
    if (sessionMatch && method === 'PATCH') {
      return json(200, await updateSession(sessionDeps(), sessionMatch[1]!, parseBody(event) as never));
    }

    if (method === 'POST' && path === '/checkout/pay') {
      const body = parseBody(event) as {
        sessionId?: string;
        buyerEmail?: string;
        buyerPhone?: string;
        shippingAddress?: Record<string, unknown>;
      };
      if (!body.sessionId || !body.buyerEmail || !body.shippingAddress) {
        throw new AppError('VALIDATION_FAILED', 'Session, contact and address are all required.');
      }

      const session = await sessionDeps().sessions.get(body.sessionId);
      if (!session) throw new AppError('NOT_FOUND', 'No such checkout session.');

      return json(
        200,
        await createOrders(
          {
            db: db(),
            clock: systemClock,
            cipherFor: (id) => new Cipher(required('KMS_TOKEN_KEY_ID'), id),
          },
          {
            cart: session.cart,
            buyerEmail: body.buyerEmail,
            ...(body.buyerPhone ? { buyerPhone: body.buyerPhone } : {}),
            ...(session.buyerId ? { buyerId: session.buyerId } : {}),
            shippingAddress: body.shippingAddress,
            sessionId: body.sessionId,
            source: 'web',
          },
        ),
      );
    }

    /**
     * The browser's confirmation after Razorpay Checkout succeeds.
     *
     * Open at the gateway like the rest of `/checkout/*`, because a guest pays too. What
     * authorises it is Razorpay's own signature over `order_id|payment_id`, checked against
     * the merchant's key secret — a caller who merely knows an order id cannot forge it.
     */
    if (method === 'POST' && path === '/checkout/confirm') {
      const body = parseBody(event) as {
        orderId?: string;
        razorpayPaymentId?: string;
        razorpayOrderId?: string;
        razorpaySignature?: string;
      };
      if (!body.orderId || !body.razorpayPaymentId || !body.razorpayOrderId || !body.razorpaySignature) {
        throw new AppError('VALIDATION_FAILED', 'The payment confirmation is incomplete.');
      }
      return json(
        200,
        await confirmPayment(
          {
            db: db(),
            clock: systemClock,
            cipherFor: (id) => new Cipher(required('KMS_TOKEN_KEY_ID'), id),
          },
          {
            orderId: body.orderId,
            razorpayPaymentId: body.razorpayPaymentId,
            razorpayOrderId: body.razorpayOrderId,
            razorpaySignature: body.razorpaySignature,
          },
        ),
      );
    }

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

let cachedSessionDeps: SessionDeps | undefined;

function sessionDeps(): SessionDeps {
  if (!cachedSessionDeps) {
    cachedSessionDeps = {
      db: db(),
      sessions: new DynamoSessionStore(required('DDB_TABLE_SESSIONS')),
      clock: systemClock,
      handoffSecret: required('HANDOFF_TOKEN_SECRET'),
      buyerAppUrl: required('BUYER_APP_URL'),
    };
  }
  return cachedSessionDeps;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new AppError('INTERNAL_ERROR', `${name} is not set.`);
  return value;
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
