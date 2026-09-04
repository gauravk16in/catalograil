'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '../lib/auth';

/**
 * The buyer's nav.
 *
 * Search is always reachable, signed in or not — browsing needs no account, and a nav that
 * hides everything behind a sign-in tells a first-time visitor there is nothing here.
 */
export function Nav() {
  const pathname = usePathname();
  const { status, signOut } = useAuth();

  const links = [
    { href: '/', label: 'Search' },
    { href: '/orders', label: 'Orders' },
    { href: '/account', label: 'Account' },
  ];

  return (
    <>
      <nav className="flex gap-1" aria-label="Main">
        {links.map((link) => {
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-md px-3 py-1.5 text-sm ${
                active ? 'bg-[hsl(var(--accent-soft))] font-medium' : 'text-[hsl(var(--muted))]'
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-3 text-xs text-[hsl(var(--muted))]">
        {status === 'signedIn' ? (
          <button type="button" onClick={() => void signOut()} className="underline">
            Sign out
          </button>
        ) : status === 'signedOut' ? (
          <Link href="/login" className="underline">
            Sign in
          </Link>
        ) : null}
      </div>
    </>
  );
}
