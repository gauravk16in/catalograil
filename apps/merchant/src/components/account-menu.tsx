'use client';

import { useAuth } from '../lib/auth';

/** Who is signed in, and the way out. Renders nothing when signed out. */
export function AccountMenu() {
  const { status, email, signOut } = useAuth();

  if (status !== 'signedIn') {
    return <div className="ml-auto text-xs text-[hsl(var(--muted))]">Merchant dashboard</div>;
  }

  return (
    <div className="ml-auto flex items-center gap-3 text-xs text-[hsl(var(--muted))]">
      <span className="hidden sm:inline">{email}</span>
      <button
        type="button"
        onClick={() => void signOut()}
        className="underline hover:text-[hsl(var(--fg))]"
      >
        Sign out
      </button>
    </div>
  );
}
