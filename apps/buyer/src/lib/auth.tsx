'use client';

import { Amplify } from 'aws-amplify';
import {
  autoSignIn,
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
 * S2.6 — buyer authentication against the Cognito buyer pool.
 *
 * Two decisions here are worth stating, because both are easy to get wrong in a way that
 * looks fine.
 *
 * **The ID token, not the access token.** Cognito puts custom attributes only on the ID
 * token, and `custom:buyer_id` is what identifies the merchant to the API. An access
 * token authenticates but carries no way to say *who* — the API would answer
 * ACCOUNT_NOT_LINKED for every request from a perfectly valid session.
 *
 * **Tokens live in memory, never in `localStorage`.** Amplify keeps the refresh token in
 * storage itself, which is the credential that has to survive a reload; the short-lived
 * token this module hands the API client is held in a closure so a script that gets onto
 * the page cannot read it out of storage.
 */

const USER_POOL_ID = process.env.NEXT_PUBLIC_BUYER_USER_POOL_ID ?? '';
const USER_POOL_CLIENT_ID = process.env.NEXT_PUBLIC_BUYER_USER_POOL_CLIENT_ID ?? '';

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
  readonly buyerId: string | null;
}

interface AuthContextValue extends AuthState {
  signIn(email: string, password: string): Promise<void>;
  signUp(
    email: string,
    password: string,
    name: string,
  ): Promise<{ confirmed: boolean; signedIn: boolean }>;
  confirmSignUp(email: string, code: string): Promise<{ signedIn: boolean }>;
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
    buyerId: null,
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
      setState({ status: 'signedOut', email: null, buyerId: null });
      return;
    }

    try {
      const session = await fetchAuthSession();
      const idToken = session.tokens?.idToken;
      if (!idToken) {
        setAuthToken(null);
        setState({ status: 'signedOut', email: null, buyerId: null });
        return;
      }

      setAuthToken(idToken.toString());
      const claims = idToken.payload;
      setState({
        status: 'signedIn',
        email: typeof claims.email === 'string' ? claims.email : null,
        buyerId:
          typeof claims['custom:buyer_id'] === 'string'
            ? (claims['custom:buyer_id'] as string)
            : null,
      });
    } catch {
      // Not signed in is the common path here, not an error worth surfacing.
      setAuthToken(null);
      setState({ status: 'signedOut', email: null, buyerId: null });
    }
  }, []);

  useEffect(() => {
    // The API client refreshes through this on a 401 rather than importing the auth
    // module, which would be a cycle.
    setTokenRefresher(currentIdToken);
    void refresh();
    return () => setTokenRefresher(null);
  }, [refresh]);

  /**
   * Finishes the sign-in Cognito is holding open, and tolerates it being unavailable.
   *
   * `autoSignIn` can legitimately have nothing to complete — the sign-up session expires,
   * or the account was confirmed from a different device than it was created on. That is a
   * reason to show the login form, not an error to put in front of someone who has just
   * successfully created an account.
   */
  const completeAutoSignIn = useCallback(async (): Promise<boolean> => {
    try {
      const result = await autoSignIn();
      return result.isSignedIn === true;
    } catch {
      // Left signed out. The caller routes to the login form, which is a normal next step
      // rather than a failure to report.
      return false;
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      async signIn(email, password) {
        configure();
        await signIn({ username: email, password, options: { authFlowType: 'USER_SRP_AUTH' } });
        await refresh();
      },
      async signUp(email, password, name) {
        configure();
        const result = await signUp({
          username: email,
          password,
          options: {
            userAttributes: { email, name },
            /**
             * Cognito keeps the sign-up session open so the account can be signed in the
             * moment it is confirmed.
             *
             * The alternative is holding the password in component state across a page
             * navigation and replaying it — which works, and puts a plaintext password in a
             * React tree for as long as someone takes to read a verification email. This
             * asks the identity provider to do it instead, and nothing has to keep the
             * password at all.
             */
            autoSignIn: true,
          },
        });

        if (!result.isSignUpComplete) return { confirmed: false, signedIn: false };

        const signedIn = await completeAutoSignIn();
        await refresh();
        return { confirmed: true, signedIn };
      },
      /**
       * Confirming the code is the last thing anyone should have to type.
       *
       * Sending someone to a login form immediately after they proved they own the address
       * asks them to re-enter the two things they just entered, and is where a good share
       * of people close the tab. The verification itself stays — it is the only evidence
       * the address is theirs — but it now ends signed in.
       */
      async confirmSignUp(email, code) {
        configure();
        const result = await confirmSignUp({ username: email, confirmationCode: code });

        const signedIn =
          result.nextStep?.signUpStep === 'COMPLETE_AUTO_SIGN_IN'
            ? await completeAutoSignIn()
            : false;

        await refresh();
        /**
         * Returned rather than read from `status` by the caller.
         *
         * `refresh` sets React state, which the component that awaited this cannot see until
         * it re-renders — so a page reading `status` here would route on the value from
         * before the sign-in, every time.
         */
        return { signedIn };
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
        setState({ status: 'signedOut', email: null, buyerId: null });
      },
      refresh,
    }),
    [state, refresh, completeAutoSignIn],
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
