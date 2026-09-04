/**
 * T1.2 — Verify Bedrock embedding model access. Run this before anything else.
 *
 *   AWS_PROFILE=... pnpm verify:bedrock
 *
 * D5 wants `cohere.embed-v4` at 1024 dims, int8, in ap-south-1, with
 * `amazon.titan-embed-text-v2:0` + `amazon.titan-embed-image-v1` as the fallback.
 * Nobody knows which of those is actually enabled on this account until it is
 * called, so this probes each candidate for real and reports what works.
 *
 * Deliberately a throwaway: it lives at the repo root, not in a package, and its
 * only output is `packages/embeddings/MODELS.md`.
 */
import { writeFileSync } from 'node:fs';
import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandInput,
} from '@aws-sdk/client-bedrock-runtime';

const REGION = process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? 'ap-south-1';
const LATENCY_SAMPLES = 3;

/** A 1x1 PNG. Enough to prove the image path accepts input; not a real product photo. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PROBE_TEXT =
  'Lilac cotton oxford shirt, size 42, regular fit, machine washable, ships in 3 days from Bengaluru.';

type Modality = 'text' | 'image';

interface Candidate {
  /** What we pass as `modelId`. For cross-region this is an inference profile ID. */
  readonly modelId: string;
  readonly label: string;
  readonly family: 'cohere-v4' | 'cohere-v3' | 'titan-text' | 'titan-image';
  readonly modalities: readonly Modality[];
  readonly crossRegion: boolean;
}

/**
 * Probed in order. First working candidate per modality wins.
 * Cross-region inference profiles are prefixed by geo — `apac.` covers ap-south-1.
 */
const CANDIDATES: readonly Candidate[] = [
  {
    modelId: 'cohere.embed-v4:0',
    label: 'Cohere Embed v4 (in-region)',
    family: 'cohere-v4',
    modalities: ['text', 'image'],
    crossRegion: false,
  },
  {
    modelId: 'cohere.embed-v4',
    label: 'Cohere Embed v4, unversioned id (in-region)',
    family: 'cohere-v4',
    modalities: ['text', 'image'],
    crossRegion: false,
  },
  {
    modelId: 'apac.cohere.embed-v4:0',
    label: 'Cohere Embed v4 (APAC cross-region inference profile)',
    family: 'cohere-v4',
    modalities: ['text', 'image'],
    crossRegion: true,
  },
  {
    modelId: 'cohere.embed-english-v3',
    label: 'Cohere Embed English v3',
    family: 'cohere-v3',
    modalities: ['text'],
    crossRegion: false,
  },
  {
    modelId: 'cohere.embed-multilingual-v3',
    label: 'Cohere Embed Multilingual v3',
    family: 'cohere-v3',
    modalities: ['text'],
    crossRegion: false,
  },
  {
    modelId: 'amazon.titan-embed-text-v2:0',
    label: 'Titan Text Embeddings v2 (D5 fallback)',
    family: 'titan-text',
    modalities: ['text'],
    crossRegion: false,
  },
  {
    modelId: 'amazon.titan-embed-image-v1',
    label: 'Titan Multimodal Embeddings v1 (D5 fallback)',
    family: 'titan-image',
    modalities: ['image', 'text'],
    crossRegion: false,
  },
];

interface ProbeResult {
  readonly candidate: Candidate;
  readonly modality: Modality;
  readonly ok: boolean;
  readonly dimensions?: number;
  readonly embeddingTypes?: string[];
  readonly latencyMs?: number[];
  readonly requestShape?: string;
  readonly error?: string;
}

/**
 * Request bodies differ per family, and Embed v4 accepts more than one shape on
 * Bedrock. Each entry is tried until one returns 200 — the winning shape is
 * recorded so `/packages/embeddings` can hard-code it rather than guess.
 */
