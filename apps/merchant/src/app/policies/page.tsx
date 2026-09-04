'use client';

import { useState } from 'react';
import { api, describeError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Badge, Button, Card, CardHeader, ErrorNote, Field, inputClass } from '../../components/ui';

/**
 * T1.22's policy step, and the gate that decides whether a merchant goes active.
 *
 * The blocked state is the important part of this screen. A merchant whose policy URL
 * returns a 404 needs to be told which URL and what happened, not "validation failed" —
 * and the API returns exactly that, so this page's job is to not throw it away.
 */
export default function PoliciesPage() {
  const { session } = useSession();
  const [refundUrl, setRefundUrl] = useState('');
  const [termsUrl, setTermsUrl] = useState('');
  const [fulfillmentUrl, setFulfillmentUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    returnWindowDays: number | null;
    refundSummary: string | null;
  } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setResult(null);

    try {
      const response = await api.post<{
        extracted?: { returnWindowDays: number | null; refundSummary: string | null };
      }>('/merchant/policies', { refundUrl, termsUrl, fulfillmentUrl });
      setResult(response.extracted ?? null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  const active = session?.status === 'active';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Policies</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[hsl(var(--muted))]">
          Three public pages, required before your products can appear. We read them and show buyers
          a plain summary — and snapshot them onto every order, so a policy change never alters a
          contract someone already agreed to.
        </p>
      </div>

      {active ? (
        <Card className="px-5 py-4">
          <Badge tone="ok">Active</Badge>
          <p className="mt-2 text-sm text-[hsl(var(--muted))]">
            Your policies are accepted and your catalogue is searchable.
          </p>
        </Card>
      ) : (
        <Card className="px-5 py-4">
          <Badge tone="warn">Not yet active</Badge>
          <p className="mt-2 text-sm text-[hsl(var(--muted))]">
            Your products will not appear in search until all three policy pages resolve.
          </p>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Policy URLs"
          description="Each must be publicly reachable and contain real text."
        />
        <form onSubmit={submit} className="space-y-4 px-5 py-5">
          <Field
            label="Refund policy"
            hint="How returns and refunds work, and within how many days."
          >
            <input
              className={inputClass}
              type="url"
              required
              value={refundUrl}
              onChange={(e) => setRefundUrl(e.target.value)}
              placeholder="https://yourstore.com/refunds"
            />
          </Field>
          <Field label="Terms of service">
            <input
              className={inputClass}
              type="url"
              required
              value={termsUrl}
              onChange={(e) => setTermsUrl(e.target.value)}
              placeholder="https://yourstore.com/terms"
            />
          </Field>
          <Field
            label="Fulfillment / shipping policy"
            hint="How long dispatch takes, and where you deliver."
          >
            <input
              className={inputClass}
              type="url"
              required
              value={fulfillmentUrl}
              onChange={(e) => setFulfillmentUrl(e.target.value)}
              placeholder="https://yourstore.com/shipping"
            />
          </Field>

          {error && <ErrorNote>{error}</ErrorNote>}

          <Button type="submit" disabled={saving}>
            {saving ? 'Checking your pages…' : 'Validate and activate'}
          </Button>
        </form>
      </Card>

      {result && (
        <Card>
          <CardHeader
            title="What we read"
            description="This is what buyers will be shown. Correct the page if it is wrong."
          />
          <dl className="divide-y divide-[hsl(var(--border))]">
            <div className="flex justify-between gap-4 px-5 py-3">
              <dt className="text-sm text-[hsl(var(--muted))]">Return window</dt>
              <dd className="text-sm font-medium">
                {result.returnWindowDays === null
                  ? 'Not stated on the page'
                  : result.returnWindowDays === 0
                    ? 'Returns not accepted'
                    : `${result.returnWindowDays} days`}
              </dd>
            </div>
            {result.refundSummary && (
              <div className="px-5 py-3">
                <dt className="text-sm text-[hsl(var(--muted))]">Refund summary</dt>
                <dd className="mt-1 text-sm">{result.refundSummary}</dd>
              </div>
            )}
          </dl>
        </Card>
      )}
    </div>
  );
}
