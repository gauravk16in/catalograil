'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, describeError } from '../lib/api';
import { Badge, Card, CardHeader, ErrorNote } from '../components/ui';

/**
 * The dashboard home.
 *
 * It answers "what should I do next", and what that is depends on how far along a merchant
 * is. Rather than redirecting an unfinished merchant to a separate wizard — which hides the
 * rest of the product from them and makes the dashboard feel locked — the same page shows
 * the setup checklist while things are outstanding and the operating summary once they are
 * not.
 */

interface Session {
  businessName: string;
  status: string;
  onboarding: {
    connectedRazorpay: boolean;
    policiesAccepted: boolean;
    declaredCapabilities: boolean;
  };
}

interface ProductSummary {
  total: number;
  products: { servingState: string }[];
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [catalogue, setCatalogue] = useState<ProductSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get<Session>('/merchant/me'),
      // A failure here is not fatal to the page: a merchant mid-setup has no catalogue yet,
      // and the checklist is still worth rendering.
      api.get<ProductSummary>('/merchant/products?limit=200').catch(() => null),
    ])
      .then(([s, c]) => {
        setSession(s);
        setCatalogue(c);
      })
      .catch((err) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="py-10 text-sm text-[hsl(var(--muted))]">Loading…</p>;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!session) return null;

  const hasCatalogue = (catalogue?.total ?? 0) > 0;
  const steps = [
    {
      title: 'Connect Razorpay',
      href: '/settings/payments',
      done: session.onboarding.connectedRazorpay,
      why: 'Until this is connected your products stay out of search — a buyer who cannot pay at checkout is worse off than one who never saw the listing.',
    },
    {
      title: 'Add your policy URLs',
      href: '/policies',
      done: session.onboarding.policiesAccepted,
      why: 'Refunds, terms and fulfillment. We summarise them once and snapshot the summary onto every order, so a later change never rewrites a buyer’s contract.',
    },
    {
      title: 'Add your products',
      href: '/uploads',
      done: hasCatalogue,
      why: 'Upload a CSV or add one by hand. Nothing reaches search until it is enriched and indexed.',
    },
  ];
  const outstanding = steps.filter((s) => !s.done);

  const ready = catalogue?.products.filter((p) => p.servingState === 'indexed').length ?? 0;
  const working =
    catalogue?.products.filter((p) => ['processing', 'partial'].includes(p.servingState)).length ??
    0;
  const failed = catalogue?.products.filter((p) => p.servingState === 'failed').length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{session.businessName}</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[hsl(var(--muted))]">
          {outstanding.length === 0
            ? 'Everything is set up. Buyers can find you inside Claude and ChatGPT.'
            : `${outstanding.length} thing${outstanding.length === 1 ? '' : 's'} left before buyers can find you.`}
        </p>
      </div>

      {outstanding.length > 0 && (
        <Card>
          <CardHeader
            title="Finish setting up"
            description="In any order — these come from different places and often different people."
          />
          <ol className="divide-y divide-[hsl(var(--border))]">
            {steps.map((step, i) => (
              <li key={step.title} className="px-5 py-4">
                <div className="flex items-start gap-4">
                  <span className="w-6 shrink-0 pt-0.5 text-sm tabular-nums text-[hsl(var(--muted))]">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={step.href} className="text-sm font-medium underline">
                        {step.title}
                      </Link>
                      {step.done && <Badge tone="accent">Done</Badge>}
                    </div>
                    {!step.done && (
                      <p className="mt-1 max-w-2xl text-sm text-[hsl(var(--muted))]">{step.why}</p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {hasCatalogue && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Ready to serve" value={ready} tone="accent" href="/products" />
          <Stat label="Processing" value={working} tone="warn" href="/products" />
          <Stat label="Failed" value={failed} tone={failed > 0 ? 'danger' : 'neutral'} href="/products" />
        </div>
      )}

      <Card>
        <CardHeader
          title="See what a buyer sees"
          description="Type what a shopper would ask and get the real ranked results, with your products marked."
        />
        <div className="px-5 py-5">
          <Link href="/preview" className="text-sm underline">
            Open Preview in AI
          </Link>
        </div>
      </Card>
    </div>
  );
}

/** A number a merchant can act on, linked to the screen that resolves it. */
function Stat({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: number;
  tone: 'accent' | 'warn' | 'danger' | 'neutral';
  href: string;
}) {
  return (
    <Link href={href}>
      <Card className="px-5 py-4 transition hover:border-[hsl(var(--fg))]">
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <div className="mt-1 flex items-center gap-2">
          <Badge tone={tone}>{label}</Badge>
        </div>
      </Card>
    </Link>
  );
}
