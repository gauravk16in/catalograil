'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

export interface MerchantSession {
  merchantId: string;
  businessName: string;
  contactEmail: string;
  status: string;
  capabilities: string[];
  onboarding: {
    connectedRazorpay: boolean;
    declaredCapabilities: boolean;
    policiesAccepted: boolean;
    nextStep: 'connect' | 'capabilities' | 'policies' | 'done';
  };
}

/**
 * The signed-in merchant.
 *
 * Loading and failure are distinct states rather than both meaning "no session": a
 * dashboard that renders its signed-out view during a slow request flickers, and one that
 * renders it on a network error tells the merchant they are logged out when they are not.
 */
export function useSession(): {
  session: MerchantSession | null;
  loading: boolean;
  error: string | null;
} {
  const [session, setSession] = useState<MerchantSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    api
      .get<MerchantSession>('/merchant/me')
      .then((value) => {
        if (!cancelled) setSession(value);
      })
      .catch(() => {
        // Not signed in is the common case here and is not an error worth showing.
        if (!cancelled) setError(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { session, loading, error };
}