function buildBodies(candidate: Candidate, modality: Modality): { shape: string; body: unknown }[] {
  switch (candidate.family) {
    case 'cohere-v4':
      return modality === 'text'
        ? [
            {
              shape: 'v4.inputs[].content[]',
              body: {
                inputs: [{ content: [{ type: 'text', text: PROBE_TEXT }] }],
                input_type: 'search_document',
                embedding_types: ['int8'],
                output_dimension: 1024,
              },
            },
            {
              shape: 'v3-style.texts[]',
              body: {
                texts: [PROBE_TEXT],
                input_type: 'search_document',
                embedding_types: ['int8'],
                output_dimension: 1024,
              },
            },
          ]
        : [
            {
              shape: 'v4.inputs[].content[]',
              body: {
                inputs: [
                  {
                    content: [{ type: 'image', image: `data:image/png;base64,${TINY_PNG_BASE64}` }],
                  },
                ],
                input_type: 'image',
                embedding_types: ['int8'],
                output_dimension: 1024,
              },
            },
            {
              shape: 'v3-style.images[]',
              body: {
                images: [`data:image/png;base64,${TINY_PNG_BASE64}`],
                input_type: 'image',
                embedding_types: ['int8'],
              },
            },
          ];

    case 'cohere-v3':
      return [
        {
          shape: 'v3.texts[]',
          body: { texts: [PROBE_TEXT], input_type: 'search_document', embedding_types: ['int8'] },
        },
      ];

    case 'titan-text':
      return [
        {
          shape: 'titan.inputText',
          body: { inputText: PROBE_TEXT, dimensions: 1024, normalize: true },
        },
      ];

    case 'titan-image':
      return modality === 'text'
        ? [
            {
              shape: 'titan-mm.inputText',
              body: { inputText: PROBE_TEXT, embeddingConfig: { outputEmbeddingLength: 1024 } },
            },
          ]
        : [
            {
              shape: 'titan-mm.inputImage',
              body: {
                inputImage: TINY_PNG_BASE64,
                embeddingConfig: { outputEmbeddingLength: 1024 },
              },
            },
          ];
  }
}

/** Pull a vector out of whichever response shape came back. */
function extractEmbedding(payload: unknown): { vector: number[]; types: string[] } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;

  // Titan: { embedding: number[] }
  if (Array.isArray(p.embedding) && typeof p.embedding[0] === 'number') {
    return { vector: p.embedding as number[], types: ['float'] };
  }

  // Cohere: { embeddings: { int8: number[][], float: number[][] } } or { embeddings: number[][] }
  const embeddings = p.embeddings;
  if (Array.isArray(embeddings)) {
    const first = embeddings[0];
    if (Array.isArray(first)) return { vector: first as number[], types: ['float'] };
  }
  if (typeof embeddings === 'object' && embeddings !== null) {
    const byType = embeddings as Record<string, unknown>;
    const types = Object.keys(byType).filter((k) => Array.isArray(byType[k]));
    for (const preferred of ['int8', 'ubinary', 'float', ...types]) {
      const rows = byType[preferred];
      if (Array.isArray(rows) && Array.isArray(rows[0])) {
        return { vector: rows[0] as number[], types };
      }
    }
  }
  return undefined;
}

async function probe(
  runtime: BedrockRuntimeClient,
  candidate: Candidate,
  modality: Modality,
): Promise<ProbeResult> {
  const attempts = buildBodies(candidate, modality);
  let lastError = 'no attempt made';

  for (const { shape, body } of attempts) {
    const input: InvokeModelCommandInput = {
      modelId: candidate.modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    };

    try {
      const latencies: number[] = [];
      let parsed: unknown;

      for (let i = 0; i < LATENCY_SAMPLES; i++) {
        const started = performance.now();
        const response = await runtime.send(new InvokeModelCommand(input));
        latencies.push(Math.round(performance.now() - started));
        if (i === 0) parsed = JSON.parse(new TextDecoder().decode(response.body));
      }

      const extracted = extractEmbedding(parsed);
      if (!extracted) {
        lastError = `200 OK but no embedding found in response (shape ${shape})`;
        continue;
      }

      return {
        candidate,
        modality,
        ok: true,
        dimensions: extracted.vector.length,
        embeddingTypes: extracted.types,
        latencyMs: latencies,
        requestShape: shape,
      };
    } catch (err) {
      lastError = `${(err as Error).name}: ${(err as Error).message} (shape ${shape})`;
      // AccessDenied / ValidationException are expected for models not enabled here.
    }
  }

  return { candidate, modality, ok: false, error: lastError };
}

