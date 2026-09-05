import { randomUUID } from 'node:crypto';
import { fixedClock, type EnrichmentMessage, type SiteImportMessage } from '@catalograil/core';
import { merchants, products, siteImportJobs } from '@catalograil/db';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryQueue } from '@catalograil/aws';
import type { Fetcher } from '@catalograil/site-import';
import { runSlot, type SiteImportDeps } from './import.js';

/**
 * Against a real Postgres, because the properties worth testing are the ones a fake would
 * paper over: that a slot writes exactly fifty products, that the next slot is enqueued
 * only after this one has landed, and that a redelivered message does not import anything
 * twice.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-05T12:00:00Z');

function shopifyStore(count: number): Fetcher {
  return async (url) => {
    const page = Number(new URL(url).searchParams.get('page') ?? '1');
    if (!url.includes('/products.json')) {
      return { url, status: 404, contentType: 'text/html', body: '' };
    }

    const start = (page - 1) * 50;
    const items = Array.from({ length: Math.max(0, Math.min(50, count - start)) }, (_, i) => ({
      id: start + i,
      title: `Item ${start + i}`,
      handle: `item-${start + i}`,
      variants: [{ id: start + i, sku: `SKU-${start + i}`, price: '499.00', available: true }],
    }));

    return {
      url,
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ products: items }),
    };
  };
}

describe.skipIf(!DATABASE_URL)('a slot of a website import', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  let merchantId: string;
  const created: string[] = [];

  beforeAll(async () => {
    client = postgres(DATABASE_URL!, { max: 2, onnotice: () => {} });
    db = drizzle(client);
  });

  /**
   * A merchant per test, because products match on `(merchant_id, external_ref)`.
   *
   * Sharing one would make every test after the first see updates where it expected
   * creations — which is the upsert working correctly and the test lying about it.
   */
  beforeEach(async () => {
    merchantId = randomUUID();
    created.push(merchantId);
    await db.insert(merchants).values({
      id: merchantId,
      businessName: 'Site Import Test Merchant',
      contactEmail: `site-import-${merchantId}@example.com`,
      status: 'active',
    });
  });

  afterAll(async () => {
    for (const id of created) await db.delete(merchants).where(eq(merchants.id, id));
    await client?.end();
  });

  function deps(fetch: Fetcher): SiteImportDeps & {
    enrichmentQueue: InMemoryQueue<EnrichmentMessage>;
    siteImportQueue: InMemoryQueue<SiteImportMessage>;
  } {
    return {
      db: db as unknown as SiteImportDeps['db'],
      fetch,
      enrichmentQueue: new InMemoryQueue<EnrichmentMessage>(),
      siteImportQueue: new InMemoryQueue<SiteImportMessage>(),
      clock: fixedClock(NOW),
    };
  }

  async function newJob(): Promise<string> {
    const jobId = randomUUID();
    await db.insert(siteImportJobs).values({
      id: jobId,
      merchantId,
      siteUrl: 'https://store.test',
      status: 'queued',
    });
    return jobId;
  }

  const message = (jobId: string, offset = 0): SiteImportMessage => ({
    jobId,
    merchantId,
    siteUrl: 'https://store.test',
    offset,
  });

  it('imports at most fifty products and queues the next slot', async () => {
    const jobId = await newJob();
    const d = deps(shopifyStore(120));

    const outcome = await runSlot(message(jobId), d);

    expect(outcome.found).toBe(50);
    expect(outcome.done).toBe(false);
    // The next slot exists and starts where this one stopped — not at zero, not at 100.
    expect(d.siteImportQueue.messages).toEqual([
      { jobId, merchantId, siteUrl: 'https://store.test', offset: 50 },
    ]);
    // Every imported product is queued for enrichment, as a CSV import would be.
    expect(d.enrichmentQueue.messages).toHaveLength(50);
  });

  it('finishes when the catalogue runs out, without queueing another slot', async () => {
    const jobId = await newJob();
    const d = deps(shopifyStore(12));

    const outcome = await runSlot(message(jobId), d);

    expect(outcome.found).toBe(12);
    expect(outcome.done).toBe(true);
    expect(d.siteImportQueue.messages).toHaveLength(0);

    const [job] = await db.select().from(siteImportJobs).where(eq(siteImportJobs.id, jobId));
    expect(job!.status).toBe('completed');
    expect(job!.productsCreated).toBe(12);
    expect(job!.method).toBe('shopify');
  });

  it('lands products as drafts, never straight into the catalogue', async () => {
    const jobId = await newJob();
    await runSlot(message(jobId), deps(shopifyStore(3)));

    const rows = await db.select().from(products).where(eq(products.merchantId, merchantId));
    // A machine's reading of pages written for people is a draft until the merchant says so.
    expect(rows.every((row) => row.status === 'draft')).toBe(true);
  });

  it('does not re-import a slot that has already been applied', async () => {
    const jobId = await newJob();
    const first = deps(shopifyStore(120));
    await runSlot(message(jobId), first);

    // SQS is at-least-once: the same message arrives again.
    const again = deps(shopifyStore(120));
    const outcome = await runSlot(message(jobId, 0), again);

    expect(outcome.skipped).toBe(true);
    expect(again.enrichmentQueue.messages).toHaveLength(0);
    expect(again.siteImportQueue.messages).toHaveLength(0);
  });

  it('re-running the whole import updates rather than duplicating', async () => {
    const jobId = await newJob();
    const first = await runSlot(message(jobId), deps(shopifyStore(5)));
    const before = await db.select().from(products).where(eq(products.merchantId, merchantId));
    expect(first.created).toBe(5);

    const second = await newJob();
    const outcome = await runSlot(message(second), deps(shopifyStore(5)));
    const after = await db.select().from(products).where(eq(products.merchantId, merchantId));

    // Matched on (merchant_id, external_ref), so the merchant's catalogue does not double.
    expect(after.length).toBe(before.length);
    expect(outcome.updated).toBe(5);
    expect(outcome.created).toBe(0);
  });

  it('says why rather than finishing silently when a site cannot be read', async () => {
    const jobId = await newJob();
    const blank: Fetcher = async (url) => ({ url, status: 404, contentType: 'text/html', body: '' });

    const outcome = await runSlot(message(jobId), deps(blank));

    expect(outcome.done).toBe(true);
    const [job] = await db.select().from(siteImportJobs).where(eq(siteImportJobs.id, jobId));
    expect(job!.status).toBe('failed');
    expect(job!.rejectionReason).toContain('schema.org');
  });
});
