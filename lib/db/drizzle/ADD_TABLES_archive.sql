-- 회사 자료보관함 신규 테이블 7개 (기존 테이블 변경 없음). 생성: drizzle-kit generate (schema/archive.ts)
-- 운영 적용은 별도 승인 후. 트랜잭션으로 실행할 것.
BEGIN;
CREATE TABLE "archive_acl" (
	"id" serial PRIMARY KEY NOT NULL,
	"folder_id" integer,
	"document_id" integer,
	"subject_type" varchar(20) NOT NULL,
	"subject_id" integer,
	"subject_value" text,
	"effect" varchar(10) DEFAULT 'allow' NOT NULL,
	"actions" jsonb NOT NULL,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "archive_approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"version_id" integer,
	"request_type" varchar(30) NOT NULL,
	"payload" jsonb,
	"reason" text,
	"is_ai_authored" boolean DEFAULT false NOT NULL,
	"requested_by" integer,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"decided_by" integer,
	"decided_at" timestamp,
	"decision_note" text
);

CREATE TABLE "archive_audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer,
	"folder_id" integer,
	"version_id" integer,
	"action" varchar(40) NOT NULL,
	"user_id" integer,
	"user_email" text,
	"actor_type" varchar(10) DEFAULT 'user' NOT NULL,
	"metadata" jsonb,
	"ip" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "archive_document_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"version_no" integer NOT NULL,
	"storage_key" text NOT NULL,
	"original_file_name" text NOT NULL,
	"mime_type" text,
	"file_size" integer,
	"sha256" varchar(64),
	"extracted_text" text,
	"extract_method" varchar(40),
	"change_reason" text,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"approved_by" integer,
	"approved_at" timestamp
);

CREATE TABLE "archive_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"folder_id" integer NOT NULL,
	"title" text NOT NULL,
	"doc_type" varchar(30) DEFAULT 'general' NOT NULL,
	"template_document_id" integer,
	"is_standard_form" boolean DEFAULT false NOT NULL,
	"description" text,
	"keywords" text,
	"author_name" text,
	"owner_department" text,
	"document_date" date,
	"security_level" varchar(20) DEFAULT 'restricted' NOT NULL,
	"ai_allowed" boolean DEFAULT false NOT NULL,
	"retention_until" date,
	"expires_at" date,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"current_version_id" integer,
	"approved_version_id" integer,
	"ai_status" varchar(20) DEFAULT 'none' NOT NULL,
	"ai_summary" text,
	"created_by" integer,
	"updated_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"deleted_by" integer,
	"deletion_reason" text
);

CREATE TABLE "archive_folders" (
	"id" serial PRIMARY KEY NOT NULL,
	"parent_id" integer,
	"name" varchar(200) NOT NULL,
	"description" text,
	"menu_key" varchar(30),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "archive_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"entity_type" varchar(30) NOT NULL,
	"entity_id" integer NOT NULL,
	"note" text,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "archive_acl" ADD CONSTRAINT "archive_acl_folder_id_archive_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."archive_folders"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "archive_acl" ADD CONSTRAINT "archive_acl_document_id_archive_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."archive_documents"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "archive_acl" ADD CONSTRAINT "archive_acl_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "archive_approvals" ADD CONSTRAINT "archive_approvals_document_id_archive_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."archive_documents"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "archive_approvals" ADD CONSTRAINT "archive_approvals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "archive_approvals" ADD CONSTRAINT "archive_approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "archive_document_versions" ADD CONSTRAINT "archive_document_versions_document_id_archive_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."archive_documents"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "archive_document_versions" ADD CONSTRAINT "archive_document_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "archive_document_versions" ADD CONSTRAINT "archive_document_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "archive_documents" ADD CONSTRAINT "archive_documents_folder_id_archive_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."archive_folders"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "archive_documents" ADD CONSTRAINT "archive_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "archive_documents" ADD CONSTRAINT "archive_documents_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "archive_folders" ADD CONSTRAINT "archive_folders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "archive_links" ADD CONSTRAINT "archive_links_document_id_archive_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."archive_documents"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "archive_links" ADD CONSTRAINT "archive_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "archive_acl_folder_idx" ON "archive_acl" USING btree ("folder_id");
CREATE INDEX "archive_acl_document_idx" ON "archive_acl" USING btree ("document_id");
CREATE INDEX "archive_approvals_status_idx" ON "archive_approvals" USING btree ("status");
CREATE INDEX "archive_approvals_document_idx" ON "archive_approvals" USING btree ("document_id");
CREATE INDEX "archive_audit_document_idx" ON "archive_audit_logs" USING btree ("document_id");
CREATE INDEX "archive_audit_created_idx" ON "archive_audit_logs" USING btree ("created_at");
CREATE INDEX "archive_versions_document_idx" ON "archive_document_versions" USING btree ("document_id");
CREATE INDEX "archive_versions_sha_idx" ON "archive_document_versions" USING btree ("sha256");
CREATE INDEX "archive_documents_folder_idx" ON "archive_documents" USING btree ("folder_id");
CREATE INDEX "archive_documents_status_idx" ON "archive_documents" USING btree ("status");
CREATE INDEX "archive_folders_parent_idx" ON "archive_folders" USING btree ("parent_id");
CREATE UNIQUE INDEX "archive_links_uniq" ON "archive_links" USING btree ("document_id","entity_type","entity_id");
CREATE INDEX "archive_links_entity_idx" ON "archive_links" USING btree ("entity_type","entity_id");
COMMIT;
