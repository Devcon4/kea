CREATE TABLE "findings" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"url" text NOT NULL,
	"agent_id" text NOT NULL,
	"action" text NOT NULL,
	"result" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"timestamp" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"target_url" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"max_pages" integer DEFAULT 50 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" bigint NOT NULL,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "sitemap" (
	"session_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'discovered' NOT NULL,
	"discovered_at" bigint NOT NULL,
	"visited_at" bigint,
	CONSTRAINT "sitemap_session_id_url_pk" PRIMARY KEY("session_id","url")
);
--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitemap" ADD CONSTRAINT "sitemap_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_findings_session" ON "findings" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_findings_severity" ON "findings" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "idx_sitemap_session_status" ON "sitemap" USING btree ("session_id","status");