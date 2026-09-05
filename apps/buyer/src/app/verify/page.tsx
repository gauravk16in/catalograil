'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthCard, TextField, describeAuthError } from '../../components/auth-form';
import { useAuth } from '../../lib/auth';

function Verify() {
  const { confirmSignUp, resendCode } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = useState(params.get('u') ?? '');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { signedIn } = await confirmSignUp(username.trim(), code.trim());
      /**
       * Signed in by the time this resolves, so the destination is the thing they came for.
       *
       * If the automatic sign-in could not be completed — an expired sign-up session, or a
       * code confirmed on a different device than it was requested from — the login page is
       * where they land instead, and it is a normal sign-in rather than an error.
       */
      router.push(signedIn ? '/' : '/login');
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Enter your code"
      description="We sent a six-digit code to confirm we can reach you."
      error={error}
      notice={notice}
      submitLabel="Verify"
      busy={busy}
      onSubmit={submit}
      footer={
        <button
          type="button"
          className="underline"
          onClick={async () => {
            try {
              await resendCode(username.trim());
              setNotice('A new code is on its way.');
            } catch (err) {
              setError(describeAuthError(err));
            }
          }}
        >
          Send another code
        </button>
      }
    >
      <TextField label="Phone or email" value={username} onChange={setUsername} />
      <TextField label="Code" value={code} onChange={setCode} placeholder="123456" />
    </AuthCard>
  );
}

export default function VerifyPage() {
  // `useSearchParams` needs a Suspense boundary in a statically exported app.
  return (
    <Suspense fallback={null}>
      <Verify />
    </Suspense>
  );
}