async function listAvailableEmbeddingModels(): Promise<string[]> {
  const client = new BedrockClient({ region: REGION });
  try {
    const res = await client.send(
      new ListFoundationModelsCommand({ byOutputModality: 'EMBEDDING' }),
    );
    return (res.modelSummaries ?? [])
      .map((m) => m.modelId)
      .filter((id): id is string => typeof id === 'string')
      .sort();
  } catch (err) {
    console.warn(`  ! ListFoundationModels failed: ${(err as Error).message}`);
    return [];
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
    : (sorted[mid] ?? 0);
}

function renderModelsDoc(results: ProbeResult[], listed: string[]): string {
  const pick = (m: Modality) => results.find((r) => r.ok && r.modality === m);
  const text = pick('text');
  const image = pick('image');

  const row = (r: ProbeResult) =>
    `| \`${r.candidate.modelId}\` | ${r.modality} | ${r.ok ? '✅' : '❌'} | ${r.dimensions ?? '—'} | ${
      r.embeddingTypes?.join(', ') ?? '—'
    } | ${r.latencyMs ? `${median(r.latencyMs)} ms` : '—'} | ${r.requestShape ?? r.error ?? ''} |`;

  return `# Embedding models — verified access

Generated by \`pnpm verify:bedrock\` (T1.2) on ${new Date().toISOString()}.
Region probed: \`${REGION}\`. Re-run this whenever the account's Bedrock model access changes.

## Chosen models

| Modality | Model ID | Dimensions | Request shape | Median latency |
|---|---|---|---|---|
| Text (\`v_semantic\`, \`v_intent\`) | ${text ? `\`${text.candidate.modelId}\`` : '**none — resolve before building /packages/embeddings**'} | ${text?.dimensions ?? '—'} | ${text?.requestShape ?? '—'} | ${text?.latencyMs ? `${median(text.latencyMs)} ms` : '—'} |
| Image (\`v_visual\`) | ${image ? `\`${image.candidate.modelId}\`` : '**none — v_visual stays null until resolved**'} | ${image?.dimensions ?? '—'} | ${image?.requestShape ?? '—'} | ${image?.latencyMs ? `${median(image.latencyMs)} ms` : '—'} |

${
  text && text.dimensions !== 1024
    ? `> ⚠️ Text embeddings came back at ${text.dimensions} dims, not the 1024 assumed by D5.\n> The \`vector(1024)\` columns in \`searchable_units\` must change to match **before** the first migration.\n`
    : ''
}${
    text && image && text.dimensions !== image.dimensions
      ? `> ⚠️ Text and image dimensions differ (${text.dimensions} vs ${image.dimensions}). \`v_semantic\`/\`v_intent\` and \`v_visual\` cannot share one width.\n`
      : ''
  }
## Full probe results

| Model ID | Modality | Works | Dims | Embedding types | Median latency | Detail |
|---|---|---|---|---|---|---|
${results.map(row).join('\n')}

## Embedding models listed in \`${REGION}\`

${listed.length > 0 ? listed.map((id) => `- \`${id}\``).join('\n') : '_ListFoundationModels returned nothing — check IAM permissions._'}

_Listed does not mean enabled. A model appears here even when access has not been requested in the Bedrock console._
`;
}

async function main(): Promise<void> {
  console.log(`\nProbing Bedrock embedding models in ${REGION}\n`);

  const listed = await listAvailableEmbeddingModels();
  console.log(`  ListFoundationModels: ${listed.length} embedding model(s) visible\n`);

  const runtime = new BedrockRuntimeClient({ region: REGION });
  const results: ProbeResult[] = [];

  for (const candidate of CANDIDATES) {
    for (const modality of candidate.modalities) {
      process.stdout.write(`  ${candidate.label} [${modality}] ... `);
      const result = await probe(runtime, candidate, modality);
      results.push(result);
      console.log(
        result.ok
          ? `✅ ${result.dimensions} dims, ${median(result.latencyMs ?? [])} ms, shape ${result.requestShape}`
          : `❌ ${result.error}`,
      );
    }
  }

  const textWinner = results.find((r) => r.ok && r.modality === 'text');
  const imageWinner = results.find((r) => r.ok && r.modality === 'image');

  console.log('\n─────────────────────────────────────────────');
  console.log(`  text  → ${textWinner ? textWinner.candidate.modelId : 'NONE'}`);
  console.log(`  image → ${imageWinner ? imageWinner.candidate.modelId : 'NONE'}`);
  console.log('─────────────────────────────────────────────\n');

  const docPath = 'packages/embeddings/MODELS.md';
  writeFileSync(docPath, renderModelsDoc(results, listed));
  console.log(`Wrote ${docPath}\n`);

  if (!textWinner || !imageWinner) {
    console.error(
      'A modality has no working model. Request access in the Bedrock console, or accept the\n' +
        'fallback, before building /packages/embeddings — T1.14 and T1.15 depend on this answer.\n',
    );
    process.exitCode = 1;
  }
}

void main();
