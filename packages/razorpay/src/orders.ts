import { AppError } from '@catalograil/core';
import type { RazorpayClient } from './client.js';
import type { Fetcher } from './verify.js';

/**
 * T2.15 — creating a payment on the **merchant's** Razorpay account.
 *
 * D4 and rule 14: the order object belongs to the merchant, created with their credentials,
 * and appears in their own dashboard. We never hold the funds and never create the order on
 * an account of ours. That is the whole commercial premise, so it is worth stating that
 * nothing in this file has a fallback to a platform account — if a merchant's credentials do
 * not work, the checkout fails and says so by name.
 */

export interface RazorpayOrderRequest {
  /** Paise. Razorpay's smallest unit, which is also ours (rule 13). */
  readonly amountPaise: bigint;
  readonly currency?: string;
  /** Our order number, so a merchant can match their dashboard to ours. */
  readonly receipt: string;
  readonly notes?: Record<string, string>;
}

export interface RazorpayOrder {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: string;
  readonly receipt: string;
}

const RAZORPAY_API = 'https://api.razorpay.com/v1';

export async function createRazorpayOrder(
  client: RazorpayClient,
  request: RazorpayOrderRequest,
  fetcher: Fetcher = fetch,
): Promise<RazorpayOrder> {
  if (request.amountPaise <= 0n) {
    throw new AppError('VALIDATION_FAILED', 'An order amount must be positive.');
  }

  /**
   * Razorpay's API takes a JSON number for the amount, and paise fit comfortably inside a
   * double up to ₹90 trillion — but the conversion happens here, at the boundary, and
   * nowhere else. Everything upstream stays bigint so no arithmetic is ever done on the
   * lossy form.
   */
  const amount = Number(request.amountPaise);

  let response: Response;
  try {
    response = await fetcher(`${RAZORPAY_API}/orders`, {
      method: 'POST',
      headers: {
        authorization: client.authHeader(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        amount,
        currency: request.currency ?? 'INR',
        receipt: request.receipt,
        // Notes travel to the merchant's dashboard, so they can reconcile without us.
        notes: { platform: 'catalograil', ...request.notes },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new AppError('PAYMENT_CREATE_FAILED', 'Could not reach Razorpay to create the order.', {
      cause: err,
      retryable: true,
    });
  }

  if (response.status === 401) {
    /**
     * Named as a credential problem, not a generic failure.
     *
     * The merchant's keys have stopped working, which is something only they can fix, and
     * T2.21 requires the buyer be told which merchant failed rather than that "payment
     * failed".
     */
    throw new AppError(
      'PAYMENT_CONFIG_INVALID',
      'This merchant’s Razorpay credentials were rejected.',
      { details: { merchantId: client.merchantId } },
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new AppError('PAYMENT_CREATE_FAILED', `Razorpay returned ${response.status}.`, {
      // Razorpay's error bodies name the field at fault, which is worth keeping — but
      // truncated, because they can be long and this ends up in a log.
      details: { merchantId: client.merchantId, body: body.slice(0, 400) },
      retryable: response.status >= 500,
    });
  }

  const order = (await response.json()) as RazorpayOrder;
  if (!order.id) {
    throw new AppError('PAYMENT_CREATE_FAILED', 'Razorpay returned no order id.');
  }
  return order;
}
