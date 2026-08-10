ALTER TABLE "providers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "providers" CASCADE;--> statement-breakpoint
-- IF EXISTS: the CASCADE on the DROP TABLE above has already removed this
-- constraint, so the bare form drizzle generates fails the migration.
ALTER TABLE "ai_runs" DROP CONSTRAINT IF EXISTS "ai_runs_provider_id_providers_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_runs" DROP COLUMN "provider_id";