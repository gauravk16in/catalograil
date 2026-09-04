import { randomUUID } from 'node:crypto';
import { VARIANT_HEADERS, fixedClock, type EnrichmentMessage } from '@catalograil/core';
import { ingestionJobs, merchants, productVariants, products } from '@catalograil/db';
import { and, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryMailer, InMemoryObjectStore, InMemoryQueue } from '@catalograil/aws';
import { runIngestion, type IngestionDeps } from './ingest.js';

/**
 * Runs against a real Postgres, because the parts most worth testing here are the ones a
 * fake database would paper over: the transaction per product, the upsert that makes a
 * re-upload an update, and the constraints that catch a bad row.
 *
 * Skipped when DATABASE_URL is unset, so a checkout without a database still passes.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-04T12:00:00Z');

describe.skipIf(!DATABASE_URL)('ingestion worker', () => {
  let client: postgres.Sql;
  let db: PostgresJsDatabase;
  let merchantId: string;

  beforeAll(async () => {
    client = postgres(DATABASE_URL!, { max: 2, onnotice: () => {} });
    db = drizzle(client);

    merchantId = randomUUID();
    await db.insert(merchants).values({
      id: merchantId,
      businessName: 'Ingestion Test Merchant',
      contactEmail: 'ingest-test@example.com',
      status: 'active',
    });
  });

  afterAll(async () => {
    if (merchantId) await db.delete(merchants).where(eq(merchants.id, merchantId));
    await client?.end();
  });

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function deps(): IngestionDeps & {
    objectStore: InMemoryObjectStore;
    enrichmentQueue: InMemoryQueue<EnrichmentMessage>;
    mailer: InMemoryMailer;
  } {
    return {
      db: db as unknown as IngestionDeps['db'],
      objectStore: new InMemoryObjectStore(),
      enrichmentQueue: new InMemoryQueue<EnrichmentMessage>(),
      mailer: new InMemoryMailer(),
      clock: fixedClock(NOW),
    };
  }

  async function createJob(s3Key: string): Promise<string> {
    const [job] = await db
      .insert(ingestionJobs)
      .values({ merchantId, s3Key, template: 'variant', status: 'queued' })
      .returning({ id: ingestionJobs.id });
    return job!.id;
  }

  function variantCsv(rows: readonly Record<string, string>[]): string {
    const line = (over: Record<string, string>) => {
      const base: Record<string, string> = {
        external_ref: 'SHIRT-001',
        name: 'Oxford Cotton Shirt',
        brand: 'Meridian',
        description: 'Long sleeve oxford shirt.',
        category_hint: 'shirts',
        option_axis_1_name: 'size',
        option_axis_1_value: '40',
        option_axis_2_name: 'colour',
        option_axis_2_value: 'white',
        option_axis_3_name: '',
        option_axis_3_value: '',
        sku: 'SHIRT-001-40-WHITE',
        price: '1899',
        mrp: '2799',
        stock: '12',
        delivery_days: '3',
        image_url_1: 'https://example.com/shirt.jpg',
        image_url_2: '',
        image_url_3: '',
      };
      return VARIANT_HEADERS.map((h) => over[h] ?? base[h] ?? '').join(',');
    };
    return [VARIANT_HEADERS.join(','), ...rows.map(line)].join('\n') + '\n';
  }

  /** 10 products × 5 sizes × 10 colours = 500 rows. */
  function fiveHundredRows(prefix: string, badRowIndices: readonly number[] = []): string {
    const sizes = ['38', '40', '42', '44', '46'];
    const colours = [
      'white',
      'sky',
      'lilac',
      'black',
      'sand',
      'olive',
      'rust',
      'navy',
      'grey',
      'cream',
    ];
    const rows: Record<string, string>[] = [];

    for (let p = 1; p <= 10; p++) {
      const ref = `${prefix}-${String(p).padStart(3, '0')}`;
      for (const size of sizes) {
        for (const colour of colours) {
          const index = rows.length;
          rows.push({
            external_ref: ref,
            name: `Oxford Shirt ${p}`,
            description: `Shirt number ${p}.`,
            option_axis_1_value: size,
            option_axis_2_value: colour,
            sku: `${ref}-${size}-${colour.toUpperCase()}`,
            // A bad row gets a price of 0, which the row schema rejects.
            ...(badRowIndices.includes(index) ? { price: '0' } : {}),
          });
        }
      }
    }
    return variantCsv(rows);
  }

  // ── Acceptance: a 500-row file in under 60 seconds ───────────────────────────

  it('imports a 500-row file well inside the 60 second budget', async () => {
    const d = deps();
    const key = `uploads/${merchantId}/perf.csv`;
    await d.objectStore.put(key, fiveHundredRows('PERF'));
    const jobId = await createJob(key);

    const started = performance.now();
    const outcome = await runIngestion({ jobId, merchantId, s3Key: key }, d);
    const elapsedMs = performance.now() - started;

    expect(outcome.status).toBe('completed');
    expect(outcome.rowsTotal).toBe(500);
    expect(outcome.rowsImported).toBe(500);
    expect(outcome.productsCreated).toBe(10);
    expect(outcome.variantsUpserted).toBe(500);
    expect(elapsedMs).toBeLessThan(60_000);

    console.log(`    500 rows imported in ${(elapsedMs / 1000).toFixed(2)}s`);
  }, 120_000);

  // ── Acceptance: 10 bad rows import 490 and report the 10 ─────────────────────

  it('imports 490 of 500 rows and reports the 10 by line number', async () => {
    const d = deps();
    const key = `uploads/${merchantId}/partial.csv`;
    const badIndices = [3, 17, 42, 88, 120, 199, 256, 333, 401, 478];
    await d.objectStore.put(key, fiveHundredRows('PARTIAL', badIndices));
    const jobId = await createJob(key);

    const outcome = await runIngestion({ jobId, merchantId, s3Key: key }, d);

    expect(outcome.status).toBe('completed');
    expect(outcome.rowsImported).toBe(490);
    expect(outcome.rowsFailed).toBe(10);
    expect(outcome.errors).toHaveLength(10);

    // Data rows start at line 2, so index i is line i + 2.
    expect(outcome.errors.map((e) => e.row)).toEqual(badIndices.map((i) => i + 2));
    expect(outcome.errors.every((e) => e.column === 'price')).toBe(true);

    // …and the 490 really are in the database.
    const saved = await db
      .select({ id: productVariants.id })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(eq(products.merchantId, merchantId), eq(products.externalRef, 'PARTIAL-001')));
    expect(saved.length).toBeGreaterThan(0);
  }, 120_000);

  it('writes a downloadable error CSV and attaches it to the email', async () => {
    const d = deps();
    const key = `uploads/${merchantId}/errors.csv`;
    await d.objectStore.put(key, fiveHundredRows('ERRCSV', [5, 6]));
    const jobId = await createJob(key);

    const outcome = await runIngestion({ jobId, merchantId, s3Key: key }, d);

    expect(outcome.errorCsvKey).toBeDefined();
    const csv = d.objectStore.text(outcome.errorCsvKey!)!;
    expect(csv.split('\n')[0]).toBe('row,column,problem');
    expect(csv).toContain('price must be greater than 0');

    const email = d.mailer.sent.at(-1)!;
    expect(email.to).toBe('ingest-test@example.com');
    expect(email.subject).toContain('2 problem rows');
    expect(email.attachments?.[0]?.filename).toBe('import-errors.csv');
  }, 120_000);

  // ── Acceptance: re-uploading updates rather than duplicating ─────────────────

  it('updates rather than duplicates when the same file is uploaded again', async () => {
    const d = deps();
    const key = `uploads/${merchantId}/reupload.csv`;
    await d.objectStore.put(
      key,
      variantCsv([
        { external_ref: 'REUP-001', sku: 'REUP-001-40-WHITE', option_axis_1_value: '40' },
        { external_ref: 'REUP-001', sku: 'REUP-001-42-WHITE', option_axis_1_value: '42' },
      ]),
    );

    const first = await runIngestion({ jobId: await createJob(key), merchantId, s3Key: key }, d);
    expect(first.productsCreated).toBe(1);
    expect(first.productsUpdated).toBe(0);

    // Same refs and SKUs, a changed price and stock.
    await d.objectStore.put(
      key,
      variantCsv([
        {
          external_ref: 'REUP-001',
          sku: 'REUP-001-40-WHITE',
          option_axis_1_value: '40',
          price: '2199',
          stock: '3',
        },
        { external_ref: 'REUP-001', sku: 'REUP-001-42-WHITE', option_axis_1_value: '42' },
      ]),
    );

    const second = await runIngestion({ jobId: await createJob(key), merchantId, s3Key: key }, d);
    expect(second.productsCreated).toBe(0);
    expect(second.productsUpdated).toBe(1);

    const rows = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.merchantId, merchantId), eq(products.externalRef, 'REUP-001')));
    expect(rows).toHaveLength(1);

    const variants = await db
      .select({
        sku: productVariants.sku,
        price: productVariants.pricePaise,
        stock: productVariants.stock,
      })
      .from(productVariants)
      .where(eq(productVariants.productId, rows[0]!.id));
    expect(variants).toHaveLength(2);

    const updated = variants.find((v) => v.sku === 'REUP-001-40-WHITE')!;
    expect(updated.price).toBe(219900n);
    expect(updated.stock).toBe(3);
  }, 120_000);

  // ── Whole-file rejection ────────────────────────────────────────────────────

  it('rejects a header mismatch without importing anything', async () => {
    const d = deps();
    const key = `uploads/${merchantId}/badheader.csv`;
    const typoed = VARIANT_HEADERS.map((h) => (h === 'delivery_days' ? 'delivery_day' : h));
    await d.objectStore.put(
      key,
      [typoed.join(','), VARIANT_HEADERS.map(() => 'x').join(',')].join('\n'),
    );
    const jobId = await createJob(key);

    const outcome = await runIngestion({ jobId, merchantId, s3Key: key }, d);

    expect(outcome.status).toBe('failed');
    expect(outcome.rejectionReason).toContain('"delivery_day"');
    expect(outcome.productsCreated).toBe(0);
    expect(d.enrichmentQueue.messages).toHaveLength(0);

    const [job] = await db.select().from(ingestionJobs).where(eq(ingestionJobs.id, jobId));
    expect(job?.status).toBe('failed');
    expect(d.mailer.sent.at(-1)?.subject).toContain('could not be imported');
  }, 120_000);

  // ── Queueing and idempotency ────────────────────────────────────────────────

  it('enqueues one enrichment message per product', async () => {
    const d = deps();
    const key = `uploads/${merchantId}/enqueue.csv`;
    await d.objectStore.put(
      key,
      variantCsv([
        { external_ref: 'ENQ-001', sku: 'ENQ-001-A', option_axis_1_value: '40' },
        {
          external_ref: 'ENQ-002',
          sku: 'ENQ-002-A',
          option_axis_1_value: '40',
          name: 'Second Shirt',
        },
      ]),
    );

    await runIngestion({ jobId: await createJob(key), merchantId, s3Key: key }, d);

    expect(d.enrichmentQueue.messages).toHaveLength(2);
    expect(d.enrichmentQueue.messages.every((m) => m.merchantId === merchantId)).toBe(true);
  }, 120_000);

  it('does not re-import a redelivered message for a completed job', async () => {
    const d = deps();
    const key = `uploads/${merchantId}/idempotent.csv`;
    await d.objectStore.put(
      key,
      variantCsv([{ external_ref: 'IDEM-001', sku: 'IDEM-001-A', option_axis_1_value: '40' }]),
    );
    const jobId = await createJob(key);

    const first = await runIngestion({ jobId, merchantId, s3Key: key }, d);
    expect(first.productsCreated).toBe(1);

    // SQS is at-least-once; the same message arrives again.
    const replay = await runIngestion({ jobId, merchantId, s3Key: key }, d);
    expect(replay.skipped).toBe(true);
    expect(d.enrichmentQueue.messages).toHaveLength(1);
  }, 120_000);

  it('marks new products draft so nothing reaches search before it is indexed', async () => {
    const d = deps();
    const key = `uploads/${merchantId}/draft.csv`;
    await d.objectStore.put(
      key,
      variantCsv([{ external_ref: 'DRAFT-001', sku: 'DRAFT-001-A', option_axis_1_value: '40' }]),
    );
    await runIngestion({ jobId: await createJob(key), merchantId, s3Key: key }, d);

    const [row] = await db
      .select({ status: products.status, hint: products.categoryHint })
      .from(products)
      .where(and(eq(products.merchantId, merchantId), eq(products.externalRef, 'DRAFT-001')));
    expect(row?.status).toBe('draft');
    expect(row?.hint).toBe('shirts');
  }, 120_000);

  it('leaves an already-active product active when it is re-uploaded', async () => {
    const d = deps();
    const key = `uploads/${merchantId}/active.csv`;
    const content = variantCsv([
      { external_ref: 'ACTIVE-001', sku: 'ACTIVE-001-A', option_axis_1_value: '40' },
    ]);
    await d.objectStore.put(key, content);
    await runIngestion({ jobId: await createJob(key), merchantId, s3Key: key }, d);

    // Enrichment and embedding have since made it live.
    await db
      .update(products)
      .set({ status: 'active' })
      .where(and(eq(products.merchantId, merchantId), eq(products.externalRef, 'ACTIVE-001')));

    await runIngestion({ jobId: await createJob(key), merchantId, s3Key: key }, d);

    const [row] = await db
      .select({ status: products.status })
      .from(products)
      .where(and(eq(products.merchantId, merchantId), eq(products.externalRef, 'ACTIVE-001')));
    // A price correction must not pull a live product out of the catalogue.
    expect(row?.status).toBe('active');
  }, 120_000);
});
