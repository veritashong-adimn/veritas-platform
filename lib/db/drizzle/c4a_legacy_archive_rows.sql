-- C-4A Legacy CRM Archive Lite — targeted additive migration (hand-authored, reviewed).
-- 안전원칙(§14): 기존 테이블 ALTER/DROP 없음. 신규 테이블 CREATE + 신규 INDEX + import_batches 참조 FK(inline)만.
-- import_batches 는 참조만 하고 수정하지 않는다.

CREATE TABLE IF NOT EXISTS "legacy_archive_rows" (
  "id"                serial PRIMARY KEY NOT NULL,
  "source_type"       varchar(20) NOT NULL,
  "source_system"     varchar(40) DEFAULT 'old_crm' NOT NULL,
  "import_batch_id"   integer REFERENCES "import_batches"("id") ON DELETE set null,
  "source_file"       text,
  "source_sheet"      text,
  "source_row"        integer,
  "record_date"       date,
  "company_name"      text,
  "contact_name"      text,
  "translator_name"   text,
  "product_name"      text,
  "language"          text,
  "supply_amount"     numeric,
  "vat_amount"        numeric,
  "total_amount"      numeric,
  "payout_pretax"     numeric,
  "delivery_date"     date,
  "payout_date"       date,
  "collection_date"   date,
  "collection_status" varchar(20),
  "source_raw"        jsonb NOT NULL,
  "row_hash"          text NOT NULL,
  "created_at"        timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_legacy_archive_rows_row_hash"      ON "legacy_archive_rows" ("row_hash");
CREATE INDEX        IF NOT EXISTS "idx_legacy_archive_rows_source_type"  ON "legacy_archive_rows" ("source_type");
CREATE INDEX        IF NOT EXISTS "idx_legacy_archive_rows_record_date"  ON "legacy_archive_rows" ("record_date");
CREATE INDEX        IF NOT EXISTS "idx_legacy_archive_rows_company_name" ON "legacy_archive_rows" ("company_name");
