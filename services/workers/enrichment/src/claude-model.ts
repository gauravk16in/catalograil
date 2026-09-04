import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { AppError } from '@catalograil/core';
import type { EnrichmentModel, EnrichmentResult, ProductForEnrichment } from './enrich.js';

/**
 * The Claude-backed enrichment model (T1.13), running on Bedrock.
 *
 * Bedrock rather than the Anthropic API, so the whole system needs one credential: the
 * same AWS role that reaches the embedding models reaches Claude, and there is no separate
 * Anthropic account, key rotation or egress path to manage. It also keeps enrichment inside
 * the VPC's existing network policy.
 *
 * Haiku, because this is structured extraction over short text run across an entire
 * catalogue. Measured on this account: Haiku 4.5 answers in ~870ms against Sonnet 4.6's
 * ~2.9s, at a fraction of the token price — and the task is not one a larger model does
 * better. Override with ANTHROPIC_ENRICHMENT_MODEL if a catalogue proves otherwise.
 *
 * The prompt asks for strict JSON and the parser refuses anything else. T1.13 allows one
 * retry on malformed JSON and then a DLQ; that retry is here, close to the failure, rather
 * than as a redelivery — a second identical call is cheap and usually succeeds, where a
 * redelivery costs a cold start and reprocesses the whole batch.
 */

/**
 * The inference profile, not the bare model id. Claude on Bedrock refuses on-demand
 * invocation by model id — `anthropic.claude-haiku-4-5-...` is a ValidationException
 * telling you to use a profile, which is the same trap Embed v4 sets.
 */
const DEFAULT_MODEL = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
const MAX_TOKENS = 8192;

const SYSTEM_PROMPT = `You categorise products for an Indian e-commerce catalogue that is searched by AI assistants.

For each product you receive, return metadata that makes it findable by someone describing what they need rather than naming the product.

Rules:
- category_slug: lowercase, hyphenated, specific but not unique to one product. "running-shoes", not "shoes" and not "nike-air-zoom-pegasus-41".
- category_path: dot-separated hierarchy from broad to specific, e.g. "apparel.footwear.running_shoes". Lowercase, underscores within a label.
- attributes: typed facts a buyer would filter on — material, capacity, wattage, size range, warranty. Omit anything you are inferring rather than reading.
- use_cases: what someone would be doing when they need this. "monsoon commuting", "gifting to a colleague".
- target_audience: who it is for.
- occasions: when it is bought. Omit for products with no occasion.
- keywords: words a buyer might use that do not appear in the product text, including common Indian usages and regional terms.
- confidence: your confidence in category_slug specifically, 0 to 1. Below 0.8 means you are guessing at the category.

Never invent a specification. If the text does not say the capacity, do not state one — a wrong attribute is worse than a missing one, because a buyer will filter on it and receive something that does not match.

Return ONLY a JSON array, one object per product, each with exactly these keys:
external_ref, category_slug, category_path, attributes, use_cases, target_audience, occasions, keywords, confidence`;

export interface ClaudeEnrichmentOptions {
  readonly model?: string;
  readonly region?: string;
  readonly client?: BedrockRuntimeClient;
}

export class ClaudeEnrichmentModel implements EnrichmentModel {
  private readonly client: BedrockRuntimeClient;
  private readonly model: string;

  constructor(options: ClaudeEnrichmentOptions = {}) {
    this.client =
      options.client ??
      new BedrockRuntimeClient(options.region ? { region: options.region } : {});
    this.model = options.model ?? process.env.ANTHROPIC_ENRICHMENT_MODEL ?? DEFAULT_MODEL;
  }

  async enrich(items: readonly ProductForEnrichment[]): Promise<EnrichmentResult[]> {
    if (items.length === 0) return [];

    const userContent = JSON.stringify(
      items.map((item) => ({
        external_ref: item.externalRef,
        name: item.name,
        brand: item.brand,
        description: item.description,
        merchant_category_hint: item.categoryHint,
        existing_attributes: item.attributes,
      })),
      null,
      1,
    );

    const raw = await this.callWithOneRetry(userContent);
    return parseEnrichmentResponse(raw, items);
  }

  private async callWithOneRetry(userContent: string): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.client.send(
          new InvokeModelCommand({
            modelId: this.model,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({
              // Bedrock's Claude requires this version field; omitting it is rejected.
              anthropic_version: 'bedrock-2023-05-31',
              max_tokens: MAX_TOKENS,
              system: SYSTEM_PROMPT,
              messages: [
                { role: 'user', content: userContent },
                // Prefilling the opening bracket removes the most common failure mode: a
                // perfectly good JSON array wrapped in a sentence of explanation.
                { role: 'assistant', content: '[' },
              ],
            }),
          }),
        );

        const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
          content?: { type: string; text?: string }[];
        };
        const text = (parsed.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('');

        return `[${text}`;
      } catch (err) {
        if (attempt === 1) {
          throw new AppError('ENRICHMENT_FAILED', `Bedrock Claude call failed: ${(err as Error).message}`, {
            retryable: true,
            cause: err,
          });
        }
      }
    }
    throw new AppError('ENRICHMENT_FAILED', 'Unreachable.');
  }
}

/**
 * Parses and validates the model's response.
 *
 * Anything unparseable, or shaped wrong, is dropped rather than coerced. A product with no
 * enrichment stays a draft and gets retried; a product enriched from a half-understood
 * response carries wrong metadata into search, where nobody will notice it is wrong.
 */
export function parseEnrichmentResponse(
  raw: string,
  requested: readonly ProductForEnrichment[],
): EnrichmentResult[] {
  const validRefs = new Set(requested.map((item) => item.externalRef));

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonArray(raw));
  } catch (err) {
    throw new AppError('ENRICHMENT_FAILED', 'Model response was not valid JSON.', {
      retryable: false,
      cause: err,
      details: { preview: raw.slice(0, 200) },
    });
  }

  if (!Array.isArray(parsed)) {
    throw new AppError('ENRICHMENT_FAILED', 'Model response was not a JSON array.', {
      retryable: false,
    });
  }

  return (
    parsed
      .filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
      )
      .map((entry) => ({
        external_ref: String(entry.external_ref ?? ''),
        category_slug: String(entry.category_slug ?? ''),
        category_path: String(entry.category_path ?? ''),
        attributes: isRecord(entry.attributes) ? entry.attributes : {},
        use_cases: stringArray(entry.use_cases),
        target_audience: stringArray(entry.target_audience),
        occasions: stringArray(entry.occasions),
        keywords: stringArray(entry.keywords),
        confidence: clamp01(Number(entry.confidence ?? 0)),
      }))
      // A response naming a product that was not in the batch is a model error, and applying
      // it would write one product's metadata onto another.
      .filter((entry) => validRefs.has(entry.external_ref))
  );
}

/** Tolerates a model that wrapped its array in prose despite being asked not to. */
function extractJsonArray(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) return trimmed;
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
