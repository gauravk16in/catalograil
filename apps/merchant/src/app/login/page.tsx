'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthCard, TextField, describeAuthError } from '../../components/auth-form';
import { useAuth } from '../../lib/auth';

export default function LoginPage() {
  const { signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      router.push('/');
    } catch (err) {
      // An unverified account is a redirect, not an error: they have an account and a
      // code waiting, so send them where they can use it.
      if ((err as { name?: string }).name === 'UserNotConfirmedException') {
        router.push(`/verify-email?email=${encodeURIComponent(email.trim())}`);
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
      description="Your catalogue, your policies, and where you rank."
      error={error}
      submitLabel="Sign in"
      busy={busy}
      onSubmit={submit}
      footer={
        <div className="flex justify-between">
          <Link href="/signup" className="underline">
            Create an account
          </Link>
          <Link href="/forgot-password" className="underline">
            Forgot password
          </Link>
        </div>
      }
    >
      <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
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
