ALTER TABLE "merchant_policies" ALTER COLUMN "refund_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_policies" ALTER COLUMN "terms_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_policies" ALTER COLUMN "fulfillment_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_policies" ADD COLUMN "refund_text" text;--> statement-breakpoint
ALTER TABLE "merchant_policies" ADD COLUMN "terms_text" text;--> statement-breakpoint
ALTER TABLE "merchant_policies" ADD COLUMN "fulfillment_text" text;--> statement-breakpoint
ALTER TABLE "merchant_policies" ADD COLUMN "source" text DEFAULT 'url' NOT NULL;