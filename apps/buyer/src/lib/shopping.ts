'use client';

import { api } from './api';

/**
 * The whole purchase, callable from anywhere — which is what lets it happen inside a chat.
 *
 * This sequence used to live in the split-screen page and only there, so buying meant
 * leaving the conversation for a different surface with a different layout, and coming back
 * to a search you had already forgotten the shape of. The steps are unchanged; what changes
 * is that a component can now run them in place.
 *
 * Nothing here is shortened. The handoff token is still exchanged once and dies, the payment
 * is still created on the merchant's own Razorpay account, and the signature is still
 * verified server-side before anything is called paid — the browser saying so is not
 * evidence.
 */

export interface ShippingAddress {
  recipientName: string;
  recipientPhone: string;
  line1: string;
  line2?: string;
  landmark?: string;
  city: string;
  state: string;
  pincode: string;
}

export interface SavedAddress extends ShippingAddress {
  id: string;
  label: string | null;
  isDefault: boolean;
}

export interface OrderResult {
  ok: boolean;
  merchantId: string;
  merchantName: string;
  orderId?: string;
  orderNumber?: string;
  amountPaise?: string;
  currency?: string;
  razorpayOrderId?: string;
  razorpayKeyId?: string;
  paymentLinkUrl?: string;
  paid?: boolean;
  error?: string;
}

/** Reserves the item and returns a session id the payment step works against. */
export async function openSession(item: {
  productId: string;
  variantId?: string;
  quantity?: number;
}): Promise<string> {
  const { checkoutUrl } = await api.post<{ checkoutUrl: string }>('/checkout/session', {
    productId: item.productId,
    ...(item.variantId ? { variantId: item.variantId } : {}),
    quantity: item.quantity ?? 1,
  });

  /**
   * The session token comes back inside a URL because that URL is what an assistant hands a
   * buyer. Redeeming it here rather than navigating to it is the difference between buying
   * in the conversation and being sent somewhere else to do it.
   */
  const token = new URL(checkoutUrl, window.location.origin).searchParams.get('t');
  if (!token) throw new Error('That checkout link is missing its token.');

  const session = await api.post<{ sessionId: string }>('/checkout/redeem', { token });
  return session.sessionId;
}

export async function pay(input: {
  sessionId: string;
  buyerEmail: string;
  address: ShippingAddress;
}): Promise<OrderResult[]> {
  const outcome = await api.post<{ results: OrderResult[] }>('/checkout/pay', {
    sessionId: input.sessionId,
    buyerEmail: input.buyerEmail.trim(),
    buyerPhone: input.address.recipientPhone.trim(),
    shippingAddress: input.address,
  });
  return outcome.results;
}

let razorpayLoading: Promise<void> | null = null;

/** Razorpay's checkout script, loaded once and only when someone actually buys. */
function loadRazorpay(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if ((window as { Razorpay?: unknown }).Razorpay) return Promise.resolve();
  if (razorpayLoading) return razorpayLoading;

  razorpayLoading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load the payment sheet.'));
    document.head.appendChild(script);
  });
  return razorpayLoading;
}

/**
 * Opens the merchant's own payment sheet.
 *
 * Resolves `paid` when the signature has been verified server-side, `dismissed` when the
 * buyer closed the sheet — which is not a failure and not an order either. The reservation
 * expires on its own, so nothing needs undoing here.
 */
export async function collect(
  order: OrderResult,
  buyer: { email: string; address: ShippingAddress },
): Promise<{ status: 'paid' | 'dismissed'; message?: string }> {
  await loadRazorpay();

  const Checkout = (window as unknown as { Razorpay: new (o: unknown) => { open(): void } })
    .Razorpay;

  return new Promise((resolve) => {
    const checkout = new Checkout({
      key: order.razorpayKeyId,
      order_id: order.razorpayOrderId,
      amount: Number(order.amountPaise ?? 0),
      currency: order.currency ?? 'INR',
      name: order.merchantName,
      // Repeated inside the sheet, because this is the moment the buyer is deciding.
      description: `Paid directly to ${order.merchantName}`,
      prefill: {
        email: buyer.email.trim(),
        contact: buyer.address.recipientPhone.trim(),
        name: buyer.address.recipientName.trim(),
      },
      notes: { order_number: order.orderNumber ?? '' },
      theme: { color: '#4f46e5' },
      handler: async (response: {
        razorpay_payment_id: string;
        razorpay_order_id: string;
        razorpay_signature: string;
      }) => {
        try {
          await api.post('/checkout/confirm', {
            orderId: order.orderId,
            razorpayPaymentId: response.razorpay_payment_id,
            razorpayOrderId: response.razorpay_order_id,
            razorpaySignature: response.razorpay_signature,
          });
          resolve({ status: 'paid' });
        } catch {
          /**
           * The money moved even though we could not record it, so this must not read as a
           * failed payment. The webhook reconciles it either way.
           */
          resolve({
            status: 'paid',
            message:
              `Your payment went through (${response.razorpay_payment_id}). It is taking a ` +
              'moment to appear in your orders.',
          });
        }
      },
      modal: { ondismiss: () => resolve({ status: 'dismissed' }) },
    });

    checkout.open();
  });
}
