/**
 * The merchant dashboard's one door to the API.
 *
 * Every call goes through here rather than each component reaching for `fetch`, so the
 * session cookie, the error shape and the base URL are decided once. A dashboard that
 * scatters fetch calls ends up with five different ways of showing a failure.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    // The merchant session is an httpOnly cookie (T1.21), so it rides along rather than
    // being read and attached by JavaScript that could leak it.
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

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
