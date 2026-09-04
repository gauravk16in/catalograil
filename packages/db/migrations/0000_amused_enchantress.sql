CREATE TABLE "adapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"base_url" text NOT NULL,
	"auth_type" text NOT NULL,
	"auth_ref" text,
	"timeout_ms" integer DEFAULT 2000 NOT NULL,
	"health_status" text DEFAULT 'healthy' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"circuit_open_until" timestamp with time zone,
	"last_health_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adapters_capability_check" CHECK ("adapters"."capability" IN ('catalog', 'live_price', 'bookable', 'quote'))
);
--> statement-breakpoint
CREATE TABLE "buyer_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"buyer_id" uuid NOT NULL,
	"label" text,
	"recipient_name" text NOT NULL,
	"recipient_phone" text NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"landmark" text,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"pincode" text NOT NULL,
	"country" text DEFAULT 'IN' NOT NULL,
	"delivery_notes" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buyers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text,
	"phone" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"phone_verified" boolean DEFAULT false NOT NULL,
	"default_address_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"path" "ltree",
	"attribute_schema" jsonb,
	"review_status" text DEFAULT 'approved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug"),
	CONSTRAINT "categories_review_status_check" CHECK ("categories"."review_status" IN ('approved', 'pending_review'))
);
--> statement-breakpoint
CREATE TABLE "ingestion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"s3_key" text NOT NULL,
	"template" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"rows_total" integer DEFAULT 0 NOT NULL,
	"rows_imported" integer DEFAULT 0 NOT NULL,
	"rows_failed" integer DEFAULT 0 NOT NULL,
	"products_created" integer DEFAULT 0 NOT NULL,
	"products_updated" integer DEFAULT 0 NOT NULL,
	"variants_upserted" integer DEFAULT 0 NOT NULL,
	"errors" jsonb,
	"error_csv_key" text,
	"rejection_reason" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_jobs_status_check" CHECK ("ingestion_jobs"."status" IN ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "ingestion_jobs_template_check" CHECK ("ingestion_jobs"."template" IN ('simple', 'variant'))
);
--> statement-breakpoint
CREATE TABLE "merchant_capabilities" (
	"merchant_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"config" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "merchant_capabilities_merchant_id_capability_pk" PRIMARY KEY("merchant_id","capability"),
	CONSTRAINT "merchant_capabilities_capability_check" CHECK ("merchant_capabilities"."capability" IN ('catalog', 'live_price', 'bookable', 'quote'))
);
--> statement-breakpoint
CREATE TABLE "merchant_metrics" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"orders_total" integer DEFAULT 0 NOT NULL,
	"orders_fulfilled" integer DEFAULT 0 NOT NULL,
	"orders_cancelled" integer DEFAULT 0 NOT NULL,
	"on_time_deliveries" integer DEFAULT 0 NOT NULL,
	"avg_rating" numeric(3, 2),
	"rating_count" integer DEFAULT 0 NOT NULL,
	"avg_ack_minutes" integer,
	"dispute_count" integer DEFAULT 0 NOT NULL,
	"verification_score" numeric(4, 3),
	"trust_score" numeric(4, 3),
	"is_new_merchant" boolean DEFAULT true NOT NULL,
	"computed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "merchant_policies" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"refund_url" text NOT NULL,
	"terms_url" text NOT NULL,
	"fulfillment_url" text NOT NULL,
	"refund_summary" text,
	"terms_summary" text,
	"fulfillment_summary" text,
	"return_window_days" integer,
	"return_shipping_by" text,
	"dispatch_sla_hours" integer,
	"last_checked_at" timestamp with time zone,
	"last_check_status" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_tokens" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"scopes" text[],
	"last_refreshed_at" timestamp with time zone,
	"refresh_failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_name" text NOT NULL,
	"legal_name" text,
	"contact_email" text NOT NULL,
	"contact_phone" text,
	"gstin" text,
	"gstin_verified" boolean DEFAULT false NOT NULL,
	"razorpay_account_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"categories" text[],
	"city" text,
	"state" text,
	"onboarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_razorpay_account_id_unique" UNIQUE("razorpay_account_id"),
	CONSTRAINT "merchants_status_check" CHECK ("merchants"."status" IN ('pending', 'active', 'suspended', 'delisted'))
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"slot_id" uuid,
	"name_snapshot" text NOT NULL,
	"sku_snapshot" text,
	"options_snapshot" jsonb,
	"unit_price_paise" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"line_total_paise" bigint NOT NULL,
	"promised_delivery_date" timestamp with time zone,
	CONSTRAINT "order_items_quantity_positive" CHECK ("order_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" text NOT NULL,
	"buyer_id" uuid,
	"buyer_email" text NOT NULL,
	"buyer_phone" text,
	"merchant_id" uuid NOT NULL,
	"shipping_address" jsonb,
	"subtotal_paise" bigint NOT NULL,
	"shipping_paise" bigint DEFAULT 0 NOT NULL,
	"tax_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint NOT NULL,
	"status" text DEFAULT 'awaiting_payment' NOT NULL,
	"razorpay_order_id" text,
	"razorpay_payment_id" text,
	"payment_link_url" text,
	"payment_expires_at" timestamp with time zone,
	"source" text NOT NULL,
	"session_id" text,
	"policy_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number"),
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" IN ('awaiting_payment', 'paid', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded', 'failed')),
	CONSTRAINT "orders_source_check" CHECK ("orders"."source" IN ('claude', 'chatgpt', 'web')),
	CONSTRAINT "orders_total_positive" CHECK ("orders"."total_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "product_option_axes" (
	"product_id" uuid NOT NULL,
	"axis_name" text NOT NULL,
	"axis_values" text[] NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_option_axes_product_id_axis_name_pk" PRIMARY KEY("product_id","axis_name")
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"option_values" jsonb NOT NULL,
	"price_paise" bigint,
	"mrp_paise" bigint,
	"stock" integer DEFAULT 0 NOT NULL,
	"delivery_days" integer,
	"weight_grams" integer,
	"dimensions_cm" jsonb,
	"images" text[],
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "product_variants_product_sku_key" UNIQUE("product_id","sku"),
	CONSTRAINT "product_variants_price_positive" CHECK ("product_variants"."price_paise" IS NULL OR "product_variants"."price_paise" > 0),
	CONSTRAINT "product_variants_stock_non_negative" CHECK ("product_variants"."stock" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"external_ref" text,
	"archetype" text NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"description" text,
	"category_id" uuid,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"use_cases" text[],
	"target_audience" text[],
	"occasions" text[],
	"keywords" text[],
	"enrichment_source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"images" text[],
	"status" text DEFAULT 'draft' NOT NULL,
	"route_or_scope" text,
	"price_range_hint" text,
	"adapter_id" uuid,
	"rfq_fields" jsonb,
	"typical_turnaround_hours" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_merchant_external_ref_key" UNIQUE("merchant_id","external_ref"),
	CONSTRAINT "products_archetype_check" CHECK ("products"."archetype" IN ('SIMPLE', 'VARIANT', 'LIVE_PRICED', 'BOOKABLE', 'QUOTE')),
	CONSTRAINT "products_status_check" CHECK ("products"."status" IN ('draft', 'active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"buyer_id" uuid,
	"buyer_email" text NOT NULL,
	"rfq_payload" jsonb NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"quoted_amount_paise" bigint,
	"quoted_notes" text,
	"valid_until" timestamp with time zone,
	"razorpay_order_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "quotations_status_check" CHECK ("quotations"."status" IN ('requested', 'quoted', 'accepted', 'expired', 'declined'))
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"buyer_id" uuid,
	"merchant_id" uuid NOT NULL,
	"product_id" uuid,
	"rating" integer NOT NULL,
	"title" text,
	"body" text,
	"delivered_on_time" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "searchable_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_type" text NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"merchant_id" uuid NOT NULL,
	"archetype" text NOT NULL,
	"category_id" uuid,
	"category_path" "ltree",
	"price_paise" bigint,
	"in_stock" boolean DEFAULT false NOT NULL,
	"delivery_days" integer,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"merchant_status" text NOT NULL,
	"trust_score" numeric(4, 3),
	"canonical_text" text NOT NULL,
	"content_hash" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', canonical_text)) STORED,
	"v_semantic" vector(1024),
	"v_intent" vector(1024),
	"v_visual" vector(1024),
	"embedding_version" text DEFAULT 'v1' NOT NULL,
	"embedding_status" text DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "searchable_units_unit_type_check" CHECK ("searchable_units"."unit_type" IN ('variant', 'product', 'offering')),
	CONSTRAINT "searchable_units_archetype_check" CHECK ("searchable_units"."archetype" IN ('SIMPLE', 'VARIANT', 'LIVE_PRICED', 'BOOKABLE', 'QUOTE')),
	CONSTRAINT "searchable_units_merchant_status_check" CHECK ("searchable_units"."merchant_status" IN ('pending', 'active', 'suspended', 'delisted')),
	CONSTRAINT "searchable_units_embedding_status_check" CHECK ("searchable_units"."embedding_status" IN ('pending', 'indexed', 'failed')),
	CONSTRAINT "searchable_units_variant_consistency" CHECK (("searchable_units"."unit_type" = 'variant' AND "searchable_units"."variant_id" IS NOT NULL)
          OR ("searchable_units"."unit_type" <> 'variant' AND "searchable_units"."variant_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "slot_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'held' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"adapter_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"capacity" integer NOT NULL,
	"booked" integer DEFAULT 0 NOT NULL,
	"price_paise" bigint,
	"location" jsonb,
	"metadata" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	CONSTRAINT "slots_booked_within_capacity" CHECK ("slots"."booked" >= 0 AND "slots"."booked" <= "slots"."capacity")
);
--> statement-breakpoint
ALTER TABLE "adapters" ADD CONSTRAINT "adapters_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_addresses" ADD CONSTRAINT "buyer_addresses_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_capabilities" ADD CONSTRAINT "merchant_capabilities_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_metrics" ADD CONSTRAINT "merchant_metrics_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_policies" ADD CONSTRAINT "merchant_policies_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_tokens" ADD CONSTRAINT "merchant_tokens_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_slot_id_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_option_axes" ADD CONSTRAINT "product_option_axes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_adapter_id_adapters_id_fk" FOREIGN KEY ("adapter_id") REFERENCES "public"."adapters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "searchable_units" ADD CONSTRAINT "searchable_units_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "searchable_units" ADD CONSTRAINT "searchable_units_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_slot_id_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_adapter_id_adapters_id_fk" FOREIGN KEY ("adapter_id") REFERENCES "public"."adapters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adapters_merchant_idx" ON "adapters" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "buyer_addresses_buyer_idx" ON "buyer_addresses" USING btree ("buyer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "buyers_email_key" ON "buyers" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "buyers_phone_key" ON "buyers" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "categories_path_idx" ON "categories" USING gist ("path");--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_merchant_created_idx" ON "ingestion_jobs" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "merchant_tokens_access_expires_idx" ON "merchant_tokens" USING btree ("access_expires_at");--> statement-breakpoint
CREATE INDEX "merchants_status_created_idx" ON "merchants" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "order_events_order_created_idx" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_merchant_created_idx" ON "orders" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_buyer_email_created_idx" ON "orders" USING btree ("buyer_email","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_created_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "orders_razorpay_order_idx" ON "orders" USING btree ("razorpay_order_id");--> statement-breakpoint
CREATE INDEX "product_variants_product_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "products_merchant_status_idx" ON "products" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "quotations_merchant_status_idx" ON "quotations" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE INDEX "reviews_merchant_idx" ON "reviews" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "reviews_product_idx" ON "reviews" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "searchable_units_semantic_hnsw" ON "searchable_units" USING hnsw ("v_semantic" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "searchable_units_visual_hnsw" ON "searchable_units" USING hnsw ("v_visual" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "searchable_units_intent_hnsw" ON "searchable_units" USING hnsw ("v_intent" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "searchable_units_tsv_gin" ON "searchable_units" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "searchable_units_attributes_gin" ON "searchable_units" USING gin ("attributes" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "searchable_units_category_path_gist" ON "searchable_units" USING gist ("category_path");--> statement-breakpoint
CREATE INDEX "searchable_units_filter_idx" ON "searchable_units" USING btree ("merchant_status","in_stock","price_paise");--> statement-breakpoint
CREATE INDEX "searchable_units_embedding_status_idx" ON "searchable_units" USING btree ("embedding_status","updated_at");--> statement-breakpoint
CREATE INDEX "searchable_units_product_idx" ON "searchable_units" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "searchable_units_variant_idx" ON "searchable_units" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "searchable_units_merchant_idx" ON "searchable_units" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "slot_holds_expires_idx" ON "slot_holds" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "slot_holds_slot_idx" ON "slot_holds" USING btree ("slot_id");--> statement-breakpoint
CREATE INDEX "slots_product_starts_idx" ON "slots" USING btree ("product_id","starts_at");