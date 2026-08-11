CREATE TABLE "brand_voices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "brand_voice" text;--> statement-breakpoint
ALTER TABLE "brand_voices" ADD CONSTRAINT "brand_voices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_voices_one_default_idx" ON "brand_voices" USING btree ("is_default") WHERE "brand_voices"."is_default";