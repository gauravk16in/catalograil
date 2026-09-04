'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, describeError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Field,
  inputClass,
} from '../../components/ui';

/**
 * S6.5 — profile and addresses.
 *
 * The page leads with what is missing rather than what is present. A buyer arrives here
 * because checkout asked them to, so the useful first sentence is which single thing is
 * still needed — not a form that looks complete and fails at the till.
 */

interface Profile {
  buyerId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  defaultAddressId: string | null;
  checkoutReady: boolean;
  missing: string[];
}

interface Address {
  id: string;
  label: string | null;
  recipientName: string;
  recipientPhone: string;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  pincode: string;
  isDefault: boolean;
}

const EMPTY_ADDRESS = {
  label: '',
  recipientName: '',
  recipientPhone: '',
  line1: '',
  line2: '',
  landmark: '',
  city: '',
  state: '',
  pincode: '',
};

export default function AccountPage() {
  const { status } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [name, setName] = useState('');
  const [form, setForm] = useState({ ...EMPTY_ADDRESS });
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([
        api.get<Profile>('/buyer/me'),
        api.get<{ addresses: Address[] }>('/buyer/addresses'),
      ]);
      setProfile(p);
      setName(p.name ?? '');
      setAddresses(a.addresses);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === 'signedIn') void load();
    else if (status === 'signedOut') setLoading(false);
  }, [status, load]);

  if (status === 'signedOut') {
    return (
      <Card>
        <Empty
          title="Sign in to see your account"
          reason="Browsing needs no account. Orders and saved addresses do."
        />
        <div className="flex gap-2 px-5 pb-5">
          <Button>
            <Link href="/login">Sign in</Link>
          </Button>
          <Button variant="secondary">
            <Link href="/signup">Create one</Link>
          </Button>
        </div>
      </Card>
    );
  }

  if (loading) return <p className="py-10 text-sm text-[hsl(var(--muted))]">Loading…</p>;

  async function saveName() {
    setBusy(true);
    setError(null);
    try {
      await api.patch('/buyer/me', { name: name.trim() });
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function addAddress(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/buyer/addresses', {
        ...(form.label ? { label: form.label } : {}),
        recipientName: form.recipientName,
        recipientPhone: form.recipientPhone,
        line1: form.line1,
        ...(form.line2 ? { line2: form.line2 } : {}),
        ...(form.landmark ? { landmark: form.landmark } : {}),
        city: form.city,
        state: form.state,
        pincode: form.pincode,
      });
      setForm({ ...EMPTY_ADDRESS });
      setAdding(false);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(id: string) {
    try {
      await api.patch(`/buyer/addresses/${id}`, {});
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function remove(id: string) {
    if (!confirm('Remove this address?')) return;
    try {
      await api.del(`/buyer/addresses/${id}`);
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Your account</h1>
        {profile && !profile.checkoutReady && (
          <p className="mt-1.5 text-sm text-[hsl(var(--muted))]">
            Before you can check out we still need {profile.missing.join(', ')}.
          </p>
        )}
        {profile?.checkoutReady && (
          <p className="mt-1.5 text-sm text-[hsl(var(--muted))]">
            Everything we need is here — checkout will be quick.
          </p>
        )}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      <Card>
        <CardHeader title="Profile" description="How a merchant addresses your order." />
        <div className="space-y-4 px-5 py-5">
          <Field label="Name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="flex flex-wrap items-center gap-2 text-sm text-[hsl(var(--muted))]">
            {profile?.email && (
              <span className="flex items-center gap-1.5">
                {profile.email}
                <Badge tone={profile.emailVerified ? 'accent' : 'warn'}>
                  {profile.emailVerified ? 'verified' : 'unverified'}
                </Badge>
              </span>
            )}
            {profile?.phone && (
              <span className="flex items-center gap-1.5">
                {profile.phone}
                <Badge tone={profile.phoneVerified ? 'accent' : 'warn'}>
                  {profile.phoneVerified ? 'verified' : 'unverified'}
                </Badge>
              </span>
            )}
          </div>
          {/* Email and phone are managed by sign-in, not here: editing them in place would
              let the verified flag point at an address nobody has proven they own. */}
          <Button type="button" onClick={saveName} disabled={busy || !name.trim()}>
            Save name
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Addresses"
          description="Where orders go. The default is used unless you pick another at checkout."
        />

        {addresses.length === 0 && !adding ? (
          <Empty title="No addresses yet" reason="Add one now and checkout will be one step." />
        ) : (
          <ul className="divide-y divide-[hsl(var(--border))]">
            {addresses.map((address) => (
              <li key={address.id} className="flex items-start gap-4 px-5 py-4">
                <div className="min-w-0 flex-1 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{address.label || address.city}</span>
                    {address.isDefault && <Badge tone="accent">Default</Badge>}
                  </div>
                  <p className="mt-0.5 text-[hsl(var(--muted))]">
                    {address.recipientName} · {address.recipientPhone}
                  </p>
                  <p className="text-[hsl(var(--muted))]">
                    {[address.line1, address.line2, address.landmark].filter(Boolean).join(', ')},{' '}
                    {address.city}, {address.state} {address.pincode}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col gap-1 text-xs">
                  {!address.isDefault && (
                    <button
                      type="button"
                      className="underline"
                      onClick={() => void makeDefault(address.id)}
                    >
                      Make default
                    </button>
                  )}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => void remove(address.id)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="px-5 py-5">
          {adding ? (
            <form onSubmit={addAddress} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Label" hint="Home, Office — optional">
                  <input
                    className={inputClass}
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                  />
                </Field>
                <Field label="Recipient name">
                  <input
                    className={inputClass}
                    value={form.recipientName}
                    onChange={(e) => setForm({ ...form, recipientName: e.target.value })}
                  />
                </Field>
                <Field label="Recipient phone">
                  <input
                    className={inputClass}
                    value={form.recipientPhone}
                    onChange={(e) => setForm({ ...form, recipientPhone: e.target.value })}
                  />
                </Field>
                <Field label="PIN code" hint="Six digits">
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={form.pincode}
                    onChange={(e) =>
                      setForm({ ...form, pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })
                    }
                  />
                </Field>
              </div>
              <Field label="Address line 1">
                <input
                  className={inputClass}
                  value={form.line1}
                  onChange={(e) => setForm({ ...form, line1: e.target.value })}
                />
              </Field>
              <Field label="Address line 2" hint="Optional">
                <input
                  className={inputClass}
                  value={form.line2}
                  onChange={(e) => setForm({ ...form, line2: e.target.value })}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Landmark" hint="Optional">
                  <input
                    className={inputClass}
                    value={form.landmark}
                    onChange={(e) => setForm({ ...form, landmark: e.target.value })}
                  />
                </Field>
                <Field label="City">
                  <input
                    className={inputClass}
                    value={form.city}
                    onChange={(e) => setForm({ ...form, city: e.target.value })}
                  />
                </Field>
                <Field label="State">
                  <input
                    className={inputClass}
                    value={form.state}
                    onChange={(e) => setForm({ ...form, state: e.target.value })}
                  />
                </Field>
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>
                  {busy ? 'Saving…' : 'Save address'}
                </Button>
                <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button type="button" onClick={() => setAdding(true)}>
              Add an address
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
