import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { SendMessageBatchCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  AppError,
  type EmailMessage,
  type Mailer,
  type ObjectStore,
  type PresignedUpload,
  type PresignOptions,
  type PutOptions,
  type Queue,
} from '@catalograil/core';

/**
 * The AWS implementations of the ports. Everything AWS-specific in the ingestion path
 * lives in this file, which is what lets `runIngestion` be tested without it.
 *
 * Untested against real AWS — there are no credentials in the development environment yet.
 * The logic these wrap is covered by the in-memory implementations; what is unverified here
 * is the SDK wiring itself, and it should be exercised the first time a stack is deployed.
 */

const DEFAULT_PRESIGN_SECONDS = 15 * 60;
/** SQS accepts at most 10 messages per batch. */
const SQS_BATCH_SIZE = 10;

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly bucket: string,
    private readonly client: S3Client = new S3Client({}),
  ) {}

  async readStream(key: string): Promise<AsyncIterable<Uint8Array>> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = response.Body;
    if (!body) {
      throw new AppError('NOT_FOUND', `No object at s3://${this.bucket}/${key}`, {
        details: { key },
      });
    }
    // The SDK's stream is a Node Readable in Lambda, which is already an AsyncIterable of
    // chunks — handing it straight through is what keeps backpressure intact.
    return body as unknown as AsyncIterable<Uint8Array>;
  }

  async put(key: string, body: string | Uint8Array, options: PutOptions = {}): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ...(options.contentType ? { ContentType: options.contentType } : {}),
      }),
    );
  }

  async presignPut(key: string, options: PresignOptions = {}): Promise<PresignedUpload> {
    const expiresIn = options.expiresInSeconds ?? DEFAULT_PRESIGN_SECONDS;
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options.contentType ? { ContentType: options.contentType } : {}),
        // Signed into the URL, so an oversized body is rejected by S3 rather than by us
        // after the upload has already crossed the wire.
        ...(options.maxBytes ? { ContentLength: options.maxBytes } : {}),
      }),
      { expiresIn },
    );

    return { url, key, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
}

export class SqsQueue<T> implements Queue<T> {
  constructor(
    private readonly queueUrl: string,
    private readonly client: SQSClient = new SQSClient({}),
  ) {}

  async send(message: T): Promise<void> {
    await this.client.send(
      new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(message) }),
    );
  }

  async sendBatch(messages: readonly T[]): Promise<void> {
    for (let i = 0; i < messages.length; i += SQS_BATCH_SIZE) {
      const chunk = messages.slice(i, i + SQS_BATCH_SIZE);
      await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: chunk.map((message, index) => ({
            Id: String(i + index),
            MessageBody: JSON.stringify(message),
          })),
        }),
      );
    }
  }
}

/**
 * SES, text-only.
 *
 * `SendEmail` cannot carry an attachment — that needs `SendRawEmail` and a hand-built MIME
 * document. The error report is written to S3 and linked from the dashboard instead, so
 * the attachment is dropped here rather than the email failing. Worth revisiting alongside
 * the notification worker, which will need MIME anyway.
 */
export class SesMailer implements Mailer {
  constructor(
    private readonly from: string,
    private readonly client: SESClient = new SESClient({}),
  ) {}

  async send(message: EmailMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        Source: this.from,
        Destination: { ToAddresses: [message.to] },
        Message: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: message.text, Charset: 'UTF-8' },
            ...(message.html ? { Html: { Data: message.html, Charset: 'UTF-8' } } : {}),
          },
        },
      }),
    );
  }
}
