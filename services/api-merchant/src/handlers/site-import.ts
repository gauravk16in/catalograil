import { AppError, type Clock, type Queue, type SiteImportMessage } from '@catalograil/core';
import { siteImportJobs, type Database } from '@catalograil/db';
import { originOf } from '@catalograil/site-import';
import { desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * "Import from my website" — the first thing a merchant should be offered.
 *
 * The alternative onboarding is a CSV, and a CSV is where merchants stop. Someone who has
 * already listed two hundred products on their own store is being asked to export,
 * reformat and re-upload them before this platform is worth anything to them; most never
 * finish, and the ones who do have spent an afternoon on data they already had.
 *
 * This endpoint only records the intent and queues the first slot. Everything real happens
 * in the worker: fetching a URL a merchant typed is not something an API handler behind a
 * synchronous request should be doing, and an import of four thousand products has no
 * business inside a request timeout.
 */

const requestSchema = z.object({
  websiteUrl: z
    .string()
    .trim()
    .min(4)
    .max(300)
    .describe('The merchant’s own storefront, e.g. https://example.in'),
});

export interface SiteImportDeps {
  readonly db: Database;
  readonly queue: Queue<SiteImportMessage>;
  readonly clock: Clock;
}

/** How many imports one merchant may have in flight. */
const MAX_ACTIVE = 1;

export async function startSiteImport(
  merchantId: string,
  body: unknown,
  deps: SiteImportDeps,
): Promise<{ jobId: string; siteUrl: string }> {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Enter your website address.', {
      details: { issues: parsed.error.issues },
    });
  }

  /**
   * Normalised to an origin before anything else touches it.
   *
   * This is the only value in the request that becomes a URL the platform will fetch, so it
   * is narrowed here to something that is unambiguously a website — the worker refuses
   * private addresses as well, but a `javascript:` URL should never reach a queue in the
   * first place.
   */
  const siteUrl = originOf(parsed.data.websiteUrl);
  if (!siteUrl) {
    throw new AppError('VALIDATION_FAILED', 'That does not look like a website address.');
  }

  const recent = await deps.db
    .select({ id: siteImportJobs.id, status: siteImportJobs.status })
    .from(siteImportJobs)
    .where(eq(siteImportJobs.merchantId, merchantId))
    .orderBy(desc(siteImportJobs.createdAt))
    .limit(5);

  const active = recent.filter((job) => job.status === 'queued' || job.status === 'running');
  if (active.length >= MAX_ACTIVE) {
    // Not a rate limit dressed up: two imports of the same site race each other into the
    // same `(merchant_id, external_ref)` rows, and then neither one's counts mean anything.
    throw new AppError('CONFLICT', 'An import is already running. Wait for it to finish.', {
      details: { jobId: active[0]!.id },
    });
  }

  const jobId = randomUUID();
  await deps.db.insert(siteImportJobs).values({ id: jobId, merchantId, siteUrl, status: 'queued' });

  await deps.queue.send({ jobId, merchantId, siteUrl, offset: 0 });

  return { jobId, siteUrl };
}

/** What the dashboard polls while an import runs. */
export async function listSiteImports(
  db: Database,
  merchantId: string,
): Promise<{ imports: Record<string, unknown>[] }> {
  const rows = await db
    .select()
    .from(siteImportJobs)
    .where(eq(siteImportJobs.merchantId, merchantId))
    .orderBy(desc(siteImportJobs.createdAt))
    .limit(10);

  return {
    imports: rows.map((row) => ({
      id: row.id,
      siteUrl: row.siteUrl,
      status: row.status,
      method: row.method,
      productsFound: row.productsFound,
      productsCreated: row.productsCreated,
      productsUpdated: row.productsUpdated,
      variantsUpserted: row.variantsUpserted,
      slotsDone: row.slotsDone,
      skipped: row.skipped ?? [],
      rejectionReason: row.rejectionReason,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    })),
  };
}
