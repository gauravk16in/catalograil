'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthCard, TextField, describeAuthError } from '../../components/auth-form';
import { useAuth } from '../../lib/auth';

export default function ForgotPasswordPage() {
  const { forgotPassword } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await forgotPassword(email.trim());
      router.push(`/reset-password?email=${encodeURIComponent(email.trim())}`);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Reset your password"
      description="We will email a code to the address on your account."
      error={error}
      submitLabel="Send code"
      busy={busy}
      onSubmit={submit}
    >
      <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
    </AuthCard>
  );
}
