CREATE TABLE "location_settings" (
	"location_id" text PRIMARY KEY NOT NULL,
	"qbo_sync_direction" text DEFAULT 'off' NOT NULL,
	"qbo_milestone_invoicing" boolean DEFAULT false NOT NULL,
	"qbo_contact_sync_pipeline_id" text,
	"qbo_assigned_user_field" text,
	"qbo_assigned_user_ghl_field" text,
	"qbo_status_ghl_field" text,
	"qbo_invoice_lead_days" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "qb_sync_state" ADD COLUMN "last_won_poll_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "location_settings" ADD CONSTRAINT "location_settings_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;