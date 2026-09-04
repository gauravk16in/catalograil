'use client';

import { Amplify } from 'aws-amplify';
import {
  confirmSignUp,
  confirmResetPassword,
  fetchAuthSession,
  getCurrentUser,
  resendSignUpCode,
  resetPassword,
  signIn,
  signOut,
  signUp,
} from 'aws-amplify/auth';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { setAuthToken, setTokenRefresher } from './api';

/**
 * S2.5 — merchant authentication against the Cognito merchant pool.
 *
 * Two decisions here are worth stating, because both are easy to get wrong in a way that
 * looks fine.
 *
 * **The ID token, not the access token.** Cognito puts custom attributes only on the ID
 * token, and `custom:merchant_id` is what identifies the merchant to the API. An access
 * token authenticates but carries no way to say *who* — the API would answer
 * ACCOUNT_NOT_LINKED for every request from a perfectly valid session.
 *
 * **Tokens live in memory, never in `localStorage`.** Amplify keeps the refresh token in
 * storage itself, which is the credential that has to survive a reload; the short-lived
 * token this module hands the API client is held in a closure so a script that gets onto
 * the page cannot read it out of storage.
 */

const USER_POOL_ID = process.env.NEXT_PUBLIC_MERCHANT_USER_POOL_ID ?? '';
const USER_POOL_CLIENT_ID = process.env.NEXT_PUBLIC_MERCHANT_USER_POOL_CLIENT_ID ?? '';

let configured = false;
function configure(): void {
  if (configured || !USER_POOL_ID || !USER_POOL_CLIENT_ID) return;
  Amplify.configure({
    Auth: { Cognito: { userPoolId: USER_POOL_ID, userPoolClientId: USER_POOL_CLIENT_ID } },
  });
  configured = true;
}

export interface AuthState {
  readonly status: 'loading' | 'signedIn' | 'signedOut';
  readonly email: string | null;
  /** Our merchant id, from the token claim — not from any API response. */
  readonly merchantId: string | null;
}

interface AuthContextValue extends AuthState {
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, businessName: string): Promise<{ confirmed: boolean }>;
  confirmSignUp(email: string, code: string): Promise<void>;
  resendCode(email: string): Promise<void>;
  forgotPassword(email: string): Promise<void>;
  resetPassword(email: string, code: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    status: 'loading',
    email: null,
    merchantId: null,
  });

  /**
   * Reads the current session and publishes the ID token to the API client.
   *
   * `fetchAuthSession` refreshes the token when it is close to expiry, so calling this on
   * mount and after every auth transition is what keeps a long-lived dashboard tab working
   * without a visible re-login.
   */
  const refresh = useCallback(async () => {
    configure();
    if (!USER_POOL_ID) {
      setState({ status: 'signedOut', email: null, merchantId: null });
      return;
    }

    try {
      const session = await fetchAuthSession();
      const idToken = session.tokens?.idToken;
      if (!idToken) {
        setAuthToken(null);
        setState({ status: 'signedOut', email: null, merchantId: null });
        return;
      }

      setAuthToken(idToken.toString());
      const claims = idToken.payload;
      setState({
        status: 'signedIn',
        email: typeof claims.email === 'string' ? claims.email : null,
        merchantId:
          typeof claims['custom:merchant_id'] === 'string'
            ? (claims['custom:merchant_id'] as string)
            : null,
      });
    } catch {
      // Not signed in is the common path here, not an error worth surfacing.
      setAuthToken(null);
      setState({ status: 'signedOut', email: null, merchantId: null });
    }
  }, []);

  useEffect(() => {
    // The API client refreshes through this on a 401 rather than importing the auth
    // module, which would be a cycle.
    setTokenRefresher(currentIdToken);
    void refresh();
    return () => setTokenRefresher(null);
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      async signIn(email, password) {
        configure();
        await signIn({ username: email, password, options: { authFlowType: 'USER_SRP_AUTH' } });
        await refresh();
      },
      async signUp(email, password, businessName) {
        configure();
        const result = await signUp({
          username: email,
          password,
          options: { userAttributes: { email, name: businessName } },
        });
        return { confirmed: result.isSignUpComplete };
      },
      async confirmSignUp(email, code) {
        configure();
        await confirmSignUp({ username: email, confirmationCode: code });
      },
      async resendCode(email) {
        configure();
        await resendSignUpCode({ username: email });
      },
      async forgotPassword(email) {
        configure();
        await resetPassword({ username: email });
      },
      async resetPassword(email, code, password) {
        configure();
        await confirmResetPassword({
          username: email,
          confirmationCode: code,
          newPassword: password,
        });
      },
      async signOut() {
        configure();
        // Global, so the refresh token is revoked rather than merely forgotten by this tab.
        await signOut({ global: true });
        setAuthToken(null);
        setState({ status: 'signedOut', email: null, merchantId: null });
      },
      refresh,
    }),
    [state, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}

/** Whether Cognito is configured at all — false in a build with no pool wired yet. */
export function authConfigured(): boolean {
  return Boolean(USER_POOL_ID && USER_POOL_CLIENT_ID);
}

/** Exposed for the API client's 401 retry: gets a fresh ID token, refreshing if needed. */
export async function currentIdToken(): Promise<string | null> {
  configure();
  try {
    const session = await fetchAuthSession({ forceRefresh: true });
    return session.tokens?.idToken?.toString() ?? null;
  } catch {
    return null;
  }
}

export { getCurrentUser };
