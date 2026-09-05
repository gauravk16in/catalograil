'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthCard, TextField, describeAuthError } from '../../components/auth-form';
import { useAuth } from '../../lib/auth';

export default function SignupPage() {
  const { signUp } = useAuth();
  const router = useRouter();
  const [businessName, setBusinessName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { confirmed, signedIn } = await signUp(email.trim(), password, businessName.trim());
      // A pool that needs no code signs them in here, so they go straight to setting up
      // rather than to a login form asking for the password typed a second ago.
      if (!confirmed) {
        router.push(`/verify-email?email=${encodeURIComponent(email.trim())}`);
        return;
      }
      router.push(signedIn ? '/onboarding' : '/login');
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Create your account"
      description="List once, and be findable inside Claude and ChatGPT. No commission, and payment goes straight to your own Razorpay account."
      error={error}
      submitLabel="Create account"
      busy={busy}
      onSubmit={submit}
      footer={
        <Link href="/login" className="underline">
          Already have an account? Sign in
        </Link>
      }
    >
      <TextField
        label="Business name"
        hint="What buyers will see."
        value={businessName}
        onChange={setBusinessName}
        placeholder="Meridian Apparel"
      />
      <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
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
