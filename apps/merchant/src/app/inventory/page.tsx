'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, describeError } from '../../lib/api';
import { formatPaise } from '../../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, inputClass } from '../../components/ui';

/**
 * S6.2 — inventory, on its own screen.
 *
 * Adjusting stock is a different job from editing a product: it happens daily, across many
 * products, often by someone who did not write the descriptions. Making them open a product
 * form to change one number is how stock counts go stale — and a stale count is what
 * produces an order the merchant cannot fulfil.
 *
 * Edits are optimistic and saved in one batch. A merchant walking their shelf types a dozen
 * numbers; a save-per-keystroke would fire a dozen requests and a save button per row would
 * make them click twenty times.
 */

interface VariantRow {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  optionValues: Record<string, string>;
  stock: number;
  pricePaise: string | null;
  deliveryDays: number | null;
  inStock: boolean;
}

const LOW_STOCK_THRESHOLD = 5;

export default function InventoryPage() {
  const [rows, setRows] = useState<VariantRow[]>([]);
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<'all' | 'low' | 'out'>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params =
        filter === 'out' ? '?outOfStockOnly=true' : filter === 'low' ? `?lowStockBelow=${LOW_STOCK_THRESHOLD}` : '';
      const result = await api.get<{ variants: VariantRow[] }>(`/merchant/inventory${params}`);
      setRows(result.variants);
      setEdits({});
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    const updates = Object.entries(edits).map(([sku, stock]) => ({ sku, stock }));
    if (updates.length === 0) return;

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.post<{ updated: number; unknownSkus: string[] }>(
        '/merchant/inventory',
        { updates },
      );
      setNotice(
        `${result.updated} updated. Stock changes reach search within a second and never re-run indexing.`,
      );
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  const visible = rows.filter(
    (r) =>
      r.productName.toLowerCase().includes(query.toLowerCase()) ||
      r.sku.toLowerCase().includes(query.toLowerCase()),
  );
  const dirty = Object.keys(edits).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Inventory</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[hsl(var(--muted))]">
          Every variant you sell. Setting stock to zero removes it from search immediately —
          buyers never see something they cannot buy.
        </p>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && (
        <p className="rounded-md bg-[hsl(var(--accent-soft))] px-4 py-3 text-sm">{notice}</p>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--border))] px-5 py-4">
          <input
            className={`${inputClass} max-w-xs`}
            placeholder="Search name or SKU"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flex gap-1">
            {(['all', 'low', 'out'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`rounded-md px-3 py-1.5 text-sm ${
                  filter === f
                    ? 'bg-[hsl(var(--accent-soft))] font-medium'
                    : 'text-[hsl(var(--muted))]'
                }`}
              >
                {f === 'all' ? 'All' : f === 'low' ? `Low (<${LOW_STOCK_THRESHOLD})` : 'Out of stock'}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3">
            {dirty > 0 && (
              <span className="text-sm text-[hsl(var(--muted))]">
                {dirty} unsaved change{dirty === 1 ? '' : 's'}
              </span>
            )}
            <Button type="button" onClick={save} disabled={saving || dirty === 0}>
              {saving ? 'Saving…' : 'Save stock'}
            </Button>
          </div>
        </div>

        {loading ? (
          <p className="px-5 py-8 text-sm text-[hsl(var(--muted))]">Loading…</p>
        ) : visible.length === 0 ? (
          <Empty
            title="Nothing here"
            reason={
              filter === 'out'
                ? 'Nothing is out of stock.'
                : filter === 'low'
                  ? 'Nothing is running low.'
                  : 'No variants yet. Add products first.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-[hsl(var(--border))] text-left text-xs text-[hsl(var(--muted))]">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Product</th>
                  <th className="px-5 py-2.5 font-medium">SKU</th>
                  <th className="px-5 py-2.5 font-medium">Options</th>
                  <th className="px-5 py-2.5 text-right font-medium">Price</th>
                  <th className="px-5 py-2.5 text-right font-medium">Stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[hsl(var(--border))]">
                {visible.map((row) => {
                  const value = edits[row.sku] ?? row.stock;
                  const low = value > 0 && value < LOW_STOCK_THRESHOLD;
                  return (
                    <tr key={row.variantId}>
                      <td className="px-5 py-2.5">{row.productName}</td>
                      <td className="px-5 py-2.5 font-mono text-xs">{row.sku}</td>
                      <td className="px-5 py-2.5 text-[hsl(var(--muted))]">
                        {Object.entries(row.optionValues)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(' · ') || '—'}
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums">
                        {formatPaise(row.pricePaise)}
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {value === 0 && <Badge tone="warn">Hidden</Badge>}
                          {low && <Badge tone="warn">Low</Badge>}
                          <input
                            className={`${inputClass} w-20 text-right tabular-nums`}
                            inputMode="numeric"
                            value={String(value)}
                            onChange={(e) => {
                              const next = Number(e.target.value.replace(/\D/g, '') || 0);
                              setEdits((prev) => ({ ...prev, [row.sku]: next }));
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
