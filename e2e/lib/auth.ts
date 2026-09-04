import { Amplify } from 'aws-amplify';
import { fetchAuthSession, signIn, signOut } from 'aws-amplify/auth';

/**
 * A real Cognito sign-in, producing the same ID token a browser would carry.
 *
 * The ID token, not the access token: Cognito puts custom attributes only on the former, and
 * `custom:merchant_id` is what identifies the merchant to the API.
 */
export interface Env {
  readonly apiBaseUrl: string;
  readonly merchantPoolId: string;
  readonly merchantClientId: string;
  readonly merchantEmail: string;
  readonly merchantPassword: string;
}

export function readEnv(): Env | null {
  const {
    API_BASE_URL,
    MERCHANT_USER_POOL_ID,
    MERCHANT_USER_POOL_CLIENT_ID,
    E2E_MERCHANT_EMAIL,
    E2E_MERCHANT_PASSWORD,
  } = process.env;

  if (
    !API_BASE_URL ||
    !MERCHANT_USER_POOL_ID ||
    !MERCHANT_USER_POOL_CLIENT_ID ||
    !E2E_MERCHANT_EMAIL ||
    !E2E_MERCHANT_PASSWORD
  ) {
    return null;
  }

  return {
    apiBaseUrl: API_BASE_URL,
    merchantPoolId: MERCHANT_USER_POOL_ID,
    merchantClientId: MERCHANT_USER_POOL_CLIENT_ID,
    merchantEmail: E2E_MERCHANT_EMAIL,
    merchantPassword: E2E_MERCHANT_PASSWORD,
  };
}

let cached: string | null = null;

export async function merchantToken(env: Env): Promise<string> {
  if (cached) return cached;

  Amplify.configure({
    Auth: {
      Cognito: { userPoolId: env.merchantPoolId, userPoolClientId: env.merchantClientId },
    },
  });

  // A leftover session from another run would otherwise make signIn throw.
  try {
    await signOut({ global: false });
  } catch {
    /* not signed in */
  }

  await signIn({
    username: env.merchantEmail,
    password: env.merchantPassword,
    options: { authFlowType: 'USER_SRP_AUTH' },
  });

  const token = (await fetchAuthSession({ forceRefresh: true })).tokens?.idToken?.toString();
  if (!token) throw new Error('Signed in but received no ID token.');
  cached = token;
  return token;
}

export async function apiRequest(
  env: Env,
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<Response> {
  const { token, ...rest } = init;
  const auth = token === null ? undefined : (token ?? (await merchantToken(env)));
  return fetch(`${env.apiBaseUrl}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...rest.headers,
    },
  });
}
