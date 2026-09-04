'use client';

import { useEffect, useRef, useState } from 'react';
import { api, describeError } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote } from '../../components/ui';

/**
 * T1.24 — CSV upload with live job progress.
 *
 * The upload is a presigned PUT straight to S3 rather than a POST through the API: a
 * 500-row catalogue should not travel through a Lambda, and the API's job is to authorise
 * the upload, not to carry it.
 */

interface IngestionJob {
  id: string;
  template: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  rowsTotal: number;
  rowsImported: number;
  rowsFailed: number;
  productsCreated: number;
  productsUpdated: number;
  rejectionReason?: string;
  errorCsvKey?: string;
  createdAt: string;
}

export default function UploadsPage() {
  const [template, setTemplate] = useState<'simple' | 'variant'>('simple');
  const [jobs, setJobs] = useState<IngestionJob[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function loadJobs() {
    try {
      const response = await api.get<{ jobs: IngestionJob[] }>('/merchant/uploads');
      setJobs(response.jobs);
      return response.jobs;
    } catch {
      return [];
    }
  }

  useEffect(() => {
    void loadJobs();
  }, []);

  /**
   * Polls only while something is actually running, and stops when nothing is.
   * A dashboard left open on this page should not keep a request in flight all afternoon.
   */
  useEffect(() => {
    const active = jobs.some((job) => job.status === 'queued' || job.status === 'running');
    if (!active) return;

    const timer = setInterval(() => void loadJobs(), 2000);
    return () => clearInterval(timer);
  }, [jobs]);

  async function upload(file: File) {
    setUploading(true);
    setError(null);

    try {
      const { upload: presigned } = await api.post<{ upload: { url: string } }>(
        '/merchant/uploads',
        {
          template,
        },
      );

      const response = await fetch(presigned.url, { method: 'PUT', body: file });
      if (!response.ok) {
        throw new Error(`The upload was rejected (${response.status}).`);
      }

      // The S3 event triggers ingestion; the job row appears shortly after.
      setTimeout(() => void loadJobs(), 1500);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Uploads</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[hsl(var(--muted))]">
          Download a template, fill it in, and upload it. Re-uploading the same file updates your
          products rather than duplicating them.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Upload a CSV"
          description="Do not edit the header row — a file whose headers do not match is rejected whole, rather than half-imported."
        />
        <div className="space-y-4 px-5 py-5">
          <div className="flex gap-2">
            {(['simple', 'variant'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setTemplate(option)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                  template === option
                    ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent-soft))] text-[hsl(var(--accent))]'
                    : 'border-[hsl(var(--border))]'
                }`}
              >
                {option === 'simple' ? 'Simple products' : 'Products with options'}
              </button>
            ))}
          </div>

          <p className="text-sm text-[hsl(var(--muted))]">
            {template === 'simple'
              ? 'One row per product. Use this when a product is sold one way only.'
              : 'One row per variant. Rows sharing an external_ref become one product with an option matrix.'}
          </p>

          <div className="flex flex-wrap gap-2">
            {/*
              A plain link to a static file, not an API call.

              This used to hit `/merchant/uploads/templates/...`, which sits behind the
              gateway's authorizer — so the browser got a 403 and the merchant got a button
              that did nothing. The file is generated at build time from the same header
              arrays the validator enforces, so it cannot drift from what we accept.
            */}
            <Button variant="secondary">
              <a href={`/templates/${template}-products.csv`} download>
                Download the {template} template
              </a>
            </Button>
            <Button variant="secondary">
              <a href={`/templates/${template}-products-guide.md`} download>
                Column guide
              </a>
            </Button>

            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <Button onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? 'Uploading…' : 'Choose a file'}
            </Button>
          </div>

          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      </Card>

      <Card>
        <CardHeader title="Recent uploads" />
        {jobs.length === 0 ? (
          <Empty title="No uploads yet" reason="Your import history will appear here." />
        ) : (
          <ul className="divide-y divide-[hsl(var(--border))]">
            {jobs.map((job) => (
              <li key={job.id} className="px-5 py-4">
                <div className="flex items-center gap-3">
                  <JobBadge status={job.status} />
                  <span className="text-sm text-[hsl(var(--muted))]">
                    {relativeTime(job.createdAt)}
                  </span>
                  <span className="ml-auto text-sm tabular-nums">
                    {job.rowsImported}/{job.rowsTotal} rows
                  </span>
                </div>

                {job.status === 'failed' && job.rejectionReason && (
                  <p className="mt-2 text-sm text-[hsl(var(--danger))]">{job.rejectionReason}</p>
                )}

                {job.status === 'completed' && (
                  <p className="mt-1.5 text-sm text-[hsl(var(--muted))]">
                    {job.productsCreated} created, {job.productsUpdated} updated
                    {job.rowsFailed > 0 && ` · ${job.rowsFailed} rows could not be imported`}
                  </p>
                )}

                {job.errorCsvKey && (
                  <a
                    href={`/merchant/uploads/${job.id}/errors`}
                    className="mt-2 inline-block text-sm font-medium text-[hsl(var(--accent))]"
                  >
                    Download the rows that failed →
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function JobBadge({ status }: { status: IngestionJob['status'] }) {
  if (status === 'completed') return <Badge tone="ok">Imported</Badge>;
  if (status === 'failed') return <Badge tone="danger">Rejected</Badge>;
  if (status === 'running') return <Badge tone="accent">Importing…</Badge>;
  return <Badge>Queued</Badge>;
}
