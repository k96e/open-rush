CREATE TABLE "llm_budget_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" varchar(20) NOT NULL,
	"subject_id" uuid,
	"window_key" varchar(20) NOT NULL,
	"cost_usd" numeric(14, 6) DEFAULT '0' NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_budget_usage_subject_window_uniq" UNIQUE NULLS NOT DISTINCT("subject_type","subject_id","window_key"),
	CONSTRAINT "llm_budget_usage_subject_type_check" CHECK ("llm_budget_usage"."subject_type" IN ('global','project','user','agent'))
);
--> statement-breakpoint
CREATE TABLE "llm_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" varchar(20) NOT NULL,
	"subject_id" uuid,
	"window" varchar(20) NOT NULL,
	"limit_usd" numeric(12, 6) NOT NULL,
	"enforce" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_budgets_subject_window_idx" UNIQUE NULLS NOT DISTINCT("subject_type","subject_id","window"),
	CONSTRAINT "llm_budgets_subject_type_check" CHECK ("llm_budgets"."subject_type" IN ('global','project','user','agent')),
	CONSTRAINT "llm_budgets_window_check" CHECK ("llm_budgets"."window" IN ('day','month','total'))
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" varchar(64),
	"token_id" uuid,
	"subject_type" varchar(20) NOT NULL,
	"run_id" uuid,
	"agent_id" uuid,
	"project_id" uuid,
	"owner_user_id" uuid,
	"cc_session_id" varchar(128),
	"cc_agent_id" varchar(128),
	"model_alias" varchar(255) NOT NULL,
	"provider_id" uuid,
	"upstream_model" varchar(255),
	"protocol" varchar(20) NOT NULL,
	"mode" varchar(20) NOT NULL,
	"stream" boolean DEFAULT false NOT NULL,
	"status" varchar(30) NOT NULL,
	"http_status" integer,
	"error_code" varchar(50),
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_cache_write" integer DEFAULT 0 NOT NULL,
	"tokens_cache_read" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"tokens_reasoning" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"ttfb_ms" integer,
	"latency_ms" integer,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_catalog_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_catalog_state_singleton" CHECK ("llm_catalog_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "llm_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"alg" varchar(40) DEFAULT 'x25519-hkdf-sha256-aes256gcm' NOT NULL,
	"key_id" varchar(64) NOT NULL,
	"sealed_value" text NOT NULL,
	"auth_style" varchar(20) DEFAULT 'bearer' NOT NULL,
	"auth_header" varchar(64),
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "llm_credentials_name_unique" UNIQUE("name"),
	CONSTRAINT "llm_credentials_auth_style_check" CHECK ("llm_credentials"."auth_style" IN ('bearer','x-api-key','header')),
	CONSTRAINT "llm_credentials_auth_header_check" CHECK ("llm_credentials"."auth_style" <> 'header' OR "llm_credentials"."auth_header" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "llm_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alias" varchar(255) NOT NULL,
	"provider_id" uuid NOT NULL,
	"upstream_model" varchar(255) NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"display_name" varchar(255),
	"max_output_tokens" integer,
	"price_input_per_mtok" numeric(12, 6) DEFAULT '0' NOT NULL,
	"price_output_per_mtok" numeric(12, 6) DEFAULT '0' NOT NULL,
	"price_cache_write_per_mtok" numeric(12, 6) DEFAULT '0' NOT NULL,
	"price_cache_read_per_mtok" numeric(12, 6) DEFAULT '0' NOT NULL,
	"price_reasoning_per_mtok" numeric(12, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_models_alias_provider_idx" UNIQUE("alias","provider_id")
);
--> statement-breakpoint
CREATE TABLE "llm_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"protocol" varchar(20) NOT NULL,
	"base_url" text NOT NULL,
	"credential_id" uuid,
	"default_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timeout_ms" integer DEFAULT 600000 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_providers_name_unique" UNIQUE("name"),
	CONSTRAINT "llm_providers_protocol_check" CHECK ("llm_providers"."protocol" IN ('anthropic','openai'))
);
--> statement-breakpoint
CREATE TABLE "llm_router_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"subject_type" varchar(20) NOT NULL,
	"run_id" uuid,
	"agent_id" uuid,
	"project_id" uuid,
	"owner_user_id" uuid,
	"allowed_model_aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_cost_usd" numeric(12, 6),
	"max_requests_per_minute" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_router_tokens_subject_check" CHECK (("llm_router_tokens"."subject_type" = 'run' AND "llm_router_tokens"."run_id" IS NOT NULL) OR "llm_router_tokens"."subject_type" = 'service')
);
--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_token_id_llm_router_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."llm_router_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_credentials" ADD CONSTRAINT "llm_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_models" ADD CONSTRAINT "llm_models_provider_id_llm_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_credential_id_llm_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."llm_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_router_tokens" ADD CONSTRAINT "llm_router_tokens_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_router_tokens" ADD CONSTRAINT "llm_router_tokens_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_router_tokens" ADD CONSTRAINT "llm_router_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_router_tokens" ADD CONSTRAINT "llm_router_tokens_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_calls_run_idx" ON "llm_calls" USING btree ("run_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_calls_project_started_idx" ON "llm_calls" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_calls_session_idx" ON "llm_calls" USING btree ("cc_session_id");--> statement-breakpoint
CREATE INDEX "llm_calls_status_idx" ON "llm_calls" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "llm_calls_token_idx" ON "llm_calls" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "llm_credentials_key_id_idx" ON "llm_credentials" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "llm_models_alias_enabled_idx" ON "llm_models" USING btree ("alias","enabled","priority");--> statement-breakpoint
CREATE INDEX "llm_providers_enabled_idx" ON "llm_providers" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_router_tokens_hash_uniq" ON "llm_router_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "llm_router_tokens_active_idx" ON "llm_router_tokens" USING btree ("token_hash") WHERE "llm_router_tokens"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "llm_router_tokens_run_idx" ON "llm_router_tokens" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "llm_router_tokens_project_idx" ON "llm_router_tokens" USING btree ("project_id");--> statement-breakpoint
-- llm_catalog_state 是单行表（id 恒为 1，由 llm_catalog_state_singleton 约束强制），
-- 种子行必须手写——drizzle 不生成 DML。
-- 目录热变更（D7）依赖这一行存在：写方在事务内 version++，提交后 pg_notify('llm_catalog', version)。
INSERT INTO "llm_catalog_state" ("id", "version") VALUES (1, 0) ON CONFLICT ("id") DO NOTHING;
