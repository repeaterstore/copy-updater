CREATE TABLE "settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"openrouter_key_encrypted" text,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_model" text,
	"fallback_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reasoning_level" text DEFAULT 'medium' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "reasoning_level" text;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "web_search" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "distinct_options" boolean DEFAULT false NOT NULL;