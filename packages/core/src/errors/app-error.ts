import type { ErrorCode } from './codes.js';

export interface AppErrorOptions {
  httpStatus?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * The single error type crossing every boundary (conventions §9).
 * Handlers catch this and serialise it; anything else becomes INTERNAL_ERROR.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? defaultHttpStatus(code);
    this.retryable = options.retryable ?? defaultRetryable(code);
    if (options.details) this.details = options.details;
  }

  /**
   * Wire shape. Deliberately excludes `cause` and the stack — never leak internals
   * (never-do #4: no tokens, internal IDs or adapter credentials in a response).
   */
  toJSON(): {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }

  static from(err: unknown): AppError {
    if (err instanceof AppError) return err;
    return new AppError('INTERNAL_ERROR', 'An unexpected error occurred.', { cause: err });
  }
}

function defaultHttpStatus(code: ErrorCode): number {
  switch (code) {
    case 'VALIDATION_FAILED':
    case 'INVALID_ARCHETYPE':
    case 'CSV_HEADER_MISMATCH':
    case 'CSV_ROW_INVALID':
    case 'POLICIES_REQUIRED':
      return 400;
    case 'UNAUTHENTICATED':
    case 'INVALID_OAUTH_STATE':
      return 401;
    case 'FORBIDDEN':
    case 'MERCHANT_SUSPENDED':
    case 'MERCHANT_TOKEN_EXPIRED':
    case 'UNSUPPORTED_IN_PHASE_1':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
    case 'OUT_OF_STOCK':
    case 'PRICE_CHANGED':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'ADAPTER_TIMEOUT':
    case 'ADAPTER_CIRCUIT_OPEN':
    case 'DEPENDENCY_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
}

function defaultRetryable(code: ErrorCode): boolean {
  switch (code) {
    case 'RATE_LIMITED':
    case 'ADAPTER_TIMEOUT':
    case 'DEPENDENCY_UNAVAILABLE':
    case 'INTERNAL_ERROR':
    case 'EMBEDDING_FAILED':
    case 'QUERY_EMBEDDING_FAILED':
      return true;
    default:
      return false;
  }
}
