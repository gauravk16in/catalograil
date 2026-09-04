'use client';

import { useEffect, useState } from 'react';
import { api, describeError } from '../../lib/api';
import { formatPaise } from '../../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, inputClass } from '../../components/ui';

/** T1.23 — the product list, with the enrichment state visible per row. */
interface ProductRow {
  id: string;
  name: string;
  brand?: string;
  archetype: string;
  status: string;
  variantCount: number;
  minPricePaise?: string;
  indexed: boolean;
}

export default function ProductsPage() {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ products: ProductRow[] }>('/merchant/products')
      .then((r) => setProducts(r.products))
      .catch((err) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, []);

  const visible = products.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Products</h1>
          <p className="mt-1.5 text-sm text-[hsl(var(--muted))]">
            {products.length} products. Draft ones are still being categorised and indexed.
          </p>
        </div>
        <Button>
          <a href="/uploads">Upload a CSV</a>
        </Button>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      <Card>
        <div className="border-b border-[hsl(var(--border))] px-5 py-3">
          <input
            className={inputClass}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name"
          />
        </div>

        {loading ? (
          <Empty title="Loading…" />
        ) : visible.length === 0 ? (
          <Empty
            title="No products yet"
            reason={
              products.length === 0
                ? 'Upload a CSV or add one by hand. We work out the categories and the search metadata for you.'
                : 'Nothing matches that filter.'
            }
          />
        ) : (
          <ul className="divide-y divide-[hsl(var(--border))]">
            {visible.map((product) => (
              <li key={product.id} className="flex items-center gap-4 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{product.name}</p>
                  <p className="mt-0.5 text-xs text-[hsl(var(--muted))]">
                    {product.brand ? `${product.brand} · ` : ''}
                    {product.variantCount} {product.variantCount === 1 ? 'variant' : 'variants'}
                  </p>
                </div>
                <div className="shrink-0">
                  {product.status === 'draft' ? (
                    <Badge tone="warn">Indexing</Badge>
                  ) : product.status === 'archived' ? (
                    <Badge>Archived</Badge>
                  ) : (
                    <Badge tone="ok">Live</Badge>
                  )}
                </div>
                <div className="w-24 shrink-0 text-right text-sm tabular-nums">
                  {formatPaise(product.minPricePaise ?? null)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
