'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '../../lib/api';
import { formatPaise } from '../../lib/format';
import { ProductImage } from '../../components/product-image';
import { BuyFlow } from '../../components/chat/buy-flow';
import type { SearchResultItem } from '../../lib/types';

/**
 * One product, at its own address.
 *
 * An assistant that recommends something has to be able to link to it. Handing back a link
 * to the search page and expecting the buyer to find the item again undoes the whole point
 * of having been given a recommendation — and it reads as a broken link even though it
 * technically resolved.
 *
 * The URL is `/p/<productId>`. This is a static export, so there is no server to match a
 * dynamic segment: Amplify rewrites `/p/*` to this one document and the id is read from the
 * path here. The alternative, a query string, works identically for the browser and looks
 * like a tracking parameter to a person deciding whether to trust the link.
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
  } | null;
}

export default function ProductPage() {
  /**
   * `undefined` until the path has been read, which is not the same as "no id".
   *
   * The document is prerendered with no URL, so starting at `null` renders "that link does
   * not name a product" into the static HTML — a flash of a wrong answer before hydration
   * gets to the real one.
   */
  const [productId, setProductId] = useState<string | null | undefined>(undefined);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [shot, setShot] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);

  useEffect(() => {
    /**
     * `/p/<id>` first, `?id=<id>` second.
     *
     * The rewrite means the path segment is the real address; the query form stays supported
     * because links get copied, shortened and pasted, and a link that worked yesterday
     * should not stop working because the routing changed.
     */
    const fromPath = window.location.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
    const fromQuery = new URLSearchParams(window.location.search).get('id') ?? '';
    const id = /^[0-9a-f-]{36}$/i.test(fromPath) ? fromPath : fromQuery;
    setProductId(id || null);
  }, []);

  useEffect(() => {
    if (!productId) return;
    api
      .post<Detail>('/product', { productId })
      .then((d) => {
        setDetail(d);
        setSelected(d.variants[0]?.id ?? '');
      })
      .catch((err) => setError(describeError(err)));
  }, [productId]);

  if (productId === undefined) return <Loading />;
  if (!productId) return <Missing message="That link does not name a product." />;
  if (error) return <Missing message={error} />;
  if (!detail) return <Loading />;

  const variant = detail.variants.find((v) => v.id === selected) ?? null;
  const inStock = variant ? variant.availability === 'in_stock' : false;
  const axes = axisNames(detail.variants);
  const images = detail.images.length > 0 ? detail.images : [''];

  return (
    <div className="space-y-8 pb-24">
      <Link href="/" className="text-sm text-[hsl(var(--muted))] underline">
        ← Ask for something else
      </Link>

      <div className="grid gap-8 sm:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="space-y-3">
          <ProductImage
            src={images[shot] || undefined}
            alt={detail.name}
            className="aspect-square w-full rounded-2xl border border-[hsl(var(--border))]"
          />
          {images.length > 1 && (
            <div className="flex gap-2 overflow-x-auto">
              {images.map((src, index) => (
                <button
                  key={src + index}
                  type="button"
                  onClick={() => setShot(index)}
                  className={`shrink-0 overflow-hidden rounded-lg border transition ${
                    index === shot ? 'border-[hsl(var(--accent))]' : 'border-[hsl(var(--border))]'
                  }`}
                >
                  <ProductImage src={src || undefined} alt="" className="h-14 w-14" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{detail.name}</h1>
            {detail.brand && <p className="text-sm text-[hsl(var(--muted))]">{detail.brand}</p>}
          </div>

          <div className="flex flex-wrap items-baseline gap-3">
            <p className="text-3xl font-semibold tracking-tight">
              {formatPaise(variant?.price_paise ?? null)}
            </p>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                inStock
                  ? 'bg-[hsl(var(--ok-soft))] text-[hsl(var(--ok))]'
                  : 'bg-[hsl(var(--warn-soft))] text-[hsl(var(--warn))]'
              }`}
            >
              {inStock ? 'In stock' : 'Out of stock'}
            </span>
            {variant?.delivery_days != null && (
              <span className="text-sm text-[hsl(var(--muted))]">
                Delivers in {variant.delivery_days} days
              </span>
            )}
          </div>

          {axes.map((axis) => (
            <div key={axis} className="space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--muted))]">
                {axis}
              </p>
              <div className="flex flex-wrap gap-2">
                {uniqueValues(detail.variants, axis).map((value) => {
                  const target = pickVariant(detail.variants, selected, axis, value);
                  const on = variant?.options?.[axis] === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => target && setSelected(target.id)}
                      className={`rounded-xl border px-3 py-1.5 text-sm transition ${
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

          {buying ? (
            <BuyFlow
              item={asItem(detail, variant)}
              {...(variant ? { variantId: variant.id } : {})}
              variantLabel={Object.values(variant?.options ?? {}).join(' · ')}
            />
          ) : (
            <button
              type="button"
              disabled={!inStock}
              onClick={() => setBuying(true)}
              className="w-full rounded-xl bg-[hsl(var(--accent))] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-40 sm:w-auto"
            >
              {inStock ? 'Buy this' : 'Out of stock'}
            </button>
          )}

          <div className="space-y-1 border-t border-[hsl(var(--border))] pt-4 text-sm">
            <p className="font-medium">{detail.merchant.name}</p>
            {detail.merchant.city && (
              <p className="text-[hsl(var(--muted))]">{detail.merchant.city}</p>
            )}
            {/* Said here, not only at the payment step: it is the most surprising true thing
                about this product and the buyer should know it before deciding. */}
            <p className="text-[hsl(var(--muted))]">
              You pay {detail.merchant.name} directly. No commission, no funds held by us.
            </p>
          </div>
        </div>
      </div>

      {detail.description && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">About this</h2>
          <p className="max-w-2xl text-sm leading-relaxed text-[hsl(var(--muted))]">
            {detail.description}
          </p>
        </section>
      )}

      {/* The merchant's own text, verbatim. Nothing on this page is summarised by us — a
          buyer deciding whether to trust a seller is the wrong moment for an approximation. */}
      {(detail.policies?.refund?.summary || detail.policies?.refund?.text) && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Returns and refunds</h2>
          <p className="max-w-2xl whitespace-pre-line text-sm leading-relaxed text-[hsl(var(--muted))]">
            {detail.policies.refund.text || detail.policies.refund.summary}
          </p>
          {detail.policies.return_window_days != null && (
            <p className="text-sm text-[hsl(var(--muted))]">
              Return window: {detail.policies.return_window_days} days
              {detail.policies.return_shipping_by
                ? ` · return shipping paid by the ${detail.policies.return_shipping_by}`
                : ''}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function Loading() {
  return <p className="py-16 text-sm text-[hsl(var(--muted))]">Loading…</p>;
}

function Missing({ message }: { message: string }) {
  return (
    <div className="py-16 text-center">
      <p className="text-sm font-medium">{message}</p>
      <Link href="/" className="mt-3 inline-block text-sm underline">
        Ask for something instead
      </Link>
    </div>
  );
}

/** The shape BuyFlow already speaks, assembled from the detail this page has. */
function asItem(detail: Detail, variant: Variant | null): SearchResultItem {
  return {
    id: detail.id,
    productId: detail.id,
    ...(variant ? { variantId: variant.id } : {}),
    name: detail.name,
    ...(detail.brand ? { brand: detail.brand } : {}),
    ...(variant?.price_paise ? { pricePaise: variant.price_paise } : {}),
    priceAsOf: new Date().toISOString(),
    availability: variant?.availability === 'in_stock' ? 'in_stock' : 'unknown',
    images: detail.images,
    whyThisMatched: '',
    merchant: {
      id: detail.merchant.id,
      name: detail.merchant.name,
      ...(detail.merchant.city ? { city: detail.merchant.city } : {}),
      trust: { score: 0, newMerchant: false, signals: detail.merchant.trust.signals },
    },
  };
}

function axisNames(variants: Variant[]): string[] {
  const names = new Set<string>();
  for (const v of variants) for (const key of Object.keys(v.options ?? {})) names.add(key);
  return [...names];
}

function uniqueValues(variants: Variant[], axis: string): string[] {
  return [...new Set(variants.map((v) => v.options?.[axis]).filter(Boolean) as string[])];
}

/** Changing one axis keeps the others, so picking a colour does not reset the size. */
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
