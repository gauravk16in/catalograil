'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, describeError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Badge, Button, Card, CardHeader, ErrorNote, Field, inputClass } from '../../components/ui';

/**
 * T1.9 — the merchant's refund, terms and fulfillment policies.
 *
 * Paste the text, or give a link. Text is the default and comes first, because most small
 * Indian merchants sell through WhatsApp and Instagram and have no website to host a refund
 * page on — asking for a URL first excluded exactly the merchants this platform exists for,
 * and pushed the rest into publishing a page they never look at again.
 *
 * What is written here is snapshotted onto every order (rule 4) and is the only thing an
 * assistant is allowed to say about this merchant's terms. That is worth stating on the page
 * itself: a merchant who understands their words will be quoted verbatim to a buyer writes
 * something different from one who thinks they are filling in a form.
 */

type Mode = 'text' | 'url';

const KINDS = [
  {
    key: 'refund' as const,
    label: 'Returns and refunds',
    hint: 'How long a buyer has, who pays return shipping, what is excluded, how long a refund takes.',
    placeholder:
      'Returns accepted within 7 days of delivery if unused with tags intact. Return shipping is paid by the buyer unless the item is faulty. Refunds reach the original payment method within 5 working days. Innerwear and made-to-order items cannot be returned.',
  },
  {
    key: 'terms' as const,
    label: 'Terms and conditions',
    hint: 'What a buyer is agreeing to when they order from you.',
    placeholder:
      'Prices include GST. Orders are confirmed once payment is received. We reserve the right to cancel and refund an order if an item is found to be out of stock after ordering.',
  },
  {
    key: 'fulfillment' as const,
    label: 'Shipping and fulfillment',
    hint: 'How quickly you dispatch, who you ship with, where you deliver.',
    placeholder:
      'Orders placed before 2pm are dispatched the same working day, otherwise the next. Delivery across India takes 3–7 working days by Delhivery. We do not currently ship outside India.',
  },
];

export default function PoliciesPage() {
  const { session } = useSession();
  const [mode, setMode] = useState<Mode>('text');
  const [text, setText] = useState({ refund: '', terms: '', fulfillment: '' });
  const [urls, setUrls] = useState({ refund: '', terms: '', fulfillment: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [result, setResult] = useState<{
    returnWindowDays: number | null;
    refundSummary: string | null;
    termsSummary?: string | null;
    fulfillmentSummary?: string | null;
    dispatchSlaHours?: number | null;
    returnShippingBy?: string | null;
  } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setResult(null);

    const payload =
      mode === 'text'
        ? {
            refundText: text.refund.trim(),
            termsText: text.terms.trim(),
            fulfillmentText: text.fulfillment.trim(),
          }
        : {
            refundUrl: urls.refund.trim(),
            termsUrl: urls.terms.trim(),
            fulfillmentUrl: urls.fulfillment.trim(),
          };

    try {
      const response = await api.post<{
        status: string;
        blockers?: string[];
        extracted?: typeof result;
      }>('/merchant/policies', payload);
      setResult(response.extracted ?? null);
      setBlockers(response.blockers ?? []);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  const active = session?.status === 'active';
  const ready =
    mode === 'text'
      ? Object.values(text).every((v) => v.trim().length >= 40)
      : Object.values(urls).every((v) => v.trim().length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Your policies</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[hsl(var(--muted))]">
          When a buyer asks an assistant “can I return this?”, it answers from exactly what you
          write here — nothing else, and never a guess. A copy is attached to every order, so a
          buyer’s terms stay the ones they bought under even after you change these.
        </p>
        {active && <Badge tone="accent">Live</Badge>}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {blockers.length > 0 && (
        <Card className="border-[hsl(var(--warn))]">
          <div className="px-5 py-4 text-sm">
            <p className="font-medium">Policies saved — but you are not live yet.</p>
            <p className="mt-1 text-[hsl(var(--muted))]">
              Still needed: {blockers.join(' and ')}.
            </p>
            <Link href="/settings/payments" className="mt-2 inline-block underline">
              Connect Razorpay
            </Link>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title={mode === 'text' ? 'Write your policies' : 'Link to your policies'}
          description={
            mode === 'text'
              ? 'Plain sentences are fine. Write what you would tell a buyer who phoned to ask.'
              : 'We fetch each page, read it, and re-check it weekly.'
          }
        />

        <div className="border-b border-[hsl(var(--border))] px-5 pb-4">
          <div className="flex gap-1">
            {(['text', 'url'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-md px-3 py-1.5 text-sm ${
                  mode === m ? 'bg-[hsl(var(--accent-soft))] font-medium' : 'text-[hsl(var(--muted))]'
                }`}
              >
                {m === 'text' ? 'Write them here' : 'I have them on my website'}
              </button>
            ))}
          </div>
          {mode === 'text' && (
            <p className="mt-2 text-xs text-[hsl(var(--muted))]">
              No website needed. This is the better option if you sell on WhatsApp or Instagram.
            </p>
          )}
        </div>

        <form onSubmit={submit} className="space-y-5 px-5 py-5">
          {KINDS.map((kind) => (
            <Field
              key={kind.key}
              label={kind.label}
              hint={
                mode === 'text'
                  ? `${kind.hint} ${text[kind.key].trim().length}/40 characters minimum`
                  : kind.hint
              }
            >
              {mode === 'text' ? (
                <textarea
                  className={`${inputClass} min-h-32`}
                  value={text[kind.key]}
                  placeholder={kind.placeholder}
                  maxLength={20000}
                  onChange={(e) => setText({ ...text, [kind.key]: e.target.value })}
                />
              ) : (
                <input
                  className={inputClass}
                  value={urls[kind.key]}
                  placeholder="https://yourshop.example/returns"
                  onChange={(e) => setUrls({ ...urls, [kind.key]: e.target.value })}
                />
              )}
            </Field>
          ))}

          <Button type="submit" disabled={saving || !ready}>
            {saving ? 'Reading them…' : 'Save policies'}
          </Button>
        </form>
      </Card>

      {result && (
        <Card>
          <CardHeader
            title="What a buyer will be told"
            description="We read your policies and pulled out the parts buyers ask about. If any of this is wrong, edit the text above — the assistant only ever says what is here."
          />
          <div className="space-y-3 px-5 py-5 text-sm">
            {result.returnWindowDays != null && (
              <p>
                <strong>{result.returnWindowDays}-day</strong> return window
                {result.returnShippingBy ? ` · return shipping paid by the ${result.returnShippingBy}` : ''}
              </p>
            )}
            {result.dispatchSlaHours != null && (
              <p>
                Dispatched within <strong>{result.dispatchSlaHours} hours</strong>
              </p>
            )}
            {result.refundSummary && (
              <p className="text-[hsl(var(--muted))]">{result.refundSummary}</p>
            )}
            {result.fulfillmentSummary && (
              <p className="text-[hsl(var(--muted))]">{result.fulfillmentSummary}</p>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
