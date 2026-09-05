'use client';

import { useEffect, useState } from 'react';
import { api, describeError } from '../lib/api';
import { formatPaise } from '../lib/format';
import { Badge, Button, Card, ErrorNote } from './ui';
import { ProductImage } from './product-image';
import type { SearchResultItem } from '../lib/types';

/**
 * The product panel, and the only route from browsing to buying.
 *
 * Opened over the results rather than on its own page, because a buyer comparing three
 * shirts should be able to look at one and get back to the other two without losing the
 * search that produced them.
 *
 * Everything it shows about policies is what the merchant wrote, verbatim. Nothing is
 * generated: a buyer deciding whether to spend money on a seller they have never heard of
 * is exactly the wrong moment for an approximation.
 */

interface Variant {
  id: string;
  options: Record<string, string>;
  price_paise: string | null;
  availability: string;
  stock: number | null;
  delivery_days: number | null;
}

interface Detail {
  id: string;
  name: string;
  brand: string | null;
  description: string | null;
  images: string[];
  variants: Variant[];
  merchant: { id: string; name: string; city: string | null; trust: { signals: string[] } };
  policies?: {
    refund?: { summary: string | null; text: string | null; url: string | null };
    fulfillment?: { summary: string | null };
    return_window_days: number | null;
    return_shipping_by: string | null;
    dispatch_sla_hours: number | null;
    source?: string;
  } | null;
}

export function ProductDetail({
  result,
  onClose,
}: {
  result: SearchResultItem;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selected, setSelected] = useState<string | null>(result.id);
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPolicy, setShowPolicy] = useState(false);

  useEffect(() => {
    api
      .post<Detail>('/product', { productId: result.productId })
      .then((d) => {
        setDetail(d);
        // Default to the variant the search actually matched, not the first in the list —
        // a buyer who searched "size 42" should not land on size 38.
        const matched = d.variants.find((v) => v.id === result.id);
        setSelected((matched ?? d.variants[0])?.id ?? null);
      })
      .catch((err) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, [result.productId, result.id]);

  const variant = detail?.variants.find((v) => v.id === selected) ?? null;
  const canBuy = variant?.availability === 'in_stock';

  async function buy() {
    if (!detail || !variant) return;
    setBuying(true);
    setError(null);
    try {
      const session = await api.post<{ checkoutUrl: string }>('/checkout/session', {
        productId: detail.id,
        variantId: variant.id,
        quantity: 1,
      });
      // Straight to the split-screen surface, which is where address and payment happen.
      window.location.href = session.checkoutUrl;
    } catch (err) {
      setError(describeError(err));
      setBuying(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-5 py-3">
        <p className="text-sm font-medium">{result.name}</p>
        <button type="button" onClick={onClose} className="text-sm underline">
          Back to results
        </button>
      </div>

      {loading ? (
        <p className="px-5 py-8 text-sm text-[hsl(var(--muted))]">Loading…</p>
      ) : (
        <div className="grid gap-6 px-5 py-5 sm:grid-cols-[2fr_3fr]">
          <ProductImage
            src={detail?.images?.[0] ?? result.images?.[0]}
            alt={result.name}
            className="aspect-square w-full rounded-lg"
          />

          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">{detail?.name ?? result.name}</h2>
              {detail?.brand && <p className="text-sm text-[hsl(var(--muted))]">{detail.brand}</p>}
              <p className="mt-2 text-xl font-semibold tabular-nums">
                {formatPaise(variant?.price_paise ?? result.pricePaise ?? null)}
              </p>
            </div>

            {detail?.description && (
              <p className="text-sm text-[hsl(var(--muted))]">{detail.description}</p>
            )}

            {(detail?.variants.length ?? 0) > 1 && (
              <div>
                <p className="text-sm font-medium">Choose an option</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {detail!.variants.map((v) => {
                    const label = Object.values(v.options).join(' · ') || v.id.slice(0, 6);
                    const out = v.availability !== 'in_stock';
                    return (
                      <button
                        key={v.id}
                        type="button"
                        disabled={out}
                        onClick={() => setSelected(v.id)}
                        className={`rounded-md border px-3 py-1.5 text-sm ${
                          selected === v.id
                            ? 'border-[hsl(var(--fg))] bg-[hsl(var(--accent-soft))]'
                            : 'border-[hsl(var(--border))]'
                        } ${out ? 'opacity-40 line-through' : ''}`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="border-t border-[hsl(var(--border))] pt-3">
              <p className="text-sm font-medium">
                {detail?.merchant.name ?? result.merchant.name}
                {detail?.merchant.city ? ` · ${detail.merchant.city}` : ''}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {(detail?.merchant.trust.signals ?? result.merchant.trust.signals).map((s) => (
                  <Badge key={s} tone="neutral">
                    {s}
                  </Badge>
                ))}
              </div>
            </div>

            {detail?.policies && (
              <div className="border-t border-[hsl(var(--border))] pt-3 text-sm">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[hsl(var(--muted))]">
                  {detail.policies.return_window_days != null && (
                    <span>{detail.policies.return_window_days}-day returns</span>
                  )}
                  {detail.policies.return_shipping_by && (
                    <span>return shipping: {detail.policies.return_shipping_by}</span>
                  )}
                  {detail.policies.dispatch_sla_hours != null && (
                    <span>dispatched in {detail.policies.dispatch_sla_hours}h</span>
                  )}
                </div>

                {/*
                  The merchant's own words, shown on request. Collapsed by default because a
                  wall of terms above a Buy button helps nobody, and expandable because the
                  buyer who wants the exact wording is the one about to spend money.
                */}
                {(detail.policies.refund?.text || detail.policies.refund?.summary) && (
                  <button
                    type="button"
                    onClick={() => setShowPolicy(!showPolicy)}
                    className="mt-2 underline"
                  >
                    {showPolicy ? 'Hide' : 'Read'} the seller’s return policy
                  </button>
                )}

                {showPolicy && (
                  <div className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-[hsl(var(--accent-soft))] p-3 text-[hsl(var(--muted))]">
                    {detail.policies.refund?.text ?? detail.policies.refund?.summary}
                    {detail.policies.refund?.url && (
                      <a
                        href={detail.policies.refund.url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 block underline"
                      >
                        Their published page
                      </a>
                    )}
                  </div>
                )}
              </div>
            )}

            {error && <ErrorNote>{error}</ErrorNote>}

            <div className="border-t border-[hsl(var(--border))] pt-4">
              <Button type="button" onClick={buy} disabled={!canBuy || buying}>
                {buying ? 'Starting checkout…' : canBuy ? 'Buy now' : 'Out of stock'}
              </Button>
              {/* Said before the buyer commits, not after. */}
              <p className="mt-2 text-xs text-[hsl(var(--muted))]">
                You pay {detail?.merchant.name ?? 'the seller'} directly. We never hold your money
                and take no commission.
              </p>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
