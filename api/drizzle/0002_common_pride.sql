CREATE TABLE "features" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"url_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"discovered_by" text DEFAULT 'manual' NOT NULL,
	"discovered_at" bigint NOT NULL,
	"verified_at" bigint
);
--> statement-breakpoint
CREATE TABLE "scenarios" (
	"id" serial PRIMARY KEY NOT NULL,
	"test_plan_id" integer NOT NULL,
	"name" text NOT NULL,
	"entry_url" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_outcome" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"feature_id" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"verified_at" bigint,
	"created_by" text DEFAULT 'manual' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"scenario_id" integer NOT NULL,
	"started_at" bigint NOT NULL,
	"completed_at" bigint,
	"result" text NOT NULL,
	"step_trace" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"finding_id" integer
);
--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "scenario_id" integer;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_test_plan_id_test_plans_id_fk" FOREIGN KEY ("test_plan_id") REFERENCES "public"."test_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plans" ADD CONSTRAINT "test_plans_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_scenario_id_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_features_session_status" ON "features" USING btree ("session_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_features_session_name" ON "features" USING btree ("session_id","name");--> statement-breakpoint
CREATE INDEX "idx_scenarios_test_plan" ON "scenarios" USING btree ("test_plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_test_plans_feature_revision" ON "test_plans" USING btree ("feature_id","revision");--> statement-breakpoint
CREATE INDEX "idx_test_plans_feature_status" ON "test_plans" USING btree ("feature_id","status");--> statement-breakpoint
CREATE INDEX "idx_test_runs_scenario_started" ON "test_runs" USING btree ("scenario_id","started_at");--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_scenario_id_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_findings_scenario" ON "findings" USING btree ("scenario_id");