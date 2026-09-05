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
import { reconcileMerchantStatus } from './activation.js';

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

/**
 * What policy submission actually needs.
 *
 * Narrower than `OnboardingDeps` on purpose. Policies have nothing to do with Razorpay
 * OAuth, and requiring the full set meant this endpoint could not be routed without
 * constructing an OAuth config and a KMS cipher it never touches — which is why the
 * dashboard's policy page returned "No route for POST /merchant/policies" long after the
 * handler behind it was written and tested.
 */
export interface PolicyDeps {
  readonly db: Database;
  readonly policyFetcher: PolicyFetcher;
  readonly policyExtractor: PolicyExtractor;
  readonly clock: Clock;
}

export interface OnboardingDeps extends PolicyDeps {
  readonly oauthConfig: OAuthConfig;
  readonly stateStore: OAuthStateStore;
  /** Built per merchant, since the cipher binds to their id as encryption context. */
  readonly cipherFor: (merchantId: string) => TokenCipher;
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

/**
 * Policies arrive as URLs *or* as pasted text.
 *
 * Most small Indian merchants sell through WhatsApp and Instagram and have no website to
 * host a refund page on. Requiring a URL excluded exactly the merchants this platform exists
 * for, and pushed the rest into publishing a page they never look at again — which then goes
 * stale and fails the weekly check.
 *
 * Pasted text is in some ways the better source: it is what the merchant actually means
 * today, it cannot 404, and it needs no fetch before a buyer's question can be answered.
 */
export const policiesSchema = z
  .object({
    refundUrl: z.string().url().optional(),
    termsUrl: z.string().url().optional(),
    fulfillmentUrl: z.string().url().optional(),
    // Long enough for a real policy, capped because the extractor truncates at 12k anyway.
    refundText: z.string().trim().min(40).max(20_000).optional(),
    termsText: z.string().trim().min(40).max(20_000).optional(),
    fulfillmentText: z.string().trim().min(40).max(20_000).optional(),
  })
  .superRefine((value, ctx) => {
    for (const kind of ['refund', 'terms', 'fulfillment'] as const) {
      const hasUrl = Boolean(value[`${kind}Url` as const]);
      const hasText = Boolean(value[`${kind}Text` as const]);
      if (!hasUrl && !hasText) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [`${kind}Text`],
          // Names both options, because a merchant who has neither needs to know a link is
          // not the only way through.
          message: `Give your ${kind} policy as a link or paste the text.`,
        });
      }
    }
  });

export interface PolicySubmissionResult {
  readonly accepted: boolean;
  readonly status: string;
  readonly failures: string[];
  readonly extracted?: ExtractedPolicies;
  /**
   * Anything still keeping the merchant out of search after this succeeded.
   *
   * Accepted policies no longer imply an active merchant, so a merchant whose submission
   * worked but who has not connected Razorpay needs to be told that here rather than
   * discovering it as an empty search result.
   */
  readonly blockers?: string[];
}

/**
 * Validates the three URLs, extracts their terms, and re-evaluates whether the merchant can
 * be visible to buyers.
 *
 * The order matters: fetch first, and only call the extractor if every page resolved. A
 * merchant with a 404 gets a specific, actionable error in about a second rather than
 * waiting on a model call that was never going to produce anything.
 */
export async function submitPolicies(
  deps: PolicyDeps,
  merchantId: string,
  body: unknown,
): Promise<PolicySubmissionResult> {
  const parsed = policiesSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Each policy needs a link or some text.', {
      details: { issues: parsed.error.issues },
    });
  }

  const input = parsed.data;
  const kinds: PolicyKind[] = ['refund', 'terms', 'fulfillment'];

  /**
   * Pasted text short-circuits the fetch entirely.
   *
   * It is already the content, so fetching would be a round trip to confirm something we
   * were handed — and a merchant who pasted their policy should not have their submission
   * fail because an unrelated URL of theirs is down.
   */
  const results = await Promise.all(
    kinds.map(async (kind) => {
      const text = input[`${kind}Text` as const];
      if (text) {
        return { kind, url: `pasted:${kind}`, status: 'ok' as const, text };
      }
      const url = input[`${kind}Url` as const]!;
      return deps.policyFetcher.fetch(kind, url);
    }),
  );

  if (!policiesAreComplete(results)) {
    const failures = describePolicyFailures(results);
    await recordPolicyCheck(deps, merchantId, input, results, null, results.find((r) => r.status !== 'ok')?.status ?? 'unreachable', true);

    throw new AppError('POLICY_URL_UNREACHABLE', 'One or more policy pages could not be read.', {
      details: { failures },
    });
  }

  const extracted = await deps.policyExtractor.extract(results);
  await recordPolicyCheck(deps, merchantId, input, results, extracted, 'ok', false);

  /**
   * Policies are one of two gates, not the last one.
   *
   * They used to activate a merchant outright, which was right when Razorpay OAuth was step
   * one — anyone reaching this point necessarily had a token. DC1 and DC2 made identity and
   * payment independent, so that stopped holding silently: a merchant could accept policies
   * with no payment connection and have their catalogue go live, where a buyer would pick a
   * product and then be unable to pay for it.
   */
  const activation = await reconcileMerchantStatus(deps.db, merchantId, deps.clock.now());

  return {
    accepted: true,
    status: activation.status,
    failures: [],
    extracted,
    // Named so the dashboard can say what is still needed rather than leaving a merchant
    // wondering why "accepted" did not make them live.
    blockers: activation.blockers,
  };
}

async function recordPolicyCheck(
  deps: PolicyDeps,
  merchantId: string,
  input: z.infer<typeof policiesSchema>,
  fetched: readonly { kind: string; text?: string | undefined }[] | null,
  extracted: ExtractedPolicies | null,
  status: string,
  failed: boolean,
): Promise<void> {
  /**
   * The full text is stored whichever way it arrived.
   *
   * A summary answers "how long do I have to return this"; only the text answers "does that
   * apply to sale items". Without it a model asked the second question can only refuse or
   * invent, and inventing a policy term is the worst thing it can do here.
   */
  const textFor = (kind: string): string | null =>
    fetched?.find((r) => r.kind === kind)?.text?.slice(0, 20_000) ?? null;

  const values = {
    merchantId,
    refundUrl: input.refundUrl ?? null,
    termsUrl: input.termsUrl ?? null,
    fulfillmentUrl: input.fulfillmentUrl ?? null,
    refundText: textFor('refund'),
    termsText: textFor('terms'),
    fulfillmentText: textFor('fulfillment'),
    // Which way the merchant gave it, so the weekly checker knows whether there is a URL
    // worth re-fetching at all.
    source: input.refundText || input.termsText || input.fulfillmentText ? 'text' : 'url',
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
