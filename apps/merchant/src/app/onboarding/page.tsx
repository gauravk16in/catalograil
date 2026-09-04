'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, describeError } from '../../lib/api';
import { Badge, Card, CardHeader, ErrorNote } from '../../components/ui';

/**
 * The onboarding checklist (S2.5, completed by Block C).
 *
 * Deliberately a checklist rather than a linear wizard. A merchant's Razorpay keys and
 * their policy URLs come from two different places and often two different people, so
 * forcing an order means someone sits on step two with the information for step three.
 * Every step is independently completable and independently resumable, and the screen
 * says which one is blocking them from going live.
 */

interface Session {
  merchantId: string;
  businessName: string;
  status: string;
  onboarding: {
    connectedRazorpay: boolean;
    declaredCapabilities: boolean;
    policiesAccepted: boolean;
    nextStep: string;
  };
}

interface Step {
  readonly key: string;
  readonly title: string;
  readonly why: string;
  readonly href: string;
  readonly done: boolean;
}

export default function OnboardingPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<Session>('/merchant/me')
      .then(setSession)
      .catch((err) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="py-10 text-sm text-[hsl(var(--muted))]">Loading…</p>;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!session) return null;

  const steps: Step[] = [
    {
      key: 'payments',
      title: 'Connect Razorpay',
      why: 'Buyers pay into your account directly. Until this is connected your products stay out of search, because a buyer who cannot pay at checkout is worse off than one who never saw the listing.',
      href: '/settings/payments',
      done: session.onboarding.connectedRazorpay,
    },
    {
      key: 'policies',
      title: 'Add your policy URLs',
      why: 'Refunds, terms and fulfillment. We read them once and summarise them, and the summary is snapshotted onto every order so a later change never rewrites a buyer’s contract.',
      href: '/policies',
      done: session.onboarding.policiesAccepted,
    },
    {
      key: 'catalogue',
      title: 'Add your first products',
      why: 'Upload a CSV or add one by hand. Nothing reaches search until it has been enriched and indexed, and the products page shows where each one is.',
      href: '/products',
      done: false,
    },
  ];

  const remaining = steps.filter((s) => !s.done).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Welcome, {session.businessName}</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[hsl(var(--muted))]">
          {remaining === 0
            ? 'Everything is set up. Your catalogue is live.'
            : `${remaining} thing${remaining === 1 ? '' : 's'} left before buyers can find you. You can do them in any order.`}
        </p>
      </div>

      <Card>
        <CardHeader title="Setup" description={`Account status: ${session.status}`} />
        <ol className="divide-y divide-[hsl(var(--border))]">
          {steps.map((step, index) => (
            <li key={step.key} className="px-5 py-4">
              <div className="flex items-start gap-4">
                <span className="w-6 shrink-0 pt-0.5 text-sm tabular-nums text-[hsl(var(--muted))]">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={step.href} className="text-sm font-medium underline">
                      {step.title}
                    </Link>
                    {step.done && <Badge tone="accent">Done</Badge>}
                  </div>
                  <p className="mt-1 max-w-2xl text-sm text-[hsl(var(--muted))]">{step.why}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
