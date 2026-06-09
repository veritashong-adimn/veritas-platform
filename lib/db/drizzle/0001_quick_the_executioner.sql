ALTER TABLE "translator_profiles" ADD COLUMN "operational_status" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "translator_profiles" ADD COLUMN "operational_note" text;--> statement-breakpoint
ALTER TABLE "translator_profiles" ADD COLUMN "reassignment_allowed" boolean DEFAULT true NOT NULL;