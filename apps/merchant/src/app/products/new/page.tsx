'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { api, describeError } from '../../../lib/api';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorNote,
  Field,
  inputClass,
} from '../../../components/ui';

/**
 * S4.3 — adding one product by hand.
 *
 * The CSV path is for a catalogue; this is for the single product a merchant is adding on a
 * Tuesday afternoon. Both end at the same rows and the same enrichment queue, so a product
 * cannot behave differently depending on how it arrived.
 *
 * The step that earns its complexity is the variant matrix. A three-axis product is 24
 * combinations, and asking someone to type 24 SKUs and 24 prices is how a merchant decides
 * the CSV was easier after all. So the matrix is generated, and "apply to all" fills the
 * columns that are usually uniform.
 */

type Archetype = 'SIMPLE' | 'VARIANT';

interface Axis {
  name: string;
  values: string[];
}

interface VariantDraft {
  sku: string;
  optionValues: Record<string, string>;
  price: string;
  mrp: string;
  stock: string;
  deliveryDays: string;
}

const STEPS = ['Type', 'Details', 'Options', 'Variants', 'Review'] as const;

export default function NewProductPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [archetype, setArchetype] = useState<Archetype>('SIMPLE');
  const [externalRef, setExternalRef] = useState('');
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [description, setDescription] = useState('');
  const [categoryHint, setCategoryHint] = useState('');
  const [images, setImages] = useState<string[]>(['']);

  const [axes, setAxes] = useState<Axis[]>([{ name: '', values: [] }]);
  const [variants, setVariants] = useState<VariantDraft[]>([]);

  // Simple products have exactly one variant and no options, so those fields live here.
  const [simple, setSimple] = useState({ sku: '', price: '', mrp: '', stock: '0', deliveryDays: '' });

  const usableAxes = useMemo(
    () => axes.filter((a) => a.name.trim() && a.values.length > 0),
    [axes],
  );

  /**
   * Every combination of every axis, in a stable order.
   *
   * Generated rather than typed: the whole point of declaring axes is that the matrix
   * follows from them, and a hand-typed matrix with a hole in it means a buyer can select a
   * combination that resolves to nothing.
   */
  function generateMatrix() {
    const combos = usableAxes.reduce<Record<string, string>[]>(
      (acc, axis) =>
        acc.flatMap((partial) => axis.values.map((value) => ({ ...partial, [axis.name]: value }))),
      [{}],
    );

    const base = variants[0];
    setVariants(
      combos.map((optionValues) => {
        const suffix = Object.values(optionValues).join('-').toUpperCase().replace(/\s+/g, '');
        const existing = variants.find(
          (v) => JSON.stringify(v.optionValues) === JSON.stringify(optionValues),
        );
        return (
          existing ?? {
            sku: `${(externalRef || name).toUpperCase().replace(/\s+/g, '-').slice(0, 20)}-${suffix}`,
            optionValues,
            // Carrying the first row's values forward is what makes 24 combinations
            // tolerable: most differ only by option, not by price.
            price: base?.price ?? '',
            mrp: base?.mrp ?? '',
            stock: base?.stock ?? '0',
            deliveryDays: base?.deliveryDays ?? '',
          }
        );
      }),
    );
  }

  function applyToAll(field: 'price' | 'mrp' | 'stock' | 'deliveryDays', value: string) {
    setVariants((prev) => prev.map((v) => ({ ...v, [field]: value })));
  }

  async function save(publish: boolean) {
    setSaving(true);
    setError(null);

    const payload = {
      ...(externalRef.trim() ? { externalRef: externalRef.trim() } : {}),
      archetype,
      name: name.trim(),
      ...(brand.trim() ? { brand: brand.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(categoryHint.trim() ? { categoryHint: categoryHint.trim() } : {}),
      attributes: {},
      images: images.filter((u) => u.trim()),
      optionAxes:
        archetype === 'VARIANT'
          ? usableAxes.map((a) => ({ name: a.name.trim(), values: a.values }))
          : [],
      variants:
        archetype === 'VARIANT'
          ? variants.map((v) => ({
              sku: v.sku.trim(),
              optionValues: v.optionValues,
              price: v.price.trim(),
              ...(v.mrp.trim() ? { mrp: v.mrp.trim() } : {}),
              stock: Number(v.stock || 0),
              ...(v.deliveryDays ? { deliveryDays: Number(v.deliveryDays) } : {}),
              images: [],
            }))
          : [
              {
                sku: simple.sku.trim() || externalRef.trim() || name.trim(),
                optionValues: {},
                price: simple.price.trim(),
                ...(simple.mrp.trim() ? { mrp: simple.mrp.trim() } : {}),
                stock: Number(simple.stock || 0),
                ...(simple.deliveryDays ? { deliveryDays: Number(simple.deliveryDays) } : {}),
                images: [],
              },
            ],
    };

    try {
      const result = await api.post<{ productId: string }>('/merchant/products', payload);
      // Publishing is a second call so a draft is saved even if publishing fails.
      if (publish) {
        await api.patch(`/merchant/products/${result.productId}`, {}).catch(() => undefined);
      }
      router.push('/products');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  const canContinue =
    step === 0 ||
    (step === 1 && name.trim().length > 0) ||
    (step === 2 && (archetype === 'SIMPLE' || usableAxes.length > 0)) ||
    step === 3 ||
    step === 4;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Add a product</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-[hsl(var(--muted))]">
            For one product. To add many at once, a CSV is faster —{' '}
            <Link href="/uploads" className="underline">
              upload one instead
            </Link>
            .
          </p>
        </div>
      </div>

      <ol className="flex flex-wrap gap-2 text-sm">
        {STEPS.map((label, i) => {
          // Options and Variants do not apply to a simple product.
          if (archetype === 'SIMPLE' && (i === 2 || i === 3)) return null;
          return (
            <li key={label}>
              <button
                type="button"
                onClick={() => setStep(i)}
                className={`rounded-md px-3 py-1.5 ${
                  step === i
                    ? 'bg-[hsl(var(--accent-soft))] font-medium'
                    : 'text-[hsl(var(--muted))]'
                }`}
              >
                {label}
              </button>
            </li>
          );
        })}
      </ol>

      {error && <ErrorNote>{error}</ErrorNote>}

      {step === 0 && (
        <Card>
          <CardHeader title="What kind of product is this?" description="This decides how buyers select it." />
          <div className="grid gap-3 px-5 py-5 sm:grid-cols-2">
            {(
              [
                {
                  key: 'SIMPLE' as const,
                  title: 'Simple',
                  body: 'One price, one stock count. A dashcam, a book, a bottle.',
                  enabled: true,
                },
                {
                  key: 'VARIANT' as const,
                  title: 'Variant',
                  body: 'Sizes, colours, fabrics. Each combination has its own SKU, price and stock.',
                  enabled: true,
                },
                {
                  key: 'LIVE_PRICED' as const,
                  title: 'Live priced',
                  body: 'Price comes from your system at query time — flights, cab fares.',
                  enabled: false,
                },
                {
                  key: 'BOOKABLE' as const,
                  title: 'Bookable',
                  body: 'Slots on a calendar — appointments, seats, nights.',
                  enabled: false,
                },
              ] as const
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                disabled={!option.enabled}
                onClick={() => option.enabled && setArchetype(option.key as Archetype)}
                className={`rounded-lg border p-4 text-left ${
                  archetype === option.key
                    ? 'border-[hsl(var(--fg))] bg-[hsl(var(--accent-soft))]'
                    : 'border-[hsl(var(--border))]'
                } ${option.enabled ? '' : 'opacity-50'}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{option.title}</span>
                  {!option.enabled && <Badge tone="neutral">Coming soon</Badge>}
                </div>
                <p className="mt-1 text-sm text-[hsl(var(--muted))]">{option.body}</p>
              </button>
            ))}
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card>
          <CardHeader
            title="The basics"
            description="The description is the main thing search matches on — describe what it is for, not just what it is."
          />
          <div className="space-y-4 px-5 py-5">
            <Field label="Name" hint="What a buyer would call it. Not a SKU.">
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Brand" hint="Optional">
                <input
                  className={inputClass}
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                />
              </Field>
              <Field label="Your product code" hint="Optional. Re-using it updates that product.">
                <input
                  className={inputClass}
                  value={externalRef}
                  onChange={(e) => setExternalRef(e.target.value)}
                />
              </Field>
            </div>
            <Field
              label="Description"
              hint={`${description.length} / 2000 — what it is for, who it suits, when they would use it`}
            >
              <textarea
                className={`${inputClass} min-h-32`}
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <Field label="Category" hint="A rough one is fine — we refine it automatically.">
              <input
                className={inputClass}
                value={categoryHint}
                onChange={(e) => setCategoryHint(e.target.value)}
                placeholder="running shoes"
              />
            </Field>

            <Field label="Image URLs" hint="Publicly reachable https links. The first is the main image.">
              <div className="space-y-2">
                {images.map((url, i) => (
                  <input
                    key={i}
                    className={inputClass}
                    value={url}
                    placeholder="https://…"
                    onChange={(e) => {
                      const next = [...images];
                      next[i] = e.target.value;
                      setImages(next);
                    }}
                  />
                ))}
                {images.length < 6 && (
                  <Button type="button" variant="secondary" onClick={() => setImages([...images, ''])}>
                    Add another image
                  </Button>
                )}
              </div>
            </Field>

            {archetype === 'SIMPLE' && (
              <div className="grid gap-4 border-t border-[hsl(var(--border))] pt-4 sm:grid-cols-2">
                <Field label="SKU" hint="Defaults to your product code.">
                  <input
                    className={inputClass}
                    value={simple.sku}
                    onChange={(e) => setSimple({ ...simple, sku: e.target.value })}
                  />
                </Field>
                <Field label="Price (₹)" hint="Plain rupees: 1899 or 1899.50">
                  <input
                    className={inputClass}
                    value={simple.price}
                    onChange={(e) => setSimple({ ...simple, price: e.target.value })}
                  />
                </Field>
                <Field label="MRP (₹)" hint="Optional">
                  <input
                    className={inputClass}
                    value={simple.mrp}
                    onChange={(e) => setSimple({ ...simple, mrp: e.target.value })}
                  />
                </Field>
                <Field label="Stock">
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={simple.stock}
                    onChange={(e) =>
                      setSimple({ ...simple, stock: e.target.value.replace(/\D/g, '') })
                    }
                  />
                </Field>
                <Field
                  label="Delivery days"
                  hint="Buyers filter on this, and an item that cannot arrive in time is excluded rather than ranked lower — an honest number wins more orders."
                >
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={simple.deliveryDays}
                    onChange={(e) =>
                      setSimple({ ...simple, deliveryDays: e.target.value.replace(/\D/g, '') })
                    }
                  />
                </Field>
              </div>
            )}
          </div>
        </Card>
      )}

      {step === 2 && archetype === 'VARIANT' && (
        <Card>
          <CardHeader
            title="What varies?"
            description="Up to three axes. Size, colour, fabric — whatever a buyer chooses between."
          />
          <div className="space-y-4 px-5 py-5">
            {axes.map((axis, i) => (
              <div key={i} className="grid gap-3 sm:grid-cols-[1fr_2fr]">
                <Field label={`Axis ${i + 1}`}>
                  <input
                    className={inputClass}
                    value={axis.name}
                    placeholder="size"
                    onChange={(e) => {
                      const next = [...axes];
                      next[i] = { ...axis, name: e.target.value };
                      setAxes(next);
                    }}
                  />
                </Field>
                <Field label="Values" hint="Comma separated: 38, 40, 42">
                  <input
                    className={inputClass}
                    value={axis.values.join(', ')}
                    placeholder="38, 40, 42"
                    onChange={(e) => {
                      const next = [...axes];
                      next[i] = {
                        ...axis,
                        values: e.target.value
                          .split(',')
                          .map((v) => v.trim())
                          .filter(Boolean),
                      };
                      setAxes(next);
                    }}
                  />
                </Field>
              </div>
            ))}
            {axes.length < 3 && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setAxes([...axes, { name: '', values: [] }])}
              >
                Add another axis
              </Button>
            )}
            {usableAxes.length > 0 && (
              <p className="text-sm text-[hsl(var(--muted))]">
                That is{' '}
                <strong>
                  {usableAxes.reduce((n, a) => n * a.values.length, 1)} combinations
                </strong>
                . The next step generates them.
              </p>
            )}
          </div>
        </Card>
      )}

      {step === 3 && archetype === 'VARIANT' && (
        <Card>
          <CardHeader
            title="The matrix"
            description="Generated from your axes. Fill one row, then apply it to all."
          />
          <div className="space-y-4 px-5 py-5">
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={generateMatrix}>
                {variants.length > 0 ? 'Regenerate' : 'Generate'} {usableAxes.reduce((n, a) => n * a.values.length, 1)} rows
              </Button>
              {variants.length > 0 && (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => applyToAll('price', variants[0]?.price ?? '')}
                  >
                    Apply row 1 price to all
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => applyToAll('stock', variants[0]?.stock ?? '0')}
                  >
                    Apply row 1 stock to all
                  </Button>
                </>
              )}
            </div>

            {variants.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-[hsl(var(--border))] text-left text-xs text-[hsl(var(--muted))]">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Options</th>
                      <th className="py-2 pr-3 font-medium">SKU</th>
                      <th className="py-2 pr-3 font-medium">Price ₹</th>
                      <th className="py-2 pr-3 font-medium">Stock</th>
                      <th className="py-2 font-medium">Days</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[hsl(var(--border))]">
                    {variants.map((variant, i) => (
                      <tr key={i}>
                        <td className="py-2 pr-3 text-[hsl(var(--muted))]">
                          {Object.values(variant.optionValues).join(' · ')}
                        </td>
                        {(['sku', 'price', 'stock', 'deliveryDays'] as const).map((field) => (
                          <td key={field} className="py-2 pr-3">
                            <input
                              className={`${inputClass} ${field === 'sku' ? 'w-48' : 'w-24'}`}
                              value={variant[field]}
                              onChange={(e) => {
                                const next = [...variants];
                                next[i] = { ...variant, [field]: e.target.value };
                                setVariants(next);
                              }}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      )}

      {step === 4 && (
        <Card>
          <CardHeader
            title="Review"
            description="Saving creates it as a draft. It reaches buyers once it has been enriched and indexed — the Products page shows where it is."
          />
          <div className="space-y-3 px-5 py-5 text-sm">
            <p>
              <strong>{name || '(no name)'}</strong>
              {brand ? ` · ${brand}` : ''} · {archetype}
            </p>
            <p className="text-[hsl(var(--muted))]">
              {archetype === 'VARIANT'
                ? `${variants.length} variants across ${usableAxes.map((a) => a.name).join(' × ')}`
                : `SKU ${simple.sku || externalRef || name} · ₹${simple.price || '—'} · ${simple.stock} in stock`}
            </p>
            <p className="text-[hsl(var(--muted))]">
              {images.filter((u) => u.trim()).length} image
              {images.filter((u) => u.trim()).length === 1 ? '' : 's'}
            </p>
            <div className="flex gap-2 pt-2">
              <Button type="button" onClick={() => void save(false)} disabled={saving || !name.trim()}>
                {saving ? 'Saving…' : 'Save product'}
              </Button>
              <Button type="button" variant="secondary">
                <Link href="/products">Cancel</Link>
              </Button>
            </div>
          </div>
        </Card>
      )}

      <div className="flex justify-between">
        <Button
          type="button"
          variant="secondary"
          disabled={step === 0}
          onClick={() => setStep((s) => Math.max(0, archetype === 'SIMPLE' && s === 4 ? 1 : s - 1))}
        >
          Back
        </Button>
        {step < 4 && (
          <Button
            type="button"
            disabled={!canContinue}
            onClick={() => setStep((s) => (archetype === 'SIMPLE' && s === 1 ? 4 : s + 1))}
          >
            Continue
          </Button>
        )}
      </div>
    </div>
  );
}
