import {
  AppError,
  MERCHANT_CAPABILITIES,
  PHASE_1_CAPABILITIES,
  type Clock,
  type MerchantCapability,
} from '@catalograil/core';
import {
  merchantCapabilities,
  merchantPolicies,
  merchantTokens,
  merchants,
  type Database,
} from '@catalograil/db';
import {
  buildAuthorizeRedirect,
  exchangeAuthorizationCode,
  policiesAreComplete,
  describePolicyFailures,
  revokeToken,
  type ExtractedPolicies,
  type OAuthConfig,
  type OAuthStateStore,
  type PolicyExtractor,
  type PolicyFetcher,
  type PolicyKind,
  type TokenCipher,
} from '@catalograil/razorpay';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

/**
 * Merchant onboarding: OAuth (T1.6), profile and capabilities (T1.8), policies (T1.9).
 *
 * The shape of the whole flow is a gate. A merchant is `pending` until they have connected
 * Razorpay, declared a capability, and supplied three policy URLs that actually resolve;
 * only then do they become `active` and their products become searchable. Each of those is
 * enforced here rather than assumed, because every one of them is something a buyer relies
 * on downstream.
 */

// Raw SQL fragments, kept named rather than inline so an ON CONFLICT clause stays readable.
const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`);
const sqlIncrement = (column: string) => sql.raw(`${column} + 1`);
const sqlZero = () => sql.raw('0');

export interface OnboardingDeps {
  readonly db: Database;
  readonly oauthConfig: OAuthConfig;
  readonly stateStore: OAuthStateStore;
  /** Built per merchant, since the cipher binds to their id as encryption context. */
  readonly cipherFor: (merchantId: string) => TokenCipher;
  readonly policyFetcher: PolicyFetcher;
  readonly policyExtractor: PolicyExtractor;
  readonly clock: Clock;
}

// ─── T1.6: OAuth ───────────────────────────────────────────────────────────────────

export async function startOAuth(
  deps: OnboardingDeps,
  options: { returnTo?: string } = {},
): Promise<{ redirectUrl: string }> {
  const { url } = await buildAuthorizeRedirect(deps.oauthConfig, deps.stateStore, options);
  return { redirectUrl: url };
}

export const oauthCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export interface OAuthCallbackResult {
  readonly merchantId: string;
  readonly created: boolean;
  readonly status: string;
  readonly returnTo?: string;
}

/**
 * Completes the exchange and stores the merchant plus their encrypted tokens.
 *
 * Written as one transaction on purpose: a merchant row without tokens is a merchant who
 * appears connected and cannot take a payment, which is worse than one who has to
 * reconnect.
 */
export async function completeOAuth(
  deps: OnboardingDeps,
  params: { code: string; state: string; contactEmail?: string; businessName?: string },
): Promise<OAuthCallbackResult> {
  const { tokens, payload } = await exchangeAuthorizationCode(deps.oauthConfig, deps.stateStore, {
    code: params.code,
    state: params.state,
  });

  const accountId = tokens.razorpayAccountId ?? null;

  return deps.db.transaction(async (tx) => {
    const existing = accountId
      ? await tx
          .select({ id: merchants.id, status: merchants.status })
          .from(merchants)
          .where(eq(merchants.razorpayAccountId, accountId))
          .limit(1)
      : [];

    let merchantId: string;
    let created = false;
    let status = 'pending';

    if (existing[0]) {
      merchantId = existing[0].id;
      status = existing[0].status;
      await tx
        .update(merchants)
        .set({ updatedAt: deps.clock.now() })
        .where(eq(merchants.id, merchantId));
    } else {
      const inserted = await tx
        .insert(merchants)
        .values({
          businessName: params.businessName ?? 'Unnamed merchant',
          contactEmail: params.contactEmail ?? `unknown+${accountId ?? 'new'}@catalograil.invalid`,
          razorpayAccountId: accountId,
          status: 'pending',
        })
        .returning({ id: merchants.id });
      merchantId = inserted[0]!.id;
      created = true;
    }

    // Rule 3: encrypted before it is ever written, with the merchant id as context.
    const cipher = deps.cipherFor(merchantId);
    const [accessToken, refreshToken] = await Promise.all([
      cipher.encrypt(tokens.accessToken),
      cipher.encrypt(tokens.refreshToken),
    ]);

    await tx
      .insert(merchantTokens)
      .values({
        merchantId,
        accessToken,
        refreshToken,
        accessExpiresAt: tokens.accessExpiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
        scopes: tokens.scopes,
        lastRefreshedAt: deps.clock.now(),
        refreshFailures: 0,
      })
      .onConflictDoUpdate({
        target: merchantTokens.merchantId,
        set: {
          accessToken,
          refreshToken,
          accessExpiresAt: tokens.accessExpiresAt,
          refreshExpiresAt: tokens.refreshExpiresAt,
          scopes: tokens.scopes,
          lastRefreshedAt: deps.clock.now(),
          // A successful reconnect clears the failure count, or a merchant who fixed the
          // problem stays one failure away from suspension forever.
          refreshFailures: 0,
        },
      });

    return {
      merchantId,
      created,
      status,
      ...(payload.returnTo ? { returnTo: payload.returnTo } : {}),
    };
  });
}

export async function revokeMerchantAccess(
  deps: OnboardingDeps,
  merchantId: string,
): Promise<void> {
  const rows = await deps.db
    .select({ accessToken: merchantTokens.accessToken })
    .from(merchantTokens)
    .where(eq(merchantTokens.merchantId, merchantId))
    .limit(1);

  if (rows[0]) {
    const plaintext = await deps.cipherFor(merchantId).decrypt(rows[0].accessToken);
    // Best effort: Razorpay may already consider it dead, and our own state is what matters.
    await revokeToken(deps.oauthConfig, plaintext).catch(() => {});
  }

  await deps.db.transaction(async (tx) => {
    await tx.delete(merchantTokens).where(eq(merchantTokens.merchantId, merchantId));
    // Rule 15: with no token their products cannot be sold, so they must leave search.
    await tx.update(merchants).set({ status: 'suspended' }).where(eq(merchants.id, merchantId));
  });
}

// ─── T1.8: profile and capabilities ────────────────────────────────────────────────

export const merchantProfileSchema = z.object({
  businessName: z.string().trim().min(1).max(300),
  legalName: z.string().trim().max(300).optional(),
  contactEmail: z.string().email(),
  contactPhone: z.string().trim().max(20).optional(),
  gstin: z.string().trim().length(15).optional(),
  categories: z.array(z.string().trim().min(1)).max(20).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
});

export async function upsertProfile(
  deps: OnboardingDeps,
  merchantId: string,
  body: unknown,
): Promise<{ merchantId: string }> {
  const parsed = merchantProfileSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'The merchant profile is not valid.', {
      details: { issues: parsed.error.issues },
    });
  }

  await deps.db
    .update(merchants)
    .set({ ...parsed.data, updatedAt: deps.clock.now() })
    .where(eq(merchants.id, merchantId));

  return { merchantId };
}

export const capabilitiesSchema = z.object({
  capabilities: z.array(z.enum(MERCHANT_CAPABILITIES)).min(1),
});

export interface CapabilityResult {
  readonly capability: MerchantCapability;
  readonly enabled: boolean;
  /** T1.8: the non-Phase-1 capabilities are recorded but not yet usable. */
  readonly availableInPhase3?: true;
}

/**
 * Declares capabilities.
 *
 * T1.8 asks that the Phase 3 capabilities be *accepted and stored* rather than rejected,
 * and reported as unavailable. That is the right call: a merchant telling us they do live
 * pricing is information worth having now, and refusing the declaration would mean asking
 * them again later.
 */
export async function declareCapabilities(
  deps: OnboardingDeps,
  merchantId: string,
  body: unknown,
): Promise<{ capabilities: CapabilityResult[] }> {
  const parsed = capabilitiesSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Choose at least one capability.', {
      details: { issues: parsed.error.issues, available: MERCHANT_CAPABILITIES },
    });
  }

  const results: CapabilityResult[] = parsed.data.capabilities.map((capability) => {
    const live = (PHASE_1_CAPABILITIES as readonly string[]).includes(capability);
    return live
      ? { capability, enabled: true }
      : { capability, enabled: false, availableInPhase3: true as const };
  });

  await deps.db
    .insert(merchantCapabilities)
    .values(results.map((r) => ({ merchantId, capability: r.capability, enabled: r.enabled })))
    .onConflictDoUpdate({
      target: [merchantCapabilities.merchantId, merchantCapabilities.capability],
      set: { enabled: sqlExcluded('enabled') },
    });

  return { capabilities: results };
}

// ─── T1.9: policies ────────────────────────────────────────────────────────────────

export const policiesSchema = z.object({
  refundUrl: z.string().url(),
  termsUrl: z.string().url(),
  fulfillmentUrl: z.string().url(),
});

export interface PolicySubmissionResult {
  readonly accepted: boolean;
  readonly status: string;
  readonly failures: string[];
  readonly extracted?: ExtractedPolicies;
}

/**
 * Validates the three URLs, extracts their terms, and activates the merchant if they pass.
 *
 * The order matters: fetch first, and only call the extractor if every page resolved. A
 * merchant with a 404 gets a specific, actionable error in about a second rather than
 * waiting on a model call that was never going to produce anything.
 */
export async function submitPolicies(
  deps: OnboardingDeps,
  merchantId: string,
  body: unknown,
): Promise<PolicySubmissionResult> {
  const parsed = policiesSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'All three policy URLs are required.', {
      details: { issues: parsed.error.issues },
    });
  }

  const targets: [PolicyKind, string][] = [
    ['refund', parsed.data.refundUrl],
    ['terms', parsed.data.termsUrl],
    ['fulfillment', parsed.data.fulfillmentUrl],
  ];

  const results = await Promise.all(
    targets.map(([kind, url]) => deps.policyFetcher.fetch(kind, url)),
  );

  if (!policiesAreComplete(results)) {
    const failures = describePolicyFailures(results);
    await recordPolicyCheck(
      deps,
      merchantId,
      parsed.data,
      null,
      results[0]?.status ?? 'unreachable',
      true,
    );

    throw new AppError('POLICY_URL_UNREACHABLE', 'One or more policy pages could not be read.', {
      details: { failures },
    });
  }

  const extracted = await deps.policyExtractor.extract(results);
  await recordPolicyCheck(deps, merchantId, parsed.data, extracted, 'ok', false);

  /**
   * Activation happens here, and only here. Policies are the last gate, so passing them is
   * what makes a merchant's catalogue visible — and the trigger from T1.16 propagates the
   * status change to searchable_units in the same transaction.
   */
  await deps.db
    .update(merchants)
    .set({ status: 'active', onboardedAt: deps.clock.now(), updatedAt: deps.clock.now() })
    .where(eq(merchants.id, merchantId));

  return { accepted: true, status: 'active', failures: [], extracted };
}

async function recordPolicyCheck(
  deps: OnboardingDeps,
  merchantId: string,
  urls: z.infer<typeof policiesSchema>,
  extracted: ExtractedPolicies | null,
  status: string,
  failed: boolean,
): Promise<void> {
  const values = {
    merchantId,
    refundUrl: urls.refundUrl,
    termsUrl: urls.termsUrl,
    fulfillmentUrl: urls.fulfillmentUrl,
    refundSummary: extracted?.refundSummary ?? null,
    termsSummary: extracted?.termsSummary ?? null,
    fulfillmentSummary: extracted?.fulfillmentSummary ?? null,
    returnWindowDays: extracted?.returnWindowDays ?? null,
    returnShippingBy: extracted?.returnShippingBy ?? null,
    dispatchSlaHours: extracted?.dispatchSlaHours ?? null,
    lastCheckedAt: deps.clock.now(),
    lastCheckStatus: status,
    consecutiveFailures: failed ? 1 : 0,
  };

  await deps.db
    .insert(merchantPolicies)
    .values(values)
    .onConflictDoUpdate({
      target: merchantPolicies.merchantId,
      set: {
        ...values,
        // Counted rather than reset, because three consecutive failures suspend the
        // merchant (T1.9) and a reset here would mean that never happens.
        consecutiveFailures: failed
          ? sqlIncrement('merchant_policies.consecutive_failures')
          : sqlZero(),
      },
    });
}
