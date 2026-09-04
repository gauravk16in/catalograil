'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthCard, TextField, describeAuthError } from '../../components/auth-form';
import { useAuth } from '../../lib/auth';

export default function LoginPage() {
  const { signIn } = useAuth();
  const router = useRouter();
  const [contact, setContact] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const raw = contact.trim();
    // A bare ten-digit number is a phone; anything with an @ is an email. Both are aliases
    // on the pool, so neither needs the buyer to say which they are using.
    const username = /^\d{10}$/.test(raw) ? `+91${raw}` : raw;

    try {
      await signIn(username, password);
      router.push('/account');
    } catch (err) {
      if ((err as { name?: string }).name === 'UserNotConfirmedException') {
        router.push(`/verify?u=${encodeURIComponent(username)}`);
        return;
      }
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Sign in"
      description="For your orders and saved addresses."
      error={error}
      submitLabel="Sign in"
      busy={busy}
      onSubmit={submit}
      footer={
        <div className="flex justify-between">
          <Link href="/signup" className="underline">
            Create an account
          </Link>
          <Link href="/" className="underline">
            Keep browsing
          </Link>
        </div>
      }
    >
      <TextField
        label="Phone or email"
        value={contact}
        onChange={setContact}
        placeholder="98765 43210"
      />
      <TextField
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
      />
    </AuthCard>
  );
}
