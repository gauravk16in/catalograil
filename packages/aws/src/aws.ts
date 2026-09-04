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
 * Exercised against a real deployed account: `S3ObjectStore.presignPut` through a real
 * merchant API request, a real browser-style PUT of a CSV to the returned URL, and the
 * checksum fix below is a real bug that surfaced doing exactly that.
 */

const DEFAULT_PRESIGN_SECONDS = 15 * 60;
/** SQS accepts at most 10 messages per batch. */
const SQS_BATCH_SIZE = 10;

/**
 * `requestChecksumCalculation: 'WHEN_REQUIRED'` disables the SDK's newer default of always
 * attaching a CRC32 checksum. That default computes the checksum over the request body at
 * signing time — empty, for a presigned URL, since there is no body yet — and bakes
 * `x-amz-checksum-crc32=<checksum of nothing>` into the signed query string. Any client
 * that then PUTs a real file gets a checksum mismatch the moment the body is non-empty,
 * which S3 reports back as SignatureDoesNotMatch rather than a checksum error, making it
 * look like a broken signature instead of what it is. Every presigned upload T1.11 issues
 * has a real body, so this default is never correct here — found by testing exactly that
 * against a deployed bucket, where a curl PUT of a real CSV failed with this signature
 * error until the client was built with this option.
 */
function defaultS3Client(): S3Client {
  return new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' });
}

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly bucket: string,
    private readonly client: S3Client = defaultS3Client(),
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

  /**
   * `options.maxBytes` is accepted but not enforced here — see below for why, and for what
   * would actually enforce it.
   */
  async presignPut(key: string, options: PresignOptions = {}): Promise<PresignedUpload> {
    const expiresIn = options.expiresInSeconds ?? DEFAULT_PRESIGN_SECONDS;
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options.contentType ? { ContentType: options.contentType } : {}),
        /**
         * `ContentLength` on a presigned PUT is NOT a maximum — it pins the request to
         * that exact byte count, since it becomes a signed header the client must match
         * precisely. Setting it to `maxBytes` therefore rejected every real upload whose
         * size differed from the cap, which is every upload that was not already exactly
         * at the limit. Found by PUTing a real 321-byte CSV against a URL presigned with
         * ContentLength 33554432, and getting SignatureDoesNotMatch — a bug present since
         * T1.11 and never exercised until an upload actually ran against real S3.
         *
         * Real enforcement of a size cap on a presigned upload needs a presigned POST with
         * a `content-length-range` policy condition, not a presigned PUT — a different
         * request shape (multipart form fields) that createUpload's response would also
         * need to change to carry. Left as a follow-up; unenforced today means the size
         * limit exists as a comment and in T1.11's row-count guard, not at the S3 layer.
         */
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
