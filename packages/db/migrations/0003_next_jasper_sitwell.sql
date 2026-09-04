ALTER TABLE "buyers" ADD COLUMN "cognito_sub" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "cognito_sub" text;--> statement-breakpoint
CREATE UNIQUE INDEX "buyers_cognito_sub_key" ON "buyers" USING btree ("cognito_sub");--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_cognito_sub_key" ON "merchants" USING btree ("cognito_sub");