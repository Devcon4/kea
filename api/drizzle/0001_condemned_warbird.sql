CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"agent_id" varchar(32) NOT NULL,
	"content" text NOT NULL,
	"thinking" text,
	"timestamp" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_messages_session" ON "messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_messages_session_ts" ON "messages" USING btree ("session_id","timestamp");