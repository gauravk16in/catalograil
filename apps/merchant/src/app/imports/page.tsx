'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, describeError } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Field, inputClass } from '../../components/ui';

/**
 * Importing a catalogue from the merchant's own website.
 *
 * This is the page that decides whether a merchant ever finishes onboarding. The honest
 * alternative — export a CSV from your store, match our column names, upload it — is an
 * afternoon of work on data they already have, and most people never come back from it.
 *
 * Two things it refuses to do. It does not promise every site will work: it says which
 * kinds do, before the merchant spends a minute finding out. And it does not put anything
 * imported into search — every product arrives as a draft, because this is a machine's
 * reading of pages written for people, and the merchant is the one who gets to say whether
 * it read them correctly.
 */

interface SiteImport {
  id: string;
  siteUrl: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  method: string | null;
  productsFound: number;
  productsCreated: number;
  productsUpdated: number;
  variantsUpserted: number;
  slotsDone: number;
  skipped: { url: string; reason: string }[];
  rejectionReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

const SLOT = 50;

export default function ImportsPage() {
  const [url, setUrl] = useState('');
  const [imports, setImports] = useState<SiteImport[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await api.get<{ imports: SiteImport[] }>('/merchant/imports/site');
      setImports(response.imports);
      return response.imports;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  /**
   * Polls only while something is running.
   *
   * A slot takes seconds, so two seconds is a number that moves visibly; and a dashboard
   * left open on a finished import should not keep a request in flight all afternoon.
   */
  useEffect(() => {
    const active = imports.some((job) => job.status === 'queued' || job.status === 'running');
    if (!active) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [imports, load]);

  async function start(event: React.FormEvent) {
    event.preventDefault();
    setStarting(true);
    setError(null);
    try {
      await api.post('/merchant/imports/site', { websiteUrl: url.trim() });
      setUrl('');
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Import from your website</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[hsl(var(--muted))]">
          Give us your storefront address and we will read your catalogue from it — names,
          descriptions, images, every variant with its own price. Nothing goes live: products
          arrive as drafts for you to check.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Your storefront"
          description="Products are read fifty at a time, so a large catalogue arrives in batches you can watch."
        />
        <form onSubmit={start} className="space-y-4 px-5 py-5">
          <Field
            label="Website address"
            hint="The public storefront, not an admin URL. https:// is added if you leave it out."
          >
            <input
              className={inputClass}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="yourstore.in"
              inputMode="url"
              required
            />
          </Field>

          {error && <ErrorNote>{error}</ErrorNote>}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={starting || url.trim() === ''}>
              {starting ? 'Starting…' : 'Import my catalogue'}
            </Button>
            <span className="text-xs text-[hsl(var(--muted))]">
              Or <Link href="/uploads" className="underline">upload a CSV</Link> instead.
            </span>
          </div>
        </form>

        {/* Said before they spend a minute finding out, not after. */}
        <div className="border-t border-[hsl(var(--border))] px-5 py-4 text-sm text-[hsl(var(--muted))]">
          <p className="font-medium text-[hsl(var(--text))]">What this can read</p>
          <ul className="mt-1.5 space-y-1">
            <li>· Shopify stores, exactly — every product, variant and price.</li>
            <li>
              · Any site whose product pages carry schema.org markup — the same data that puts
              a price under your listing in Google.
            </li>
            <li>
              · Not a site that renders prices only in the browser with no structured data. A
              CSV is the way in for those, and we would rather say so than guess at a price.
            </li>
          </ul>
        </div>
      </Card>

      {loading ? (
        <p className="py-6 text-sm text-[hsl(var(--muted))]">Loading…</p>
      ) : imports.length === 0 ? (
        <Card>
          <Empty title="No imports yet" reason="Anything you import will be listed here with what it found." />
        </Card>
      ) : (
        <Card>
          <CardHeader title="Imports" />
          <ul className="divide-y divide-[hsl(var(--border))]">
            {imports.map((job) => (
              <ImportRow key={job.id} job={job} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ImportRow({ job }: { job: SiteImport }) {
  const [showSkipped, setShowSkipped] = useState(false);
  const running = job.status === 'queued' || job.status === 'running';

  return (
    <li className="space-y-2 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{job.siteUrl}</span>
        <Badge
          tone={
            job.status === 'completed' ? 'ok' : job.status === 'failed' ? 'danger' : 'warn'
          }
        >
          {job.status}
        </Badge>
        {job.method && job.method !== 'none' && <Badge>{job.method}</Badge>}
        <span className="text-xs text-[hsl(var(--muted))]">{relativeTime(job.createdAt)}</span>
      </div>

      {running ? (
        /**
         * A count, not a percentage. Nothing here knows how many products the site has until
         * it has read them all, and a progress bar that invents a denominator is a progress
         * bar that sticks at 90%.
         */
        <p className="text-sm text-[hsl(var(--muted))]">
          {job.productsFound} products read so far
          {job.slotsDone > 0 ? ` · batch ${job.slotsDone + 1} of ${SLOT} at a time` : ' · starting'}
        </p>
      ) : (
        <p className="text-sm text-[hsl(var(--muted))]">
          {job.productsCreated} created, {job.productsUpdated} updated, {job.variantsUpserted}{' '}
          variants
        </p>
      )}

      {job.rejectionReason && (
        <p className="max-w-2xl text-sm text-[hsl(var(--warn))]">{job.rejectionReason}</p>
      )}

      {job.status === 'completed' && job.productsCreated + job.productsUpdated > 0 && (
        <p className="text-sm">
          <Link href="/products" className="underline">
            Review them in your catalogue
          </Link>{' '}
          <span className="text-[hsl(var(--muted))]">
            — they are drafts until you publish them.
          </span>
        </p>
      )}

      {job.skipped.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowSkipped((v) => !v)}
            className="text-xs underline"
          >
            {job.skipped.length} page{job.skipped.length === 1 ? '' : 's'} could not be read
          </button>
          {showSkipped && (
            <ul className="mt-2 space-y-1">
              {job.skipped.map((skip) => (
                <li key={skip.url} className="text-xs text-[hsl(var(--muted))]">
                  <span className="font-mono">{skip.url}</span> — {skip.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
