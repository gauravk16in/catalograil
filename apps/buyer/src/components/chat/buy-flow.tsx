'use client';

import { useEffect, useState } from 'react';
import { api, describeError } from '../../lib/api';
import { formatPaise } from '../../lib/format';
import { collect, openSession, pay, type OrderResult, type SavedAddress, type ShippingAddress } from '../../lib/shopping';
import { useAuth } from '../../lib/auth';
import { ProductImage } from '../product-image';
import type { SearchResultItem } from '../../lib/types';

/**
 * Buying, in the conversation, without a page change.
 *
 * The old route was: card → checkout link → a different page → address → payment → a
 * receipt somewhere else. Six surfaces for one decision the buyer had already made. This is
 * the same sequence, in the thread, in the place they were looking.
 *
 * A signed-in buyer never retypes what we already hold. Asking for an address saved last
 * week is the point at which a checkout stops feeling like it knows them, and the friction
 * arrives *after* the decision, which is the worst place for it. So the default address is
 * preselected and the common case is a single tap.
 */

type Stage = 'choosing' | 'paying' | 'done' | 'failed';

export function BuyFlow({
  item,
  variantId,
  variantLabel,
}: {
  item: SearchResultItem;
  variantId: string;
  variantLabel: string;
}) {
  const { status, email: accountEmail } = useAuth();
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [stage, setStage] = useState<Stage>('choosing');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OrderResult | null>(null);

  useEffect(() => {
    if (status !== 'signedIn') return;
    if (accountEmail) setEmail(accountEmail);

    void Promise.all([
      api.get<{ email: string | null }>('/buyer/me').catch(() => null),
      api.get<{ addresses: SavedAddress[] }>('/buyer/addresses').catch(() => null),
    ]).then(([profile, list]) => {
      if (profile?.email) setEmail(profile.email);
      const saved = list?.addresses ?? [];
      setAddresses(saved);
      setChosen((saved.find((a) => a.isDefault) ?? saved[0])?.id ?? null);
    });
  }, [status, accountEmail]);

  const address = addresses.find((a) => a.id === chosen) ?? null;

  async function run() {
    if (!address) return;
    setStage('paying');
    setError(null);
    setNote(null);

    try {
      const sessionId = await openSession({ productId: item.productId, variantId, quantity: 1 });
      const results = await pay({ sessionId, buyerEmail: email, address: address as ShippingAddress });
      const order = results[0] ?? null;
      setResult(order);

      if (!order?.ok) {
        setError(order?.error ?? 'The merchant could not accept this order.');
        setStage('failed');
        return;
      }

      /**
       * An order exists but nothing has been charged yet, so the payment sheet opens rather
       * than a receipt appearing. Stopping here was the old bug: the buyer saw a
       * confirmation while the order sat at `awaiting_payment` and no money had moved.
       */
      if (order.razorpayOrderId && order.razorpayKeyId) {
        const outcome = await collect(order, { email, address: address as ShippingAddress });
        if (outcome.status === 'dismissed') {
          // Not a failure and not an order. The reservation expires on its own.
          setNote('Payment sheet closed. Nothing has been charged — the item is held briefly.');
          setStage('choosing');
          return;
        }
        if (outcome.message) setNote(outcome.message);
      }

      setStage('done');
    } catch (err) {
      setError(describeError(err));
      setStage('failed');
    }
  }

  if (status !== 'signedIn') {
    return (
      <Frame item={item} variantLabel={variantLabel}>
        <p className="text-[13px] text-[hsl(var(--muted))]">
          Sign in to buy with your saved address, or continue as a guest on the checkout page.
        </p>
        <div className="flex gap-2">
          <a
            href="/login"
            className="rounded-xl bg-[hsl(var(--accent))] px-3.5 py-2 text-[13px] font-semibold text-white"
          >
            Sign in
          </a>
          <button
            type="button"
            onClick={async () => {
              try {
                const { checkoutUrl } = await api.post<{ checkoutUrl: string }>('/checkout/session', {
                  productId: item.productId,
                  variantId,
                  quantity: 1,
                });
                window.location.href = checkoutUrl;
              } catch (err) {
                setError(describeError(err));
              }
            }}
            className="rounded-xl border border-[hsl(var(--border))] px-3.5 py-2 text-[13px] font-medium"
          >
            Continue as guest
          </button>
        </div>
        {error && <p className="text-[13px] text-[hsl(var(--danger))]">{error}</p>}
      </Frame>
    );
  }

  if (stage === 'done') {
    return (
      <Frame item={item} variantLabel={variantLabel}>
        <div className="rounded-xl border border-transparent bg-[hsl(var(--ok-soft))] px-3.5 py-3">
          <p className="text-[13px] font-semibold text-[hsl(var(--ok))]">
            Paid — order {result?.orderNumber}
          </p>
          <p className="mt-1 text-[12px] text-[hsl(var(--ok))]">
            {formatPaise(result?.amountPaise ?? null)} to {result?.merchantName}, directly to their
            account. Nothing passed through Conciergent.
          </p>
        </div>
        {note && <p className="text-[12px] text-[hsl(var(--muted))]">{note}</p>}
        <a href="/orders" className="text-[13px] font-medium underline">
          See it in your orders
        </a>
      </Frame>
    );
  }

  return (
    <Frame item={item} variantLabel={variantLabel}>
      {addresses.length === 0 ? (
        <p className="text-[13px] text-[hsl(var(--muted))]">
          No saved address yet.{' '}
          <a href="/account" className="underline">
            Add one
          </a>{' '}
          and this becomes one tap.
        </p>
      ) : (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--muted))]">
            Deliver to
          </p>
          <div className="flex flex-wrap gap-1.5">
            {addresses.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setChosen(a.id)}
                className={`rounded-xl border px-3 py-1.5 text-left text-[12px] transition ${
                  chosen === a.id
                    ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent-soft))]'
                    : 'border-[hsl(var(--border))] hover:border-[hsl(var(--muted))]'
                }`}
              >
                <span className="font-medium">{a.label ?? a.recipientName}</span>
                <span className="text-[hsl(var(--muted))]">
                  {' '}
                  · {a.city} {a.pincode}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {note && <p className="text-[12px] text-[hsl(var(--muted))]">{note}</p>}
      {error && <p className="text-[13px] text-[hsl(var(--danger))]">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!address || stage === 'paying'}
          onClick={run}
          className="rounded-xl bg-[hsl(var(--accent))] px-4 py-2 text-[13px] font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
        >
          {stage === 'paying' ? 'Opening payment…' : 'Pay the merchant'}
        </button>
        {/* T2.22: said at the moment of deciding, not in a footer nobody reads. */}
        <p className="text-[11px] leading-tight text-[hsl(var(--muted))]">
          Paid directly to {item.merchant.name}. No commission, no funds held by us.
        </p>
      </div>
    </Frame>
  );
}

function Frame({
  item,
  variantLabel,
  children,
}: {
  item: SearchResultItem;
  variantLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--bg))] p-4">
      <div className="flex items-center gap-3">
        <ProductImage src={item.images?.[0]} alt={item.name} className="h-12 w-12 rounded-lg" />
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-semibold">{item.name}</p>
          <p className="text-[12px] text-[hsl(var(--muted))]">
            {variantLabel ? `${variantLabel} · ` : ''}
            {formatPaise(item.pricePaise ?? null)}
          </p>
        </div>
      </div>
      {children}
    </div>
  );
}
