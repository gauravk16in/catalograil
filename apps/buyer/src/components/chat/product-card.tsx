'use client';

import { useEffect, useState } from 'react';
import { api, describeError } from '../../lib/api';
import { formatPaise } from '../../lib/format';
import { ProductImage } from '../product-image';
import type { SearchResultItem } from '../../lib/types';

/**
 * A product, rendered inside the conversation.
 *
 * The card is the answer, not an illustration of it. So everything a buyer needs to decide
 * is on the face of it — photo, price, whether it is actually in stock, when it would
 * arrive, who is selling it and why this one came back — and the two things they might do
 * next, look closer or buy it, are one tap away without leaving the thread.
 *
 * `why_this_matched` earns its place. A buyer being answered by software has no way to tell
 * a good match from a confident one, and the sentence is the only thing that distinguishes
 * them.
 */

export interface Variant {
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
  } | null;
}

export function ProductCard({
  item,
  onBuy,
}: {
  item: SearchResultItem;
  onBuy: (choice: { item: SearchResultItem; variantId: string; label: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selected, setSelected] = useState<string>(item.id);
  const [error, setError] = useState<string | null>(null);

  /**
   * Detail is fetched when the card is opened, never with the search.
   *
   * Five results would mean five extra round trips for panels nobody has asked to see, and
   * the first screen is the one that has to be fast.
   */
  useEffect(() => {
    if (!open || detail) return;
    api
      .post<Detail>('/product', { productId: item.productId })
      .then((d) => {
        setDetail(d);
        const matched = d.variants.find((v) => v.id === item.id);
        setSelected((matched ?? d.variants[0])?.id ?? item.id);
      })
      .catch((err) => setError(describeError(err)));
  }, [open, detail, item.productId, item.id]);

  const variant = detail?.variants.find((v) => v.id === selected) ?? null;
  const price = variant?.price_paise ?? item.pricePaise ?? null;
  const inStock = variant ? variant.availability === 'in_stock' : item.availability === 'in_stock';
  const axes = axisNames(detail?.variants ?? []);

  return (
    <article className="flex w-[264px] shrink-0 snap-start flex-col overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--bg))] transition hover:shadow-md">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-left">
        <ProductImage
          src={detail?.images?.[0] ?? item.images?.[0]}
          alt={item.name}
          className="aspect-[4/3] w-full"
        />
      </button>

      <div className="flex flex-1 flex-col gap-2.5 p-3.5">
        <div>
          <h3 className="text-[13.5px] font-semibold leading-snug">{item.name}</h3>
          {item.brand && <p className="text-xs text-[hsl(var(--muted))]">{item.brand}</p>}
        </div>

        <p className="text-[17px] font-semibold tracking-tight">{formatPaise(price)}</p>

        <div className="flex flex-wrap gap-1.5">
          <Tag tone={inStock ? 'ok' : 'warn'}>{inStock ? 'In stock' : 'Out of stock'}</Tag>
          {item.deliveryEstimate && <Tag>{item.deliveryEstimate}</Tag>}
          <Tag>
            {item.merchant.name}
            {item.merchant.trust.newMerchant ? ' · new' : ''}
          </Tag>
        </div>

        {item.whyThisMatched && (
          <p className="text-[12px] leading-relaxed text-[hsl(var(--muted))]">{item.whyThisMatched}</p>
        )}

        {open && (
          <div className="cr-rise space-y-3 border-t border-[hsl(var(--border))] pt-3">
            {error && <p className="text-xs text-[hsl(var(--danger))]">{error}</p>}
            {!detail && !error && <p className="text-xs text-[hsl(var(--muted))]">Loading…</p>}

            {detail?.description && (
              <p className="text-[12px] leading-relaxed text-[hsl(var(--muted))]">
                {detail.description}
              </p>
            )}

            {/* One row of chips per option axis, so "size" and "colour" stay distinguishable
                — a flat list of every combination is unreadable past about four variants. */}
            {axes.map((axis) => (
              <div key={axis} className="space-y-1.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--muted))]">
                  {axis}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {uniqueValues(detail!.variants, axis).map((value) => {
                    const target = pickVariant(detail!.variants, selected, axis, value);
                    const on = detail!.variants.find((v) => v.id === selected)?.options[axis] === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => target && setSelected(target.id)}
                        className={`rounded-lg border px-2.5 py-1 text-xs transition ${
                          on
                            ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent-soft))] text-[hsl(var(--accent))]'
                            : 'border-[hsl(var(--border))] hover:border-[hsl(var(--muted))]'
                        }`}
                      >
                        {value}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* The merchant's own words. Nothing here is summarised by us: a buyer deciding
                whether to trust a seller is the wrong moment for an approximation. */}
            {detail?.policies?.refund?.summary && (
              <p className="text-[12px] leading-relaxed text-[hsl(var(--muted))]">
                <span className="font-medium text-[hsl(var(--text))]">Returns: </span>
                {detail.policies.refund.summary}
              </p>
            )}
          </div>
        )}

        <div className="mt-auto flex items-center gap-2 pt-1">
          <button
            type="button"
            disabled={!inStock}
            onClick={() =>
              onBuy({ item, variantId: selected, label: variantLabel(variant) })
            }
            className="flex-1 rounded-xl bg-[hsl(var(--accent))] px-3 py-2 text-[13px] font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
          >
            {inStock ? 'Buy' : 'Unavailable'}
          </button>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded-xl border border-[hsl(var(--border))] px-3 py-2 text-[13px] font-medium transition hover:bg-[hsl(var(--surface))]"
          >
            {open ? 'Less' : 'Details'}
          </button>
        </div>
      </div>
    </article>
  );
}

function Tag({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'ok' | 'warn' }) {
  const styles = {
    neutral: 'border-[hsl(var(--border))] text-[hsl(var(--muted))]',
    ok: 'border-transparent bg-[hsl(var(--ok-soft))] text-[hsl(var(--ok))]',
    warn: 'border-transparent bg-[hsl(var(--warn-soft))] text-[hsl(var(--warn))]',
  }[tone];
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${styles}`}>
      {children}
    </span>
  );
}

function axisNames(variants: Variant[]): string[] {
  const names = new Set<string>();
  for (const v of variants) for (const key of Object.keys(v.options ?? {})) names.add(key);
  return [...names];
}

function uniqueValues(variants: Variant[], axis: string): string[] {
  return [...new Set(variants.map((v) => v.options?.[axis]).filter(Boolean) as string[])];
}

/**
 * Changing one axis keeps the others where they were, where such a variant exists.
 *
 * Picking "blue" should not silently reset the size to whatever comes first in the list —
 * that is how a buyer ends up ordering the wrong thing while believing they chose it.
 */
function pickVariant(
  variants: Variant[],
  currentId: string,
  axis: string,
  value: string,
): Variant | undefined {
  const current = variants.find((v) => v.id === currentId);
  const wanted = { ...(current?.options ?? {}), [axis]: value };
  return (
    variants.find((v) => Object.entries(wanted).every(([k, val]) => v.options?.[k] === val)) ??
    variants.find((v) => v.options?.[axis] === value)
  );
}

function variantLabel(variant: Variant | null): string {
  const options = Object.values(variant?.options ?? {});
  return options.length > 0 ? options.join(' · ') : '';
}
