'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, describeError } from '../../../lib/api';
import { relativeTime } from '../../../lib/format';
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
 * S3.5 — Settings → Payments.
 *
 * The screen answers three questions a merchant actually has: is my account connected, is
 * it test or live, and what do I paste into Razorpay. It never displays the secret,
 * because it never receives one — the API returns the last four characters and nothing else.
 */

interface PaymentConfig {
  status: string;
  method?: string;
  keyId?: string | null;
  keySecretLast4?: string | null;
  mode?: string | null;
  verifiedAt?: string | null;
  lastError?: string | null;
  webhookConfigured?: boolean;
  webhookUrl?: string;
}

export default function PaymentsPage() {
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [keyId, setKeyId] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');

  const load = useCallback(async () => {
    try {
      setConfig(await api.get<PaymentConfig>('/merchant/payment-config'));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post('/merchant/payment-config', {
        keyId: keyId.trim(),
        keySecret: keySecret.trim(),
        ...(webhookSecret.trim() ? { webhookSecret: webhookSecret.trim() } : {}),
      });
      // Cleared immediately: there is no reason for a secret to sit in a form field after
      // it has been accepted.
      setKeySecret('');
      setWebhookSecret('');
      setNotice('Razorpay verified these credentials and they are now connected.');
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function runWebhookTest() {
    setError(null);
    setNotice(null);
    try {
      const result = await api.post<{ ok: boolean; detail: string }>(
        '/merchant/payment-config/test-webhook',
        {},
      );
      if (result.ok) setNotice(result.detail);
      else setError(result.detail);
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function disconnect() {
    if (
      !confirm(
        'Disconnecting stops you receiving orders and removes your products from search until you reconnect. Continue?',
      )
    )
      return;
    setBusy(true);
    try {
      await api.del('/merchant/payment-config');
      setNotice('Disconnected. Your catalogue is hidden until you connect Razorpay again.');
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const connected = config?.status === 'verified';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Payments</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[hsl(var(--muted))]">
          Buyers pay into your own Razorpay account. We never hold your money and take no
          commission — which is why we need your keys rather than an account with us.
        </p>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && (
        <p className="rounded-md bg-[hsl(var(--accent-soft))] px-4 py-3 text-sm">{notice}</p>
      )}

      {loading ? (
        <p className="text-sm text-[hsl(var(--muted))]">Loading…</p>
      ) : (
        <>
          <Card>
            <CardHeader
              title="Connection"
              description={connected ? 'Your account is connected.' : 'Not connected yet.'}
            />
            <div className="space-y-3 px-5 py-5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={connected ? 'accent' : 'warn'}>
                  {connected ? 'Verified' : (config?.status ?? 'not connected')}
                </Badge>
                {config?.mode && (
                  <Badge tone={config.mode === 'live' ? 'accent' : 'neutral'}>
                    {config.mode === 'live' ? 'Live mode' : 'Test mode'}
                  </Badge>
                )}
                {config?.verifiedAt && (
                  <span className="text-xs text-[hsl(var(--muted))]">
                    checked {relativeTime(config.verifiedAt)}
                  </span>
                )}
              </div>

              {connected && (
                <p className="tabular-nums">
                  {config?.keyId}{' '}
                  <span className="text-[hsl(var(--muted))]">
                    · secret ends {config?.keySecretLast4}
                  </span>
                </p>
              )}

              {config?.lastError && <ErrorNote>{config.lastError}</ErrorNote>}

              {connected && (
                <Button type="button" onClick={disconnect} disabled={busy}>
                  Disconnect
                </Button>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader
              title={connected ? 'Replace your keys' : 'Connect Razorpay'}
              description="We check these against Razorpay before saving. Nothing is stored if they are rejected."
            />
            <form onSubmit={connect} className="space-y-4 px-5 py-5">
              <Field
                label="Key ID"
                hint="Razorpay dashboard → Settings → API Keys. Starts with rzp_test_ or rzp_live_."
              >
                <input
                  className={inputClass}
                  value={keyId}
                  onChange={(e) => setKeyId(e.target.value)}
                  placeholder="rzp_test_XXXXXXXXXXXX"
                />
              </Field>
              <Field label="Key secret" hint="Shown once, when you generate the key.">
                <input
                  className={inputClass}
                  type="password"
                  value={keySecret}
                  onChange={(e) => setKeySecret(e.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field
                label="Webhook secret"
                hint="Optional now, required before you can receive orders."
              >
                <input
                  className={inputClass}
                  type="password"
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Button type="submit" disabled={busy || !keyId.trim() || !keySecret.trim()}>
                {busy ? 'Checking with Razorpay…' : 'Verify and connect'}
              </Button>
            </form>
          </Card>

          <Card>
            <CardHeader
              title="Webhook"
              description="Register this URL in Razorpay so we learn when a payment succeeds."
            />
            <div className="space-y-3 px-5 py-5 text-sm">
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded bg-[hsl(var(--accent-soft))] px-3 py-2 text-xs">
                  {config?.webhookUrl ?? '—'}
                </code>
                <Button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(config?.webhookUrl ?? '')}
                >
                  Copy
                </Button>
              </div>
              <p className="text-[hsl(var(--muted))]">
                Subscribe to <code>payment.captured</code> and <code>payment.failed</code>.
              </p>
              <Button type="button" onClick={runWebhookTest} disabled={!config?.webhookConfigured}>
                Test saved secret
              </Button>
              {!config?.webhookConfigured && (
                <p className="text-xs text-[hsl(var(--muted))]">
                  Save a webhook secret above to enable this.
                </p>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
