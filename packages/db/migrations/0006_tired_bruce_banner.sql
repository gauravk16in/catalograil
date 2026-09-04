CREATE TABLE "product_pipeline_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"message" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_pipeline_events" ADD CONSTRAINT "product_pipeline_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_pipeline_events_product_idx" ON "product_pipeline_events" USING btree ("product_id","created_at");