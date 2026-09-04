import { randomUUID } from 'node:crypto';
import {
  AppError,
  CSV_TEMPLATES,
  buildTemplateCsv,
  templateFilename,
  type CsvTemplate,
  type Clock,
  type ObjectStore,
  type PresignedUpload,
} from '@catalograil/core';
import { ingestionJobs, type Database } from '@catalograil/db';
import { z } from 'zod';

/**
 * `POST /merchant/uploads` (T1.11) — hands back a presigned S3 PUT URL and creates the
 * `ingestion_jobs` row the worker will pick up.
 *
 * T1.11 lists row creation as the worker's first step. It happens here instead, for one
 * reason: the row records which template the file follows, and only this request knows
 * that. The S3 key format the task specifies — `uploads/{merchantId}/{jobId}.csv` — does
 * not carry it, and inferring a template from a file's own header would defeat the point
 * of rejecting header mismatches. So the row is created a hop earlier, in `queued`, and
 * the worker transitions it to `running`.
 */

/** A catalogue CSV above this is a mistake or an attack, not a catalogue. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const PRESIGN_TTL_SECONDS = 15 * 60;

export const createUploadRequestSchema = z.object({
  template: z.enum(CSV_TEMPLATES),
});

export type CreateUploadRequest = z.infer<typeof createUploadRequestSchema>;

export interface CreateUploadResponse {
  readonly jobId: string;
  readonly upload: PresignedUpload;
  readonly maxBytes: number;
}

export interface UploadDeps {
  readonly db: Database;
  readonly objectStore: ObjectStore;
  readonly clock: Clock;
}

export async function createUpload(
  merchantId: string,
  body: unknown,
  deps: UploadDeps,
): Promise<CreateUploadResponse> {
  const parsed = createUploadRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Choose a template: simple or variant.', {
      details: { issues: parsed.error.issues },
    });
  }

  // The id is generated here rather than by the database so the key it names can be
  // written in the same insert, instead of an insert followed by an update.
  const jobId = randomUUID();
  const key = uploadKey(merchantId, jobId);

  await deps.db.insert(ingestionJobs).values({
    id: jobId,
    merchantId,
    s3Key: key,
    template: parsed.data.template,
    status: 'queued',
  });

  /**
   * The key is derived from the merchant on the session, never from anything the caller
   * sent, so one merchant cannot obtain a URL that writes into another's prefix.
   */
  const upload = await deps.objectStore.presignPut(key, {
    expiresInSeconds: PRESIGN_TTL_SECONDS,
    contentType: 'text/csv',
    maxBytes: MAX_UPLOAD_BYTES,
  });

  return { jobId, upload, maxBytes: MAX_UPLOAD_BYTES };
}

/** `GET /merchant/uploads/templates/:template` — the downloadable template (T1.24). */
export function getTemplate(template: string): {
  filename: string;
  contentType: string;
  body: string;
} {
  if (!(CSV_TEMPLATES as readonly string[]).includes(template)) {
    throw new AppError('NOT_FOUND', `Unknown template "${template}".`, {
      details: { available: CSV_TEMPLATES },
    });
  }
  const name = template as CsvTemplate;
  return {
    filename: templateFilename(name),
    contentType: 'text/csv; charset=utf-8',
    body: buildTemplateCsv(name),
  };
}

export function uploadKey(merchantId: string, jobId: string): string {
  return `uploads/${merchantId}/${jobId}.csv`;
}
