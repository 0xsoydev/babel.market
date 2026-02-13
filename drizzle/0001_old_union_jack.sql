CREATE TABLE "trade_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_agent_id" uuid NOT NULL,
	"to_agent_id" uuid,
	"offer_commodity" varchar(255) NOT NULL,
	"offer_quantity" numeric(18, 4) NOT NULL,
	"want_commodity" varchar(255) NOT NULL,
	"want_quantity" numeric(18, 4) NOT NULL,
	"status" varchar(50) DEFAULT 'open' NOT NULL,
	"accepted_by" uuid,
	"location" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trade_offers" ADD CONSTRAINT "trade_offers_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_offers" ADD CONSTRAINT "trade_offers_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_offers" ADD CONSTRAINT "trade_offers_accepted_by_agents_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;