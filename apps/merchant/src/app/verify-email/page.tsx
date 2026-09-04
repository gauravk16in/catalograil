'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthCard, TextField, describeAuthError } from '../../components/auth-form';
import { useAuth } from '../../lib/auth';

function VerifyEmail() {
  const { confirmSignUp, resendCode } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await confirmSignUp(email.trim(), code.trim());
      router.push('/login');
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setError(null);
    try {
      await resendCode(email.trim());
      setNotice('A new code is on its way.');
    } catch (err) {
      setError(describeAuthError(err));
    }
  }

  return (
    <AuthCard
      title="Verify your email"
      description="We sent a six-digit code. It confirms the address we will send order notifications to."
      error={error}
      notice={notice}
      submitLabel="Verify"
      busy={busy}
      onSubmit={submit}
      footer={
        <button type="button" onClick={resend} className="underline">
          Send another code
        </button>
      }
    >
      <TextField label="Email" type="email" value={email} onChange={setEmail} />
      <TextField label="Code" value={code} onChange={setCode} placeholder="123456" />
    </AuthCard>
  );
}

export default function VerifyEmailPage() {
  // `useSearchParams` needs a Suspense boundary in a statically exported app.
  return (
    <Suspense fallback={null}>
      <VerifyEmail />
    </Suspense>
  );
}
