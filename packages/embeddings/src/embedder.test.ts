import { describe, expect, it } from 'vitest';
import { BedrockEmbedder, type BedrockInvoker } from './embedder.js';

/**
 * Records what was actually sent to Bedrock and returns vectors of a chosen width, so the
 * request body and the width check can both be tested without an AWS call.
 */
class FakeInvoker implements BedrockInvoker {
  readonly bodies: Record<string, unknown>[] = [];
  constructor(private readonly width: number) {}

  async invoke(_modelId: string, body: unknown): Promise<unknown> {
    this.bodies.push(body as Record<string, unknown>);
    const count = (body as { texts?: string[] }).texts?.length ?? 1;
    const vector = Array.from({ length: this.width }, () => 0.1);
    return { embeddings: { int8: Array.from({ length: count }, () => vector) } };
  }
}

describe('BedrockEmbedder text requests', () => {
  /**
   * Regression. Embed v4 defaults to 1536 while `searchable_units` declares `vector(1024)`,
   * and the text path was not sending `output_dimension` — only the image path was. Every
   * message in a deployed backfill failed on a Postgres insert reading "expected 1024
   * dimensions, not 1536", several systems away from the model id that caused it.
   */
  it('asks Embed v4 for the configured width', async () => {
    const invoker = new FakeInvoker(1024);
    const embedder = new BedrockEmbedder(invoker, {
      textModelId: 'global.cohere.embed-v4:0',
      dimensions: 1024,
    });

    await embedder.embedTexts(['a cotton shirt'], 'search_document');

    expect(invoker.bodies[0]).toMatchObject({ output_dimension: 1024 });
  });

  it('does not send output_dimension to Embed v3, which rejects it', async () => {
    const invoker = new FakeInvoker(1024);
    const embedder = new BedrockEmbedder(invoker, { textModelId: 'cohere.embed-english-v3' });

    await embedder.embedTexts(['a cotton shirt'], 'search_document');

    expect(invoker.bodies[0]).not.toHaveProperty('output_dimension');
  });

  it('fails at the model boundary when the width is wrong, not at the database', async () => {
    // The cheapest place to name a configuration error is the call that made it.
    const embedder = new BedrockEmbedder(new FakeInvoker(1536), {
      textModelId: 'global.cohere.embed-v4:0',
      dimensions: 1024,
    });

    await expect(embedder.embedTexts(['a cotton shirt'], 'search_document')).rejects.toThrow(
      /returned 1536-dimension vectors, but 1024 was configured/,
    );
  });
});
