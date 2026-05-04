CREATE TABLE "test_run_artifacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"test_run_id" integer NOT NULL,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "diagnostics" jsonb;--> statement-breakpoint
ALTER TABLE "test_run_artifacts" ADD CONSTRAINT "test_run_artifacts_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_test_run_artifacts_run_kind" ON "test_run_artifacts" USING btree ("test_run_id","kind");