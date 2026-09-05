'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { api, describeError } from '../../lib/api';
import { formatPaise } from '../../lib/format';
import { Badge, Button, Card, ErrorNote, Field, inputClass } from '../../components/ui';
import { useAuth } from '../../lib/auth';

/**
 * T2.19–T2.22 — the split-screen checkout surface.
 *
 * A buyer arrives here from a conversation, mid-decision. Two things follow from that and
 * shape the whole page:
 *
 * **They have already explained themselves.** The handoff context carries their original
 * question and the shortlist that produced this product, and it is shown back to them —
 * being asked "what are you looking for?" one screen after answering it is the moment a
 * handoff stops feeling like one product.
 *
 * **They have not agreed to anything yet.** So the page leads with what they are buying and
 * from whom, and says plainly that the money goes to the merchant. That notice is required
 * on every checkout (T2.22) and it is also the single most surprising true thing about this
 * product.
 */

interface CartItem {
  productId: string;
  variantId?: string;
  quantity: number;
  merchantId: string;
  priceSnapshot: string;
}

interface Session {
  sessionId: string;
  expiresAt: string;
  cart: CartItem[];
  handoffContext: { originalQuery?: string; conversationSummary?: string; shortlist?: string[] };
  guestContact?: { email?: string };
}

interface Product {
  id: string;
  name: string;
  brand: string | null;
  description: string | null;
  images: string[];
  variants: { id: string; options: Record<string, string>; price_paise: string | null; availability: string }[];
  merchant: { id: string; name: string; trust: { score: number; new_merchant: boolean; signals: string[] } };
  policies?: {
    refund?: { summary: string | null; url: string };
    return_window_days: number | null;
    dispatch_sla_hours: number | null;
  } | null;
}

interface SavedAddress {
  id: string;
  label: string | null;
  recipientName: string;
  recipientPhone: string;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  pincode: string;
  isDefault: boolean;
}

interface OrderResult {
  merchantId: string;
  merchantName: string;
  ok: boolean;
  orderId?: string;
  orderNumber?: string;
  razorpayOrderId?: string;
  /** The merchant's publishable key. The widget cannot open without it. */
  razorpayKeyId?: string;
  amountPaise?: string;
  currency?: string;
  error?: string;
}

/**
 * Razorpay's checkout script, loaded on demand.
 *
 * Not in the page head: it is only needed at the moment of payment, and a buyer who browses
 * and leaves should not have paid for it. Loaded once and reused if they retry.
 */
async function loadRazorpay(): Promise<void> {
  if (typeof window === 'undefined') return;
  if ((window as { Razorpay?: unknown }).Razorpay) return;

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load the payment page.'));
    document.body.appendChild(script);
  });
}

const EMPTY_ADDRESS = {
  recipientName: '',
  recipientPhone: '',
  line1: '',
  city: '',
  state: '',
  pincode: '',
};

/**
 * The token travels as a query parameter, not a path segment.
 *
 * The doc specifies `/s/[token]`, and a dynamic segment cannot be statically exported —
 * Next needs every value enumerated at build time through `generateStaticParams`, and
 * handoff tokens are unbounded by construction. The alternatives were to give this app a
 * Node runtime for one route, or to move the token into the query string. The second costs
 * nothing: it is the same length, the same single-use credential, and it expires in fifteen
 * minutes either way.
 */
