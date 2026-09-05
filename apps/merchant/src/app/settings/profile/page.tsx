'use client';

import { useEffect, useState } from 'react';
import { api, describeError } from '../../../lib/api';
import { Badge, Button, Card, CardHeader, ErrorNote, Field, inputClass } from '../../../components/ui';

/**
 * The merchant's profile.
 *
 * The business name is on every search result, every product card and every order a buyer
 * sees, and until now it was whatever was typed into the sign-up form and could never be
 * changed. Someone who registered as "Kumar Textiles" and trades as "Loomfolk" had no way
 * to say so.
 *
 * A rename takes effect immediately: the name is joined live into search rather than copied
 * into the index, and it is not part of what gets embedded, so nothing has to be rebuilt.
 */

interface Profile {
  merchantId: string;
  businessName: string;
  legalName: string | null;
  contactEmail: string;
  contactPhone: string | null;
  gstin: string | null;
  gstinVerified: boolean;
  city: string | null;
  state: string | null;
  categories: string[];
  status: string;
  createdAt: string;
}

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [form, setForm] = useState<Partial<Profile>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Profile>('/merchant/profile')
      .then((p) => {
        setProfile(p);
        setForm(p);
      })
      .catch((err) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, []);

  function set<K extends keyof Profile>(key: K, value: Profile[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setNotice(null);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      const updated = await api.patch<Profile>('/merchant/profile', {
        businessName: (form.businessName ?? '').trim(),
        legalName: form.legalName ?? '',
        contactPhone: form.contactPhone ?? '',
        gstin: form.gstin ?? '',
        city: form.city ?? '',
        state: form.state ?? '',
        categories: form.categories ?? [],
      });
      setProfile(updated);
      setForm(updated);
      setNotice(
        updated.businessName !== profile?.businessName
          ? `Saved. Buyers and assistants see “${updated.businessName}” from the next search.`
          : 'Saved.',
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="py-10 text-sm text-[hsl(var(--muted))]">Loading…</p>;
  if (!profile) return <ErrorNote>{error ?? 'Could not load your profile.'}</ErrorNote>;

  const dirty = JSON.stringify(form) !== JSON.stringify(profile);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Your profile</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[hsl(var(--muted))]">
          This is what a buyer sees when your products come back in a search, here or inside
          Claude and ChatGPT.
        </p>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && (
        <p className="rounded-md bg-[hsl(var(--accent-soft))] px-4 py-3 text-sm">{notice}</p>
      )}

      <form onSubmit={save}>
        <Card>
          <CardHeader
            title="Business"
            description="The name on every result, card and order."
            action={<Badge tone={profile.status === 'active' ? 'accent' : 'warn'}>{profile.status}</Badge>}
          />
          <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">
            <Field label="Business name" hint="What buyers see. Changing it takes effect immediately.">
              <input
                className={inputClass}
                value={form.businessName ?? ''}
                onChange={(e) => set('businessName', e.target.value)}
                required
                minLength={2}
              />
            </Field>

            <Field label="Legal name" hint="If it differs from your trading name. Optional.">
              <input
                className={inputClass}
                value={form.legalName ?? ''}
                onChange={(e) => set('legalName', e.target.value)}
              />
            </Field>

            <Field label="City">
              <input
                className={inputClass}
                value={form.city ?? ''}
                onChange={(e) => set('city', e.target.value)}
              />
            </Field>

            <Field label="State">
              <input
                className={inputClass}
                value={form.state ?? ''}
                onChange={(e) => set('state', e.target.value)}
              />
            </Field>
          </div>
        </Card>

        <div className="h-4" />

        <Card>
          <CardHeader title="Contact" description="How we reach you about orders and problems." />
          <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">
            {/* Read-only, and the reason is stated rather than left as a disabled field
                nobody can explain: this is how the sign-in account is matched to this
                business, so changing it here would leave them signed in and unable to sign
                in again — a change that looks like it worked until the next session. */}
            <Field
              label="Email"
              hint="This is your sign-in address. Contact support to change it — it moves your login too."
            >
              <input className={`${inputClass} opacity-60`} value={profile.contactEmail} readOnly />
            </Field>

            <Field label="Phone" hint="10-digit Indian mobile. +91 is added if you leave it out.">
              <input
                className={inputClass}
                value={form.contactPhone ?? ''}
                onChange={(e) => set('contactPhone', e.target.value)}
                inputMode="tel"
                placeholder="98765 43210"
              />
            </Field>
          </div>
        </Card>

        <div className="h-4" />

        <Card>
          <CardHeader
            title="Tax"
            description="Shown to buyers who ask, and used on invoices."
            action={
              profile.gstin ? (
                <Badge tone={profile.gstinVerified ? 'accent' : 'neutral'}>
                  {profile.gstinVerified ? 'Verified' : 'Unverified'}
                </Badge>
              ) : undefined
            }
          />
          <div className="px-5 py-5">
            <Field
              label="GSTIN"
              hint="Optional. Changing it clears the verified mark until it is checked again."
            >
              <input
                className={`${inputClass} sm:max-w-xs`}
                value={form.gstin ?? ''}
                onChange={(e) => set('gstin', e.target.value.toUpperCase())}
                placeholder="29ABCDE1234F1Z5"
              />
            </Field>
          </div>
        </Card>

        <div className="mt-5 flex items-center gap-3">
          <Button type="submit" disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
          {dirty && (
            <button
              type="button"
              className="text-sm underline"
              onClick={() => {
                setForm(profile);
                setNotice(null);
              }}
            >
              Discard
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
