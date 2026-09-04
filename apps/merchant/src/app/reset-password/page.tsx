'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthCard, TextField, describeAuthError } from '../../components/auth-form';
import { useAuth } from '../../lib/auth';

function ResetPassword() {
  const { resetPassword } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await resetPassword(email.trim(), code.trim(), password);
      router.push('/login');
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Choose a new password"
      description="Enter the code we emailed you, and the password you want to use."
      error={error}
      submitLabel="Set password"
      busy={busy}
      onSubmit={submit}
    >
      <TextField label="Email" type="email" value={email} onChange={setEmail} />
      <TextField label="Code" value={code} onChange={setCode} placeholder="123456" />
      <TextField
        label="New password"
        hint="At least 10 characters, with upper case, lower case and a digit."
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
      />
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPassword />
    </Suspense>
  );
}
