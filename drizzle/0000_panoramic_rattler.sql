CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"wallet_address" varchar(255),
	"entry_tx_hash" varchar(255),
	"location" varchar(255) DEFAULT 'grand_atrium' NOT NULL,
	"babel_coins" numeric(18, 2) DEFAULT '100' NOT NULL,
	"cult_id" uuid,
	"reputation" integer DEFAULT 0 NOT NULL,
	"titles" text[],
	"jailed_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_action_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agents_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid,
	"action" varchar(255) NOT NULL,
	"params" jsonb,
	"result" jsonb,
	"tick_number" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commodities" (
	"name" varchar(255) PRIMARY KEY NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"base_price" numeric(18, 2) NOT NULL,
	"current_price" numeric(18, 2) NOT NULL,
	"supply" numeric(18, 4) DEFAULT '0' NOT NULL,
	"volatility" numeric(5, 2) DEFAULT '1.0' NOT NULL,
	"decay_rate" numeric(5, 4) DEFAULT '0' NOT NULL,
	"is_perishable" boolean DEFAULT false NOT NULL,
	"created_by_cult" uuid
);
--> statement-breakpoint
CREATE TABLE "cult_members" (
	"cult_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" varchar(50) DEFAULT 'member' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cult_members_cult_id_agent_id_pk" PRIMARY KEY("cult_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "cults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"doctrine" text NOT NULL,
	"founder_id" uuid NOT NULL,
	"treasury" numeric(18, 2) DEFAULT '0' NOT NULL,
	"influence" integer DEFAULT 0 NOT NULL,
	"tithe_rate" numeric(5, 2) DEFAULT '0.10' NOT NULL,
	"member_count" integer DEFAULT 1 NOT NULL,
	"is_at_war_with" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cults_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "inventories" (
	"agent_id" uuid NOT NULL,
	"commodity" varchar(255) NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"is_counterfeit" boolean DEFAULT false NOT NULL,
	CONSTRAINT "inventories_agent_id_commodity_pk" PRIMARY KEY("agent_id","commodity")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"name" varchar(255) PRIMARY KEY NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"special_mechanic" text,
	"named_by_cult" uuid
);
--> statement-breakpoint
CREATE TABLE "rituals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cult_id" uuid NOT NULL,
	"ritual_type" varchar(255) NOT NULL,
	"target" varchar(255),
	"participants" uuid[],
	"required_participants" integer DEFAULT 3 NOT NULL,
	"status" varchar(50) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"sell_commodity" varchar(255),
	"sell_quantity" numeric(18, 4),
	"buy_commodity" varchar(255),
	"buy_quantity" numeric(18, 4),
	"price_at_trade" numeric(18, 2),
	"location" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"effects" jsonb,
	"tick_number" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_state" (
	"key" varchar(255) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cult_members" ADD CONSTRAINT "cult_members_cult_id_cults_id_fk" FOREIGN KEY ("cult_id") REFERENCES "public"."cults"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cult_members" ADD CONSTRAINT "cult_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cults" ADD CONSTRAINT "cults_founder_id_agents_id_fk" FOREIGN KEY ("founder_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rituals" ADD CONSTRAINT "rituals_cult_id_cults_id_fk" FOREIGN KEY ("cult_id") REFERENCES "public"."cults"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;