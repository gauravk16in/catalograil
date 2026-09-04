/**
 * The merchant dashboard's one door to the API.
 *
 * Every call goes through here rather than each component reaching for `fetch`, so the
 * session cookie, the error shape and the base URL are decided once. A dashboard that
 * scatters fetch calls ends up with five different ways of showing a failure.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

/**
 * The caller's bearer token, set once at sign-in rather than read from storage per request.
 *
 * Kept in memory deliberately: an access token in `localStorage` is readable by any script
 * that ends up on the page, and the refresh token is what survives a reload. This is the
 * seam Cognito plugs into — until it does, no token is set and merchant routes stay behind
 * the gateway's IAM authorization.
 */
let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

/** How the client gets a fresh token after a 401. Injected to avoid an import cycle. */
let refreshToken: (() => Promise<string | null>) | null = null;

export function setTokenRefresher(fn: (() => Promise<string | null>) | null): void {
  refreshToken = fn;
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init: RequestInit = {}, isRetry = false): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    /**
     * No `credentials: 'include'`.
     *
     * It was here for an httpOnly session cookie that the API never issued — there is no
     * `Set-Cookie` anywhere in the backend. What it did do was make every request
     * credentialed, which browsers refuse against the wildcard `Access-Control-Allow-Origin`
     * the API returned, so it broke the calls it was meant to authenticate. Identity travels
     * in the Authorization header instead, which needs no cross-site cookie rules at all.
     */
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...init.headers,
    },
  });

  // One retry on 401, and exactly one: a second is taken at face value rather than looping.
  if (response.status === 401 && refreshToken && !isRetry) {
    const fresh = await refreshToken();
    if (fresh) {
      authToken = fresh;
      return request<T>(path, init, true);
    }
  }

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      (body as ApiError) ?? { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
    );
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/**
 * Turns any thrown value into a sentence a merchant can act on.
 *
 * Validation errors carry per-field issues, and surfacing the first one is far more useful
 * than "the product is not valid" — a merchant should not have to guess which field.
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const issues = error.body.details?.issues;
    if (Array.isArray(issues) && issues.length > 0) {
      const first = issues[0] as { path?: unknown[]; message?: string };
      const field = Array.isArray(first.path)
        ? first.path.filter((p) => typeof p === 'string').join('.')
        : '';
      return field ? `${field}: ${first.message}` : (first.message ?? error.message);
    }

    const failures = error.body.details?.failures;
    if (Array.isArray(failures) && failures.length > 0) return String(failures[0]);

    return error.body.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}
