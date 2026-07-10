CREATE TABLE "qb_milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"location_id" text NOT NULL,
	"opportunity_id" text NOT NULL,
	"contact_id" text,
	"qb_customer_id" text,
	"milestone_type" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"milestone_date" timestamp with time zone,
	"invoice_lead_days" integer DEFAULT 3 NOT NULL,
	"qb_invoice_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"invoiced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qb_sync_links" (
	"id" text PRIMARY KEY NOT NULL,
	"location_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"ghl_id" text NOT NULL,
	"qb_id" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "qb_milestones" ADD CONSTRAINT "qb_milestones_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qb_sync_links" ADD CONSTRAINT "qb_sync_links_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qb_milestones_location_opp_type_uidx" ON "qb_milestones" USING btree ("location_id","opportunity_id","milestone_type");--> statement-breakpoint
CREATE INDEX "qb_milestones_status_idx" ON "qb_milestones" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "qb_sync_links_location_type_ghl_uidx" ON "qb_sync_links" USING btree ("location_id","entity_type","ghl_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qb_sync_links_location_type_qb_uidx" ON "qb_sync_links" USING btree ("location_id","entity_type","qb_id");