import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { AppError } from '@catalograil/core';
import type { BedrockInvoker } from './embedder.js';

/**
 * The one place the Bedrock SDK is touched. `BedrockEmbedder` takes this as an interface,
 * so every test of the embedding logic runs without AWS.
 */
export class BedrockRuntimeInvoker implements BedrockInvoker {
  constructor(private readonly client: BedrockRuntimeClient = new BedrockRuntimeClient({})) {}

  async invoke(modelId: string, body: unknown): Promise<unknown> {
    try {
      const response = await this.client.send(
        new InvokeModelCommand({
          modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(body),
        }),
      );
      return JSON.parse(new TextDecoder().decode(response.body));
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      // Throttling is worth retrying; a bad model id or a denied model is not, and
      // retrying it only delays the message reaching the DLQ where someone will see it.
      const retryable = /throttl|timeout|ServiceUnavailable|InternalServer/i.test(message);
      throw new AppError('EMBEDDING_FAILED', `Bedrock ${modelId}: ${message}`, {
        retryable,
        cause: err,
        details: { modelId },
      });
    }
  }
}

export function createBedrockInvoker(region?: string): BedrockInvoker {
  return new BedrockRuntimeInvoker(new BedrockRuntimeClient(region ? { region } : {}));
}
