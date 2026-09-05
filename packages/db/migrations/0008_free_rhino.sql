CREATE TABLE "site_import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"site_url" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"method" text,
	"next_offset" integer DEFAULT 0 NOT NULL,
	"slots_done" integer DEFAULT 0 NOT NULL,
	"products_found" integer DEFAULT 0 NOT NULL,
	"products_created" integer DEFAULT 0 NOT NULL,
	"products_updated" integer DEFAULT 0 NOT NULL,
	"variants_upserted" integer DEFAULT 0 NOT NULL,
	"skipped" jsonb,
	"rejection_reason" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_import_jobs_status_check" CHECK ("site_import_jobs"."status" IN ('queued', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "site_import_jobs" ADD CONSTRAINT "site_import_jobs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_import_jobs_merchant_created_idx" ON "site_import_jobs" USING btree ("merchant_id","created_at");