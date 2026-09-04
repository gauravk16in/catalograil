'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { authConfigured, useAuth } from '../lib/auth';

/**
 * The client-side route guard.
 *
 * This app is a static export, so there is no middleware and no server to redirect before
 * anything renders — the guard necessarily runs in the browser. That is acceptable here
 * because it is not what protects anything: every route's data comes from the API, and the
 * API rejects a request without a valid token regardless of what the browser chose to
 * render. This exists so a signed-out merchant sees a login screen instead of a page of
 * failed requests.
 */
const PUBLIC_PATHS = ['/login', '/signup', '/verify-email', '/forgot-password', '/reset-password'];


export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status, merchantId } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  useEffect(() => {
    if (status === 'signedOut' && !isPublic) router.replace('/login');
    if (status === 'signedIn' && isPublic) router.replace('/');
  }, [status, isPublic, router]);

  /**
   * A signed-in user with no merchant id has confirmed their account but the
   * post-confirmation trigger has not linked them yet — Cognito confirms first and runs the
   * trigger after, so this window is real. Onboarding is where that resolves itself.
   */
  useEffect(() => {
    if (status === 'signedIn' && !merchantId && !isPublic && pathname !== '/onboarding') {
      router.replace('/onboarding');
    }
  }, [status, merchantId, isPublic, pathname, router]);

  /**
   * When Cognito is not configured, the guard stands down entirely.
   *
   * A build without the pool ids would otherwise redirect every route to a login screen
   * that cannot work, which looks like a broken deployment rather than an unconfigured
   * one. The API is still the thing enforcing access.
   */
  if (!authConfigured()) return <>{children}</>;

  if (status === 'loading') {
    return <p className="py-10 text-sm text-[hsl(var(--muted))]">Loading…</p>;
  }
  if (status === 'signedOut' && !isPublic) return null;
  if (status === 'signedIn' && isPublic) return null;

  return <>{children}</>;
}
