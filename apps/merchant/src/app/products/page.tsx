'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, inputClass } from '../../components/ui';

/**
 * S5.2/S6.1 — the product list, with serving state front and centre.
 *
 * "Active" and "ready to serve" are different things, and conflating them is what makes a
 * merchant think their catalogue is live when search cannot see any of it. The pill here
 * reports the *units*, because that is what search reads.
 */

interface ProductRow {
  id: string;
  name: string;
  brand: string | null;
  archetype: string;
  status: string;
  variantCount: number;
  unitsIndexed: number;
  unitsTotal: number;
  servingState: string;
  updatedAt: string;
}

const STATE_LABEL: Record<string, { label: string; tone: 'accent' | 'warn' | 'danger' | 'neutral' }> =
  {
    indexed: { label: 'Ready to serve', tone: 'accent' },
    partial: { label: 'Partly indexed', tone: 'warn' },
    processing: { label: 'Processing', tone: 'warn' },
    failed: { label: 'Failed', tone: 'danger' },
    draft: { label: 'Draft', tone: 'neutral' },
    archived: { label: 'Archived', tone: 'neutral' },
  };

/** Non-terminal states worth polling for. Anything else has settled. */
const IN_FLIGHT = new Set(['processing', 'partial']);

export default function ProductsPage() {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The product a merchant has asked to remove, held until they confirm. */
  const [removing, setRemoving] = useState<ProductRow | null>(null);
  const [working, setWorking] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ products: ProductRow[] }>('/merchant/products?limit=200');
      setProducts(result.products);
      setError(null);
      return result.products;
    } catch (err) {
      setError(describeError(err));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Polls every five seconds while anything is still moving, and stops when it settles.
   *
   * An indefinite poll on a settled catalogue is a request every five seconds forever from
   * every open tab, which costs the merchant nothing and us a great deal.
   */
  useEffect(() => {
    let cancelled = false;

    async function tick() {
      const rows = await load();
      if (cancelled) return;
      if (rows.some((p) => IN_FLIGHT.has(p.servingState))) {
        timer.current = setTimeout(tick, 5000);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  async function retryFailed() {
    setNotice(null);
    try {
      const result = await api.post<{ requeued: number }>('/merchant/products/retry', {
        all: true,
      });
      setNotice(
        `${result.requeued} product${result.requeued === 1 ? '' : 's'} re-queued. Unchanged content is not re-embedded, so this is cheap to run.`,
      );
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  /**
   * Removing is archiving, and the wording says so.
   *
   * A destructive-sounding button that is actually reversible should say it is reversible —
   * a merchant who believes "remove" means "gone" will not press it, and will instead leave
   * a wrong listing live. The rows genuinely stay: orders reference them, and a buyer's
   * history must not develop holes because a merchant tidied up.
   */
  async function remove(product: ProductRow) {
    setWorking(true);
    setError(null);
    try {
      await api.del(`/merchant/products/${product.id}`);
      setNotice(
        `“${product.name}” is out of search. It stays in your catalogue as removed, and any ` +
          'order that already contains it is unaffected. You can put it back.',
      );
      setRemoving(null);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setWorking(false);
    }
  }

  async function restore(product: ProductRow) {
    setWorking(true);
    setError(null);
    try {
      await api.post(`/merchant/products/${product.id}/restore`, {});
      // Re-indexed rather than re-embedded: the content has not changed (rule 9).
      setNotice(`“${product.name}” is back. It returns to search once it has been re-indexed.`);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setWorking(false);
    }
  }

  const visible = products.filter((p) => {
    const matchesText =
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.brand ?? '').toLowerCase().includes(search.toLowerCase());
    const matchesState = !stateFilter || p.servingState === stateFilter;
    return matchesText && matchesState;
  });

  const notReady = products.filter((p) => !['indexed', 'draft', 'archived'].includes(p.servingState));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Products</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-[hsl(var(--muted))]">
            “Ready to serve” means search can actually return it. A product can be active and
            still invisible while it is being indexed.
          </p>
        </div>
        <div className="flex gap-2">
          <Button>
            <Link href="/products/new">Add a product</Link>
          </Button>
          <Button variant="secondary">
            <Link href="/uploads">Upload a CSV</Link>
          </Button>
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && (
        <p className="rounded-md bg-[hsl(var(--accent-soft))] px-4 py-3 text-sm">{notice}</p>
      )}

      {notReady.length > 0 && (
        <Card className="border-[hsl(var(--warn))]">
          <div className="flex flex-wrap items-center gap-3 px-5 py-4">
            <p className="flex-1 text-sm">
              {notReady.length} product{notReady.length === 1 ? '' : 's'} not yet reaching buyers.
            </p>
            <Button type="button" onClick={retryFailed}>
              Retry all
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--border))] px-5 py-4">
          <input
            className={`${inputClass} max-w-xs`}
            placeholder="Search name or brand"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className={`${inputClass} max-w-xs`}
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
          >
            <option value="">Any state</option>
            {Object.entries(STATE_LABEL).map(([key, v]) => (
              <option key={key} value={key}>
                {v.label}
              </option>
            ))}
          </select>
          <span className="ml-auto text-sm text-[hsl(var(--muted))]">
            {visible.length} of {products.length}
          </span>
        </div>

        {loading ? (
          <p className="px-5 py-8 text-sm text-[hsl(var(--muted))]">Loading…</p>
        ) : visible.length === 0 ? (
          <Empty
            title="No products"
            reason={
              products.length === 0
                ? 'Upload a CSV or add one by hand to get started.'
                : 'Nothing matches this filter.'
            }
          />
        ) : (
          <ul className="divide-y divide-[hsl(var(--border))]">
            {visible.map((product) => {
              const state = STATE_LABEL[product.servingState] ?? {
                label: product.servingState,
                tone: 'neutral' as const,
              };
              return (
                <li key={product.id} className="flex items-center gap-4 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{product.name}</p>
                    <p className="mt-0.5 text-sm text-[hsl(var(--muted))]">
                      {product.brand ? `${product.brand} · ` : ''}
                      {product.variantCount} variant{product.variantCount === 1 ? '' : 's'} ·
                      updated {relativeTime(product.updatedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* For a variant product the fraction is the useful number: 18/24
                        indexed says something a single word cannot. */}
                    {product.unitsTotal > 0 && product.unitsIndexed < product.unitsTotal && (
                      <span className="text-xs tabular-nums text-[hsl(var(--muted))]">
                        {product.unitsIndexed}/{product.unitsTotal}
                      </span>
                    )}
                    <Badge tone={state.tone}>{state.label}</Badge>

                    {product.status === 'archived' ? (
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => void restore(product)}
                        className="text-sm underline disabled:opacity-50"
                      >
                        Restore
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => setRemoving(product)}
                        className="text-sm text-[hsl(var(--danger))] underline disabled:opacity-50"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Confirmed once, in a sentence that says what actually happens. A merchant removing
          fifty imported products one by one should not be asked a vague question fifty
          times, but they should be asked. */}
      {removing && (
        <div
          className="fixed inset-0 z-40 grid place-items-center bg-black/30 px-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md space-y-4 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--bg))] p-5">
            <div>
              <h2 className="text-sm font-semibold">Remove “{removing.name}”?</h2>
              <p className="mt-1.5 text-sm text-[hsl(var(--muted))]">
                It comes out of search straight away, so buyers and assistants stop seeing it.
                Orders that already contain it are unaffected, and you can put it back at any
                time.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" type="button" onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button variant="danger" type="button" disabled={working} onClick={() => void remove(removing)}>
                {working ? 'Removing…' : 'Remove it'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
