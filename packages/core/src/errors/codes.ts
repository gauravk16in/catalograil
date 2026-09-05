/** Error codes are SCREAMING_SNAKE (conventions §9). Add here, never inline a string. */
export const ERROR_CODES = [
  // validation / request
  'VALIDATION_FAILED',
  'INVALID_ARCHETYPE',
  'UNSUPPORTED_IN_PHASE_1',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  // auth
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'INVALID_OAUTH_STATE',
  'OAUTH_EXCHANGE_FAILED',
  'MERCHANT_TOKEN_EXPIRED',
  'MERCHANT_SUSPENDED',
  /** No Razorpay connection at all (S3.4). Distinct from one that exists and is bad. */
  'PAYMENT_CONFIG_MISSING',
  /** Credentials exist but did not verify, or Razorpay has since rejected them. */
  'PAYMENT_CONFIG_INVALID',
  /** Razorpay refused or could not be reached while creating an order (T2.15). */
  'PAYMENT_CREATE_FAILED',
  /** Someone else took the last unit between search and checkout (T2.15). */
  'INSUFFICIENT_STOCK',
  /** The price moved between the cart snapshot and checkout (T2.15).*/
  'PRICE_MOVED',
  /**
   * A confirmed Cognito user whose post-confirmation trigger has not linked them to a
   * merchant or buyer row yet. Deliberately not UNAUTHENTICATED: the client must not clear
   * the session and bounce to the login screen, because signing in again yields the same
   * token. Retrying is what resolves it.
   */
  'ACCOUNT_NOT_LINKED',
  /** A handoff link that is malformed, forged, or already used (T2.14). */
  'INVALID_HANDOFF_TOKEN',
  /** A handoff link that was valid and is simply old — not the buyer's fault. */
  'HANDOFF_TOKEN_EXPIRED',
  // catalog / ingestion
  'CSV_HEADER_MISMATCH',
  'CSV_ROW_INVALID',
  'INGESTION_FAILED',
  'ENRICHMENT_FAILED',
  'EMBEDDING_FAILED',
  // policy
  'POLICY_URL_UNREACHABLE',
  'POLICY_URL_EMPTY',
  'POLICY_EXTRACTION_FAILED',
  'POLICIES_REQUIRED',
  // search
  'SEARCH_FAILED',
  'QUERY_EMBEDDING_FAILED',
  // commerce
  'OUT_OF_STOCK',
  'PRICE_CHANGED',
  'CHECKOUT_FAILED',
  'PAYMENT_VERIFICATION_FAILED',
  'ADAPTER_TIMEOUT',
  'ADAPTER_CIRCUIT_OPEN',
  // infrastructure
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
