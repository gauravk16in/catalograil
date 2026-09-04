import {
  AppError,
  type EmailMessage,
  type Mailer,
  type ObjectStore,
  type PresignedUpload,
  type Queue,
} from '@catalograil/core';

/**
 * In-memory implementations of the ports, for tests.
 *
 * These are real implementations, not mocks: they store what they are given and hand it
 * back, and they fail the way the real thing fails — reading a missing key throws
 * `NOT_FOUND` rather than returning empty. A test that passes against these is testing the
 * worker, not a set of expectations the test itself wrote down.
 */

export class InMemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  async readStream(key: string): Promise<AsyncIterable<Uint8Array>> {
    const body = this.objects.get(key);
    if (!body) {
      throw new AppError('NOT_FOUND', `No object at ${key}`, { details: { key } });
    }
    // Delivered in chunks so the consumer is exercised as a stream rather than handed one
    // buffer that hides a missing backpressure path.
    return chunked(body, 16 * 1024);
  }

  async put(key: string, body: string | Uint8Array): Promise<void> {
    this.objects.set(key, typeof body === 'string' ? new TextEncoder().encode(body) : body);
  }

  async presignPut(key: string): Promise<PresignedUpload> {
    return {
      url: `memory://${key}`,
      key,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    };
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  /** Test helper: read an object back as text. */
  text(key: string): string | undefined {
    const body = this.objects.get(key);
    return body ? new TextDecoder().decode(body) : undefined;
  }
}

export class InMemoryQueue<T> implements Queue<T> {
  readonly messages: T[] = [];

  async send(message: T): Promise<void> {
    this.messages.push(message);
  }

  async sendBatch(messages: readonly T[]): Promise<void> {
    this.messages.push(...messages);
  }
}

export class InMemoryMailer implements Mailer {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

async function* chunked(body: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < body.length; offset += size) {
    yield body.subarray(offset, Math.min(offset + size, body.length));
  }
}