function Checkout() {
  const token = useSearchParams().get('t') ?? '';
  const { status } = useAuth();
  const [session, setSession] = useState<Session | null>(null);
  const [saved, setSaved] = useState<SavedAddress[]>([]);
  const [chosenAddressId, setChosenAddressId] = useState<string | null>(null);
  const [enteringNew, setEnteringNew] = useState(false);
  const [product, setProduct] = useState<Product | null>(null);
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState({ ...EMPTY_ADDRESS });
  const [results, setResults] = useState<OrderResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  const redeem = useCallback(async () => {
    try {
      /**
       * The token is exchanged once, on load, and is dead afterwards (T2.14).
       *
       * It stays in the URL bar, the browser history and the chat transcript — so the only
       * thing that keeps it from being a resumable session for anyone with the scrollback
       * is that the second exchange fails.
       */
      const redeemed = await api.post<Session>('/checkout/redeem', { token });
      setSession(redeemed);
      if (redeemed.guestContact?.email) setEmail(redeemed.guestContact.email);

      const first = redeemed.cart[0];
      if (first) {
        setProduct(await api.post<Product>('/search', { productDetail: first.productId }).catch(() => null) as never);
      }
    } catch (err) {
      const code = (err as { body?: { code?: string } }).body?.code;
      // Expiry is not the buyer's fault and does not get an error screen.
      if (code === 'HANDOFF_TOKEN_EXPIRED' || code === 'INVALID_HANDOFF_TOKEN') setExpired(true);
      else setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void redeem();
  }, [redeem]);

  /**
   * A signed-in buyer never retypes what we already hold.
   *
   * Asking someone for an address they saved last week is the point at which a checkout
   * stops feeling like it knows them, and it is the most common reason a ready buyer
   * abandons — the friction arrives *after* they have decided, which is the worst place for
   * it. The default address is preselected so the common case is one tap.
   */
  useEffect(() => {
    if (status !== 'signedIn') return;

    void Promise.all([
      api.get<{ email: string | null; name: string | null }>('/buyer/me').catch(() => null),
      api.get<{ addresses: SavedAddress[] }>('/buyer/addresses').catch(() => null),
    ]).then(([profile, list]) => {
      if (profile?.email) setEmail(profile.email);
      const addresses = list?.addresses ?? [];
      setSaved(addresses);
      const preferred = addresses.find((a) => a.isDefault) ?? addresses[0];
      if (preferred) setChosenAddressId(preferred.id);
      // Only fall back to the form when there is genuinely nothing to choose from.
      else setEnteringNew(true);
    });
  }, [status]);

  /** The address being bought against: a saved one if chosen, otherwise the typed form. */
  const chosen = saved.find((a) => a.id === chosenAddressId) ?? null;
  const shippingAddress = chosen
    ? {
        recipientName: chosen.recipientName,
        recipientPhone: chosen.recipientPhone,
        line1: chosen.line1,
        line2: chosen.line2 ?? '',
        landmark: chosen.landmark ?? '',
        city: chosen.city,
        state: chosen.state,
        pincode: chosen.pincode,
      }
    : address;

  async function pay(event: React.FormEvent) {
    event.preventDefault();
    if (!session) return;
    setPaying(true);
    setError(null);
    try {
      const outcome = await api.post<{ results: OrderResult[] }>('/checkout/pay', {
        sessionId: session.sessionId,
        buyerEmail: email.trim(),
        buyerPhone: shippingAddress.recipientPhone.trim(),
        shippingAddress,
      });

      const payable = outcome.results.find((r) => r.ok && r.razorpayOrderId && r.razorpayKeyId);

      /**
       * The order exists but is not paid — so open Razorpay rather than showing a receipt.
       *
       * Stopping here was the bug: an order sat at `awaiting_payment`, the buyer saw a
       * confirmation, and nobody had been charged. The merchant's own key opens their own
       * checkout, so the money goes to them and never through us.
       */
      if (payable) {
        await openRazorpay(payable, outcome.results);
        return;
      }

      setResults(outcome.results);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPaying(false);
    }
  }

  async function openRazorpay(order: OrderResult, all: OrderResult[]) {
    await loadRazorpay();

    const RazorpayCheckout = (window as unknown as { Razorpay: new (o: unknown) => { open(): void } })
      .Razorpay;

    const checkout = new RazorpayCheckout({
      key: order.razorpayKeyId,
      order_id: order.razorpayOrderId,
      amount: Number(order.amountPaise ?? 0),
      currency: order.currency ?? 'INR',
      name: order.merchantName,
      // Said inside the payment sheet too, because this is the moment the buyer is deciding.
      description: `Paid directly to ${order.merchantName}`,
      prefill: {
        email: email.trim(),
        contact: shippingAddress.recipientPhone.trim(),
        name: shippingAddress.recipientName.trim(),
      },
      notes: { order_number: order.orderNumber ?? '' },
      theme: { color: '#111827' },
      handler: async (response: {
        razorpay_payment_id: string;
        razorpay_order_id: string;
        razorpay_signature: string;
      }) => {
        /**
         * Confirmed server-side before anything is shown as paid.
         *
         * The browser cannot be trusted to say a payment succeeded — the signature is
         * verified against the merchant's key secret, which only the API holds.
         */
        try {
          await api.post('/checkout/confirm', {
            orderId: order.orderId,
            razorpayPaymentId: response.razorpay_payment_id,
            razorpayOrderId: response.razorpay_order_id,
            razorpaySignature: response.razorpay_signature,
          });
          setResults(all.map((r) => (r.merchantId === order.merchantId ? { ...r, paid: true } : r)));
        } catch (err) {
          // The money has moved even if we could not record it, so the message must not
          // suggest otherwise — and the webhook will reconcile it regardless.
          setError(
            `Your payment went through (${response.razorpay_payment_id}) but we could not ` +
              `confirm it here. It will appear in your orders shortly. ${describeError(err)}`,
          );
        }
      },
      modal: {
        ondismiss: () => {
          /**
           * Closing the sheet is not a failure, and not an order either.
           *
           * The stock stays reserved for twenty minutes and the sweeper releases it, so the
           * honest message is that nothing has been charged and the link still works.
           */
          setPaying(false);
          setError(
            'Payment was not completed, so nothing has been charged. Your items are held for ' +
              'twenty minutes if you want to try again.',
          );
        },
      },
    });

    checkout.open();
  }

  if (loading) return <p className="py-16 text-center text-sm text-[hsl(var(--muted))]">Loading…</p>;

  if (expired) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-lg font-semibold">This link has expired</h1>
        <p className="mt-2 text-sm text-[hsl(var(--muted))]">
          Checkout links last fifteen minutes and open once. Ask the assistant for a new one and
          you will be back here in a moment — nothing has been charged.
        </p>
      </div>
    );
  }

  const total = (session?.cart ?? []).reduce(
    (sum, item) => sum + BigInt(item.priceSnapshot) * BigInt(item.quantity),
    0n,
  );

  if (results) return <Outcome results={results} />;

  return (
    /* Desktop: product left at 60%, checkout right at 40%. Mobile: stacked, product first. */
    <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
      <div className="space-y-4">
        {session?.handoffContext.originalQuery && (
          <Card>
            <div className="px-5 py-4 text-sm">
              <p className="text-[hsl(var(--muted))]">You asked for</p>
              <p className="mt-1 font-medium">“{session.handoffContext.originalQuery}”</p>
              {session.handoffContext.conversationSummary && (
                <p className="mt-2 text-[hsl(var(--muted))]">
                  {session.handoffContext.conversationSummary}
                </p>
              )}
            </div>
          </Card>
        )}

        <Card>
          <div className="space-y-3 px-5 py-5">
            {product?.images?.[0] && (
              /* A plain <img>: merchant images are arbitrary external URLs, and next/image
                 would need every merchant domain allow-listed in advance. */
              <img
                src={product.images[0]}
                alt={product.name}
                className="aspect-square w-full rounded-lg object-cover"
              />
            )}
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                {product?.name ?? 'Your item'}
              </h1>
              {product?.brand && (
                <p className="text-sm text-[hsl(var(--muted))]">{product.brand}</p>
              )}
            </div>
            <p className="text-xl font-semibold tabular-nums">{formatPaise(total.toString())}</p>
            {product?.description && (
              <p className="text-sm text-[hsl(var(--muted))]">{product.description}</p>
            )}

            {product?.merchant && (
              <div className="border-t border-[hsl(var(--border))] pt-3">
                <p className="text-sm font-medium">{product.merchant.name}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {product.merchant.trust.signals.map((signal) => (
                    <Badge key={signal} tone="neutral">
                      {signal}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {product?.policies && (
              <div className="border-t border-[hsl(var(--border))] pt-3 text-sm text-[hsl(var(--muted))]">
                {product.policies.return_window_days != null && (
                  <p>{product.policies.return_window_days}-day returns.</p>
                )}
                {product.policies.dispatch_sla_hours != null && (
                  <p>Dispatched within {product.policies.dispatch_sla_hours} hours.</p>
                )}
                {product.policies.refund?.url && (
                  <a href={product.policies.refund.url} className="underline" target="_blank" rel="noreferrer">
                    Read their full refund policy
                  </a>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="space-y-4">
        {/*
          T2.22, and unmissable by design. It is the most surprising true thing about this
          product and the thing a buyer most needs to understand before entering a card.
        */}
        <Card className="border-[hsl(var(--fg))]">
          <div className="px-5 py-4">
            <p className="text-sm font-medium">
              You are paying {product?.merchant.name ?? 'this merchant'} directly.
            </p>
            <p className="mt-1 text-sm text-[hsl(var(--muted))]">
              The money goes straight into their own Razorpay account. We never hold it and take
              no commission.
            </p>
          </div>
        </Card>

        {error && <ErrorNote>{error}</ErrorNote>}

        <Card>
          <form onSubmit={pay} className="space-y-4 px-5 py-5">
            <Field
              label="Email"
              hint={
                status === 'signedIn'
                  ? 'From your account. Your receipt goes here.'
                  : 'For your receipt and order updates.'
              }
            >
              <input
                className={inputClass}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>

            {/*
              T2.21 — one tap for someone who has bought before.

              Asking a signed-in buyer to retype an address they saved last week is the point
              at which a checkout stops feeling like it knows them, and the friction lands
              *after* they have decided, which is the worst place for it.
            */}
            {saved.length > 0 && !enteringNew && (
              <div>
                <p className="text-sm font-medium">Deliver to</p>
                <div className="mt-2 space-y-2">
                  {saved.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setChosenAddressId(a.id)}
                      className={`w-full rounded-lg border p-3 text-left text-sm ${
                        chosenAddressId === a.id
                          ? 'border-[hsl(var(--fg))] bg-[hsl(var(--accent-soft))]'
                          : 'border-[hsl(var(--border))]'
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{a.label || a.city}</span>
                        {a.isDefault && <Badge tone="accent">Default</Badge>}
                      </div>
                      <p className="mt-0.5 text-[hsl(var(--muted))]">
                        {a.recipientName} · {a.recipientPhone}
                      </p>
                      <p className="text-[hsl(var(--muted))]">
                        {[a.line1, a.line2, a.landmark].filter(Boolean).join(', ')}, {a.city},{' '}
                        {a.state} {a.pincode}
                      </p>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setEnteringNew(true)}
                  className="mt-2 text-sm underline"
                >
                  Send it somewhere else
                </button>
              </div>
            )}

            {(saved.length === 0 || enteringNew) && (
              <>
                {saved.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setEnteringNew(false)}
                    className="text-sm underline"
                  >
                    Use a saved address instead
                  </button>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Name">
                    <input
                      className={inputClass}
                      value={address.recipientName}
                      onChange={(e) => setAddress({ ...address, recipientName: e.target.value })}
                    />
                  </Field>
                  <Field label="Phone">
                    <input
                      className={inputClass}
                      value={address.recipientPhone}
                      onChange={(e) => setAddress({ ...address, recipientPhone: e.target.value })}
                    />
                  </Field>
                </div>
                <Field label="Address">
                  <input
                    className={inputClass}
                    value={address.line1}
                    onChange={(e) => setAddress({ ...address, line1: e.target.value })}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="City">
                    <input
                      className={inputClass}
                      value={address.city}
                      onChange={(e) => setAddress({ ...address, city: e.target.value })}
                    />
                  </Field>
                  <Field label="State">
                    <input
                      className={inputClass}
                      value={address.state}
                      onChange={(e) => setAddress({ ...address, state: e.target.value })}
                    />
                  </Field>
                  <Field label="PIN code">
                    <input
                      className={inputClass}
                      inputMode="numeric"
                      value={address.pincode}
                      onChange={(e) =>
                        setAddress({
                          ...address,
                          pincode: e.target.value.replace(/\D/g, '').slice(0, 6),
                        })
                      }
                    />
                  </Field>
                </div>
              </>
            )}

            {/*
              Guest checkout stays available (T2.21). Someone who has already chosen what
              they want should not be asked to create an account first — but a signed-out
              buyer with an account is offered the shortcut rather than left to type.
            */}
            {status === 'signedOut' && (
              <p className="text-xs text-[hsl(var(--muted))]">
                Buying as a guest.{' '}
                <a href="/login" className="underline">
                  Sign in
                </a>{' '}
                to use a saved address — you will come back here.
              </p>
            )}

            <Button
              type="submit"
              disabled={paying || !email.trim() || !shippingAddress.pincode}
            >
              {paying ? 'Creating your order…' : `Pay ${formatPaise(total.toString())}`}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

/**
 * T2.21's partial failure. A two-merchant cart where the second payment fails must leave the
 * first order intact and offer a retry for the second alone — never roll back a success.
 */
function Outcome({ results }: { results: (OrderResult & { paid?: boolean })[] }) {
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  return (
    <div className="mx-auto max-w-lg space-y-4 py-8">
      {succeeded.length > 0 && (
        <Card>
          <div className="px-5 py-5">
            <h1 className="text-lg font-semibold">
              {succeeded.some((r) => (r as { paid?: boolean }).paid)
                ? 'Payment received'
                : succeeded.length === 1
                  ? 'Your order is placed'
                  : 'Your orders are placed'}
            </h1>
            <ul className="mt-3 space-y-2 text-sm">
              {succeeded.map((r) => (
                <li key={r.merchantId} className="flex justify-between gap-4">
                  <span>
                    {r.merchantName}{' '}
                    <span className="font-mono text-xs text-[hsl(var(--muted))]">
                      {r.orderNumber}
                    </span>
                  </span>
                  <span className="tabular-nums">{formatPaise(r.amountPaise ?? '0')}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-[hsl(var(--muted))]">
              Each merchant has been notified and will confirm shortly.
            </p>
          </div>
        </Card>
      )}

      {failed.map((r) => (
        <Card key={r.merchantId} className="border-[hsl(var(--danger))]">
          <div className="px-5 py-5 text-sm">
            <p className="font-medium">{r.merchantName} could not be completed</p>
            <p className="mt-1 text-[hsl(var(--muted))]">{r.error}</p>
            {succeeded.length > 0 && (
              <p className="mt-2 text-[hsl(var(--muted))]">
                Your other order is unaffected and has been placed.
              </p>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

export default function CheckoutPage() {
  // `useSearchParams` needs a Suspense boundary in a statically exported app.
  return (
    <Suspense fallback={<p className="py-16 text-center text-sm">Loading…</p>}>
      <Checkout />
    </Suspense>
  );
}
