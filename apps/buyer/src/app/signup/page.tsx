'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthCard, TextField, describeAuthError } from '../../components/auth-form';
import { useAuth } from '../../lib/auth';

/**
 * S2.6 — buyers sign up by phone or by email.
 *
 * Phone first, because an Indian buyer is far likelier to have a number they use everywhere
 * than an email address they check. The pool accepts either as an alias, so the choice here
 * is genuinely the buyer's rather than a fallback.
 */
export default function SignupPage() {
  const { signUp } = useAuth();
  const router = useRouter();
  const [method, setMethod] = useState<'phone' | 'email'>('phone');
  const [contact, setContact] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    // Cognito wants E.164. Typing a bare ten-digit Indian number is the common case, so it
    // is normalised here rather than rejected with a format lecture.
    const username =
      method === 'phone'
        ? contact.trim().startsWith('+')
          ? contact.trim()
          : `+91${contact.trim().replace(/\D/g, '')}`
        : contact.trim();

    try {
      await signUp(username, password, name.trim());
      router.push(`/verify?u=${encodeURIComponent(username)}`);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Create an account"
      description="You only need one to check out and track orders. Browsing needs nothing."
      error={error}
      submitLabel="Create account"
      busy={busy}
      onSubmit={submit}
      footer={
        <div className="flex justify-between">
          <Link href="/login" className="underline">
            Already have an account? Sign in
          </Link>
          <Link href="/" className="underline">
            Keep browsing
          </Link>
        </div>
      }
    >
      <div className="flex gap-1">
        {(['phone', 'email'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMethod(m);
              setContact('');
            }}
            className={`rounded-md px-3 py-1.5 text-sm ${
              method === m ? 'bg-[hsl(var(--accent-soft))] font-medium' : 'text-[hsl(var(--muted))]'
            }`}
          >
            {m === 'phone' ? 'Phone' : 'Email'}
          </button>
        ))}
      </div>

      <TextField label="Your name" value={name} onChange={setName} />
      {method === 'phone' ? (
        <TextField
          label="Phone"
          hint="We send a code by SMS. +91 is added if you leave it out."
          type="tel"
          value={contact}
          onChange={setContact}
          placeholder="98765 43210"
        />
      ) : (
        <TextField
          label="Email"
          type="email"
          value={contact}
          onChange={setContact}
          autoComplete="email"
        />
      )}
      <TextField
        label="Password"
        hint="At least 10 characters, with upper case, lower case and a digit."
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
      />
    </AuthCard>
  );
}
