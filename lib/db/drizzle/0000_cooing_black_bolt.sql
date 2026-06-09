CREATE TYPE "public"."permission_category" AS ENUM('menu', 'action');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('customer', 'translator', 'admin', 'staff', 'client', 'linguist');--> statement-breakpoint
CREATE TYPE "public"."financial_status" AS ENUM('unbilled', 'billed', 'receivable', 'paid');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('created', 'quoted', 'approved', 'paid', 'matched', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('pending', 'sent', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('waiting', 'assigned', 'working', 'done');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'paid', 'failed');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('draft', 'pending_review', 'pending', 'ready', 'paid');--> statement-breakpoint
CREATE TYPE "public"."settlement_type" AS ENUM('WITHHOLDING_3_3', 'VAT_INVOICE', 'OVERSEAS_REMITTANCE', 'OTHER_REVIEW');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('project', 'quote', 'task', 'communication', 'company', 'translator', 'translation_unit', 'product', 'product_request', 'insight');--> statement-breakpoint
CREATE TYPE "public"."comm_type" AS ENUM('email', 'phone', 'message');--> statement-breakpoint
CREATE TYPE "public"."board_category" AS ENUM('notice', 'reference', 'manual');--> statement-breakpoint
CREATE TYPE "public"."language_service_type" AS ENUM('translation', 'interpretation', 'equipment');--> statement-breakpoint
CREATE TABLE "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"category" "permission_category" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"role_id" integer NOT NULL,
	"permission_id" integer NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_unique" UNIQUE("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password" text,
	"name" text,
	"role" "user_role" DEFAULT 'client' NOT NULL,
	"role_id" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"invite_token" text,
	"department" text,
	"job_title" text,
	"company_id" integer,
	"last_login_at" timestamp,
	"last_activity_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"customer_id" integer,
	"customer_user_id" integer,
	"admin_id" integer,
	"company_id" integer,
	"contact_id" integer,
	"requesting_company_id" integer,
	"requesting_division_id" integer,
	"billing_company_id" integer,
	"billing_division_id" integer,
	"payer_company_id" integer,
	"payer_division_id" integer,
	"title" text NOT NULL,
	"file_url" text,
	"status" "project_status" DEFAULT 'created' NOT NULL,
	"financial_status" "financial_status" DEFAULT 'unbilled' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"status" "quote_status" DEFAULT 'pending' NOT NULL,
	"note" text,
	"tax_document_type" varchar(50) DEFAULT 'tax_invoice',
	"tax_category" varchar(50) DEFAULT 'normal',
	"quote_type" varchar(50) DEFAULT 'b2b_standard' NOT NULL,
	"billing_type" varchar(50) DEFAULT 'postpaid_per_project' NOT NULL,
	"payment_method" varchar(50),
	"valid_until" date,
	"issue_date" date,
	"invoice_due_date" date,
	"payment_due_date" date,
	"prepaid_balance_before" numeric(15, 2),
	"prepaid_usage_amount" numeric(15, 2),
	"prepaid_balance_after" numeric(15, 2),
	"batch_period_start" date,
	"batch_period_end" date,
	"batch_item_count" integer,
	"equipment_common" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"quote_id" integer NOT NULL,
	"product_id" integer,
	"product_name" text NOT NULL,
	"language_pair" text,
	"unit" text DEFAULT '건' NOT NULL,
	"quantity" numeric(10, 2) DEFAULT '1' NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	"supply_amount" numeric(14, 2) NOT NULL,
	"tax_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"memo" text,
	"item_type" text DEFAULT 'translation',
	"tax_type" text DEFAULT 'taxable',
	"interpret_date" date,
	"interpret_place" text,
	"interpret_type" text,
	"interpret_duration" text,
	"has_travel_expense" boolean DEFAULT false,
	"has_equipment" boolean DEFAULT false,
	"interpretation_direction" text,
	"quantity_unit" text,
	"usage_period" text,
	"event_start_date" date,
	"event_end_date" date,
	"item_location" text,
	"is_custom_product" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_item_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"quote_item_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"file_url" text NOT NULL,
	"file_size" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"translator_id" integer NOT NULL,
	"status" "task_status" DEFAULT 'waiting' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"payment_date" timestamp,
	"payment_method" varchar(100),
	"payment_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"task_id" integer,
	"translator_id" integer NOT NULL,
	"payment_id" integer,
	"translator_name" text,
	"bank_info_snapshot" jsonb,
	"total_amount" numeric(12, 2) NOT NULL,
	"translator_amount" numeric(12, 2) NOT NULL,
	"platform_fee" numeric(12, 2) NOT NULL,
	"gross_amount" numeric(12, 2),
	"net_amount" numeric(12, 2),
	"settlement_type" "settlement_type",
	"withholding_rate" numeric(7, 4),
	"withholding_amount" numeric(12, 2),
	"vat_amount" numeric(12, 2),
	"payment_method" text,
	"payout_due_date" date,
	"status" "settlement_status" DEFAULT 'pending' NOT NULL,
	"review_reason" text,
	"is_auto_generated" boolean DEFAULT false NOT NULL,
	"paid_date" timestamp,
	"paid_at" timestamp,
	"payment_memo" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" integer NOT NULL,
	"action" text NOT NULL,
	"performed_by" integer,
	"performed_by_email" text,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" text DEFAULT 'project' NOT NULL,
	"entity_id" integer NOT NULL,
	"admin_id" integer NOT NULL,
	"content" text NOT NULL,
	"tag" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communications" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"project_id" integer,
	"type" "comm_type" DEFAULT 'message' NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"business_number" text,
	"representative_name" text,
	"email" text,
	"phone" text,
	"mobile" text,
	"industry" text,
	"business_category" text,
	"address" text,
	"website" text,
	"notes" text,
	"registered_at" text,
	"billing_type" varchar(50) DEFAULT 'postpaid_per_project' NOT NULL,
	"company_type" varchar(30) DEFAULT 'client' NOT NULL,
	"vendor_type" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "divisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"name" text NOT NULL,
	"type" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"division_id" integer,
	"name" text NOT NULL,
	"department" text,
	"position" text,
	"email" text,
	"phone" text,
	"mobile" text,
	"office_phone" text,
	"notes" text,
	"memo" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_quote_contact" boolean DEFAULT false NOT NULL,
	"is_billing_contact" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"product_type" text DEFAULT 'translation' NOT NULL,
	"source_language" text,
	"target_language" text,
	"language_pair" text,
	"main_category" text,
	"sub_category" text,
	"category" text,
	"field" text,
	"unit" text DEFAULT '건' NOT NULL,
	"base_price" integer,
	"description" text,
	"interpretation_duration" text,
	"overtime_price" integer,
	"quantity_unit" text,
	"usage_period" text,
	"interpretation_direction" text,
	"active" boolean DEFAULT true NOT NULL,
	"deactivation_reason" text,
	"canonical_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "product_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"option_type" text NOT NULL,
	"option_value" text NOT NULL,
	"price" integer DEFAULT 0,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_type" text DEFAULT '' NOT NULL,
	"language_pair" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"product_type" text DEFAULT 'translation' NOT NULL,
	"source_language" text,
	"target_language" text,
	"main_category" text,
	"sub_category" text,
	"name" text NOT NULL,
	"unit" text DEFAULT '건' NOT NULL,
	"description" text,
	"unit_price" numeric(12, 2),
	"quantity_unit" text,
	"usage_period" text,
	"source_quote_item_id" integer,
	"source_project_id" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" integer,
	"requested_by_email" text,
	"approved_by" integer,
	"approved_by_email" text,
	"approved_product_id" integer,
	"rejection_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "translator_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"language_pairs" text,
	"language_level" text,
	"specializations" text,
	"education" text,
	"major" text,
	"graduation_year" integer,
	"phone" text,
	"region" text,
	"grade" text,
	"rating" real,
	"availability_status" text DEFAULT 'available' NOT NULL,
	"bio" text,
	"rate_per_word" integer,
	"rate_per_page" integer,
	"unit_type" text DEFAULT 'eojeol',
	"unit_price" integer,
	"resume_url" text,
	"portfolio_url" text,
	"affiliated_company_id" integer,
	"settlement_type" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "translator_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "translator_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"translator_id" integer NOT NULL,
	"service_type" text NOT NULL,
	"sub_type" text,
	"language" text,
	"language_pair" text,
	"unit" text DEFAULT 'word' NOT NULL,
	"rate" real NOT NULL,
	"currency" text DEFAULT 'KRW' NOT NULL,
	"vat_included" boolean DEFAULT false NOT NULL,
	"min_price" real,
	"base_hours" real,
	"overtime_rate" real,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"memo" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "translator_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"translator_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"unit_price" integer,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "translator_sensitive" (
	"id" serial PRIMARY KEY NOT NULL,
	"translator_id" integer NOT NULL,
	"payment_method" text,
	"resident_number" text,
	"bank_name" text,
	"bank_account" text,
	"account_holder" text,
	"business_number" text,
	"business_name" text,
	"business_owner" text,
	"tax_invoice_email" text,
	"english_name" text,
	"country" text,
	"currency" text,
	"paypal_email" text,
	"remittance_memo" text,
	"address_en" text,
	"bank_name_en" text,
	"swift_code" text,
	"routing_number" text,
	"iban" text,
	"base_currency" text,
	"remittance_fee_payer" text,
	"payment_hold" boolean DEFAULT false,
	"settlement_memo" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "translator_sensitive_translator_id_unique" UNIQUE("translator_id")
);
--> statement-breakpoint
CREATE TABLE "translator_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"translator_id" integer NOT NULL,
	"email" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"author_id" integer NOT NULL,
	"category" "board_category" DEFAULT 'notice' NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"visible_to_all" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"file_type" text DEFAULT 'attachment' NOT NULL,
	"file_name" text NOT NULL,
	"object_path" text NOT NULL,
	"file_size" integer,
	"mime_type" text,
	"uploaded_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_batch_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"quote_id" integer,
	"amount" numeric(15, 2) NOT NULL,
	"service_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_batch_work_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"work_date" varchar(20),
	"project_name" varchar(500),
	"language" varchar(100),
	"description" text,
	"quantity" numeric(15, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(15, 2) DEFAULT '0' NOT NULL,
	"amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"status" varchar(50) DEFAULT 'draft' NOT NULL,
	"total_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"note" text,
	"quote_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prepaid_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"initial_amount" numeric(15, 2) NOT NULL,
	"current_balance" numeric(15, 2) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"note" text,
	"deposit_date" date,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prepaid_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"project_id" integer,
	"quote_id" integer,
	"type" varchar(20) NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"balance_before" numeric(15, 2),
	"balance_after" numeric(15, 2) NOT NULL,
	"supply_amount" numeric(15, 2),
	"tax_amount" numeric(15, 2),
	"description" text,
	"transaction_date" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_name_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"company_name" text NOT NULL,
	"name_type" varchar(20) DEFAULT 'current' NOT NULL,
	"valid_from" text,
	"valid_to" text,
	"changed_at" timestamp DEFAULT now() NOT NULL,
	"changed_by" integer,
	"changed_by_email" text,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_name" varchar(200),
	"business_number" varchar(50),
	"ceo_name" varchar(100),
	"address" text,
	"email" varchar(200),
	"phone" varchar(50),
	"bank_name" varchar(100),
	"account_number" varchar(100),
	"account_holder" varchar(100),
	"quote_validity_days" integer DEFAULT 14,
	"tax_rate" numeric(5, 2) DEFAULT '10',
	"quote_notes" text,
	"signature_image_url" text,
	"default_billing_type" varchar(50) DEFAULT 'postpaid_per_project',
	"payment_due_days" integer DEFAULT 7,
	"allow_partial_payment" boolean DEFAULT false,
	"settlement_ratio" numeric(5, 2) DEFAULT '70',
	"settlement_cycle" varchar(20) DEFAULT 'monthly',
	"apply_withholding_tax" boolean DEFAULT true,
	"auto_publish_enabled" boolean DEFAULT false NOT NULL,
	"auto_publish_threshold" integer DEFAULT 80,
	"auto_publish_dry_run" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"session_id" text NOT NULL,
	"role_type" text NOT NULL,
	"login_at" timestamp DEFAULT now() NOT NULL,
	"logout_at" timestamp,
	"last_activity_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"is_online" boolean DEFAULT true NOT NULL,
	"date_key" text NOT NULL,
	CONSTRAINT "user_sessions_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "translation_units" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"task_id" integer,
	"source_text" text NOT NULL,
	"target_text" text NOT NULL,
	"source_lang" varchar(20) NOT NULL,
	"target_lang" varchar(20) NOT NULL,
	"domain" varchar(50),
	"translator_id" integer,
	"quality_level" varchar(10),
	"security_level" varchar(20) DEFAULT 'restricted' NOT NULL,
	"is_anonymized" boolean DEFAULT false NOT NULL,
	"anonymized_source_text" text,
	"anonymized_target_text" text,
	"source_char_count" integer DEFAULT 0 NOT NULL,
	"target_char_count" integer DEFAULT 0 NOT NULL,
	"source_word_count" integer DEFAULT 0 NOT NULL,
	"target_word_count" integer DEFAULT 0 NOT NULL,
	"segment_index" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "translation_unit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"translation_unit_id" integer NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" integer,
	"old_value" text,
	"new_value" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "language_service_data" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_type" "language_service_type" DEFAULT 'translation' NOT NULL,
	"language_pair" text,
	"domain" text,
	"industry" text,
	"use_case" text,
	"unit_price" integer,
	"total_price" integer,
	"turnaround_time" text,
	"is_public" boolean DEFAULT true NOT NULL,
	"interpretation_type" text,
	"duration_hours" numeric(5, 1),
	"num_interpreters" integer,
	"location_type" text,
	"equipment_type" text,
	"quantity" integer,
	"rental_duration" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_insights" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_type" "language_service_type" DEFAULT 'translation' NOT NULL,
	"language_service_data_id" integer,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"short_answer" text,
	"long_answer" text,
	"question_type" text,
	"domain" text,
	"language_pair" text,
	"industry" text,
	"use_case" text,
	"source_count" integer,
	"avg_price" numeric(15, 2),
	"min_price" numeric(15, 2),
	"max_price" numeric(15, 2),
	"avg_duration" numeric(8, 2),
	"status" text DEFAULT 'draft' NOT NULL,
	"visibility_level" text DEFAULT 'internal_summary' NOT NULL,
	"confidence_score" numeric(5, 2),
	"is_public" boolean DEFAULT true NOT NULL,
	"slug" text,
	"source_type" text,
	"source_title" text,
	"source_url" text,
	"filter_score" integer,
	"filter_decision" text,
	"filter_reason" text,
	"duplicate_of_id" integer,
	"search_intent_score" integer,
	"commercial_intent_score" integer,
	"specificity_score" integer,
	"duplication_score" integer,
	"source_weight" integer,
	"aeo_title" text,
	"aeo_description" text,
	"faq_json" jsonb,
	"related_ids" integer[],
	"is_archived" boolean DEFAULT false NOT NULL,
	"merged_into_id" integer,
	"deleted_at" timestamp,
	"published_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insight_auto_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"insight_id" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insight_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"insight_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"user_id" integer,
	"session_id" text NOT NULL,
	"referrer" text,
	"device" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"token" text NOT NULL,
	"project_id" integer,
	"user_id" integer,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_customer_user_id_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_item_files" ADD CONSTRAINT "quote_item_files_quote_item_id_quote_items_id_fk" FOREIGN KEY ("quote_item_id") REFERENCES "public"."quote_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_translator_id_users_id_fk" FOREIGN KEY ("translator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_translator_id_users_id_fk" FOREIGN KEY ("translator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "divisions" ADD CONSTRAINT "divisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translator_profiles" ADD CONSTRAINT "translator_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translator_profiles" ADD CONSTRAINT "translator_profiles_affiliated_company_id_companies_id_fk" FOREIGN KEY ("affiliated_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translator_rates" ADD CONSTRAINT "translator_rates_translator_id_users_id_fk" FOREIGN KEY ("translator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translator_products" ADD CONSTRAINT "translator_products_translator_id_users_id_fk" FOREIGN KEY ("translator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translator_products" ADD CONSTRAINT "translator_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translator_sensitive" ADD CONSTRAINT "translator_sensitive_translator_id_users_id_fk" FOREIGN KEY ("translator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translator_emails" ADD CONSTRAINT "translator_emails_translator_id_users_id_fk" FOREIGN KEY ("translator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_posts" ADD CONSTRAINT "board_posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_batch_items" ADD CONSTRAINT "billing_batch_items_batch_id_billing_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."billing_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_batch_items" ADD CONSTRAINT "billing_batch_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_batch_items" ADD CONSTRAINT "billing_batch_items_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_batch_work_items" ADD CONSTRAINT "billing_batch_work_items_batch_id_billing_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."billing_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_batches" ADD CONSTRAINT "billing_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_batches" ADD CONSTRAINT "billing_batches_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepaid_accounts" ADD CONSTRAINT "prepaid_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepaid_ledger" ADD CONSTRAINT "prepaid_ledger_account_id_prepaid_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."prepaid_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepaid_ledger" ADD CONSTRAINT "prepaid_ledger_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_name_history" ADD CONSTRAINT "company_name_history_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_units" ADD CONSTRAINT "translation_units_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_units" ADD CONSTRAINT "translation_units_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_units" ADD CONSTRAINT "translation_units_translator_id_users_id_fk" FOREIGN KEY ("translator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_unit_logs" ADD CONSTRAINT "translation_unit_logs_translation_unit_id_translation_units_id_fk" FOREIGN KEY ("translation_unit_id") REFERENCES "public"."translation_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_unit_logs" ADD CONSTRAINT "translation_unit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_insights" ADD CONSTRAINT "content_insights_language_service_data_id_language_service_data_id_fk" FOREIGN KEY ("language_service_data_id") REFERENCES "public"."language_service_data"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight_auto_suggestions" ADD CONSTRAINT "insight_auto_suggestions_insight_id_content_insights_id_fk" FOREIGN KEY ("insight_id") REFERENCES "public"."content_insights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight_events" ADD CONSTRAINT "insight_events_insight_id_content_insights_id_fk" FOREIGN KEY ("insight_id") REFERENCES "public"."content_insights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tu_project_id_idx" ON "translation_units" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tu_translator_id_idx" ON "translation_units" USING btree ("translator_id");--> statement-breakpoint
CREATE INDEX "tu_domain_idx" ON "translation_units" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "tu_lang_pair_idx" ON "translation_units" USING btree ("source_lang","target_lang");--> statement-breakpoint
CREATE INDEX "tu_security_level_idx" ON "translation_units" USING btree ("security_level");--> statement-breakpoint
CREATE INDEX "tu_status_idx" ON "translation_units" USING btree ("status");