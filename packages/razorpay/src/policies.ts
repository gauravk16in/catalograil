import Anthropic from '@anthropic-ai/sdk';
import { AppError } from '@catalograil/core';

/**
 * T1.9 — policy capture and validation.
 *
 * Three URLs are mandatory before a merchant can go active: refund, terms, fulfillment.
 * That is not bureaucracy — rule 4 snapshots these onto every order, so they are the
 * buyer's contract, and a merchant with no stated returns policy is a merchant a buyer
 * cannot safely buy from through an assistant that speaks on their behalf.
 *
 * Validation is deliberately two-stage: fetch and prove the page exists and has content,
 * then extract structure from it. A URL that 404s fails before a model is ever called.
 */

export type PolicyKind = 'refund' | 'terms' | 'fulfillment';

export type PolicyCheckStatus = 'ok' | 'unreachable' | 'empty' | 'changed';

export interface PolicyFetchResult {
  readonly kind: PolicyKind;
  readonly url: string;
  readonly status: PolicyCheckStatus;
  readonly text?: string;
  readonly httpStatus?: number;
  readonly reason?: string;
}

/** T1.9: HTTP 200 and more than 200 characters of body text. */
const MIN_POLICY_CHARACTERS = 200;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_POLICY_BYTES = 2 * 1024 * 1024;

export interface PolicyFetcher {
  fetch(kind: PolicyKind, url: string): Promise<PolicyFetchResult>;
}

export class HttpPolicyFetcher implements PolicyFetcher {
  constructor(private readonly timeoutMs = FETCH_TIMEOUT_MS) {}

  async fetch(kind: PolicyKind, url: string): Promise<PolicyFetchResult> {
    try {
      const response = await globalThis.fetch(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'follow',
        headers: { 'user-agent': 'CatalogRail-PolicyChecker/1.0' },
      });

      if (!response.ok) {
        return {
          kind,
          url,
          status: 'unreachable',
          httpStatus: response.status,
          reason: `The page returned HTTP ${response.status}.`,
        };
      }

      const body = await response.text();
      if (body.length > MAX_POLICY_BYTES) {
        return { kind, url, status: 'empty', reason: 'The page is too large to read.' };
      }

      const text = stripHtml(body);
      if (text.length < MIN_POLICY_CHARACTERS) {
        return {
          kind,
          url,
          status: 'empty',
          reason: `The page has only ${text.length} characters of text; a policy needs at least ${MIN_POLICY_CHARACTERS}.`,
        };
      }

      return { kind, url, status: 'ok', text, httpStatus: response.status };
    } catch (err) {
      const message =
        (err as Error).name === 'TimeoutError'
          ? 'The page took too long to load.'
          : 'The page could not be reached.';
      return { kind, url, status: 'unreachable', reason: message };
    }
  }
}

/**
 * Crude but sufficient: policies are prose, and what the extractor needs is the words.
 * Script and style content is removed first because otherwise a page's JavaScript counts
 * toward the character minimum and an empty policy page passes on its analytics tag alone.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ExtractedPolicies {
  readonly returnWindowDays: number | null;
  readonly returnShippingBy: 'buyer' | 'merchant' | 'conditional' | null;
  readonly dispatchSlaHours: number | null;
  readonly refundSummary: string | null;
  readonly termsSummary: string | null;
  readonly fulfillmentSummary: string | null;
}

export interface PolicyExtractor {
  extract(pages: readonly PolicyFetchResult[]): Promise<ExtractedPolicies>;
}

const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';

const EXTRACTION_PROMPT = `You read merchant policy pages and extract the facts a buyer needs before purchasing.

You will receive the text of up to three pages: a refund policy, terms of service, and a fulfillment or shipping policy.

Return ONLY a JSON object with exactly these keys:
{
  "return_window_days": integer or null,
  "return_shipping_by": "buyer" | "merchant" | "conditional" | null,
  "dispatch_sla_hours": integer or null,
  "refund_summary": string or null,
  "terms_summary": string or null,
  "fulfillment_summary": string or null
}

Rules:
- return_window_days: the number of days a buyer has to initiate a return. If the policy says returns are not accepted, use 0. If it genuinely does not say, use null.
- return_shipping_by: who pays return postage. "conditional" when it depends on the reason for return.
- dispatch_sla_hours: how long the merchant takes to dispatch, in hours. "2 business days" is 48.
- Each summary is at most two plain-English sentences, written for a buyer deciding whether to purchase. State what the policy says, not that a policy exists.

Never infer a number that is not stated. A wrong return window is worse than a missing one, because a buyer will rely on it and a snapshot of it becomes their contract.`;

export class ClaudePolicyExtractor implements PolicyExtractor {
  private readonly client: Anthropic;

  constructor(private readonly model = process.env.ANTHROPIC_POLICY_MODEL ?? EXTRACTION_MODEL) {
    this.client = new Anthropic({});
  }

  async extract(pages: readonly PolicyFetchResult[]): Promise<ExtractedPolicies> {
    const usable = pages.filter((page) => page.status === 'ok' && page.text);
    if (usable.length === 0) {
      throw new AppError('POLICY_EXTRACTION_FAILED', 'No readable policy pages to extract from.');
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: EXTRACTION_PROMPT,
      messages: [
        {
          role: 'user',
          content: usable
            // Truncated because policy pages are often a whole site's boilerplate, and the
            // relevant terms are near the top.
            .map((page) => `## ${page.kind} policy (${page.url})\n\n${page.text!.slice(0, 12_000)}`)
            .join('\n\n'),
        },
        { role: 'assistant', content: '{' },
      ],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return parseExtraction(`{${text}`);
  }
}

export function parseExtraction(raw: string): ExtractedPolicies {
  let parsed: Record<string, unknown>;
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw) as Record<
      string,
      unknown
    >;
  } catch (err) {
    throw new AppError('POLICY_EXTRACTION_FAILED', 'The extractor did not return valid JSON.', {
      cause: err,
    });
  }

  return {
    returnWindowDays: nonNegativeInt(parsed.return_window_days),
    returnShippingBy: shippingBy(parsed.return_shipping_by),
    dispatchSlaHours: nonNegativeInt(parsed.dispatch_sla_hours),
    refundSummary: summary(parsed.refund_summary),
    termsSummary: summary(parsed.terms_summary),
    fulfillmentSummary: summary(parsed.fulfillment_summary),
  };
}

/**
 * Zero is meaningful here — "returns are not accepted" — so it must survive, which a
 * truthiness check would quietly turn into null and misrepresent as "not stated".
 */
function nonNegativeInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function shippingBy(value: unknown): ExtractedPolicies['returnShippingBy'] {
  return value === 'buyer' || value === 'merchant' || value === 'conditional' ? value : null;
}

function summary(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 600) : null;
}

/** Every policy URL must pass before a merchant can reach `active` (T1.8, T1.9). */
export function policiesAreComplete(results: readonly PolicyFetchResult[]): boolean {
  const required: PolicyKind[] = ['refund', 'terms', 'fulfillment'];
  return required.every((kind) => results.some((r) => r.kind === kind && r.status === 'ok'));
}

/** The blocked-state message the onboarding wizard shows (T1.22). */
export function describePolicyFailures(results: readonly PolicyFetchResult[]): string[] {
  return results
    .filter((result) => result.status !== 'ok')
    .map((result) => `${result.kind} policy (${result.url}): ${result.reason ?? result.status}`);
}
