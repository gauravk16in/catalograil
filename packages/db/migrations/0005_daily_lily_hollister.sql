CREATE TABLE "merchant_payment_config" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"method" text DEFAULT 'api_keys' NOT NULL,
	"key_id" text,
	"key_secret_encrypted" text,
	"key_secret_last4" text,
	"webhook_secret_encrypted" text,
	"mode" text,
	"status" text DEFAULT 'unverified' NOT NULL,
	"verified_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_payment_config" ADD CONSTRAINT "merchant_payment_config_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;