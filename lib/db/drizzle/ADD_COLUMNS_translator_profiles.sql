-- Migration: translator_profiles 컬럼 추가 (전체 증분)
-- 적용 전 반드시 검토 후 실행
-- 1차: affiliated_company_id, settlement_type (소속업체/정산유형)
-- 2차: operational_status, operational_note, reassignment_allowed (운영관리)

ALTER TABLE "translator_profiles"
  ADD COLUMN IF NOT EXISTS "affiliated_company_id" integer
    REFERENCES "companies"("id") ON DELETE SET NULL;

ALTER TABLE "translator_profiles"
  ADD COLUMN IF NOT EXISTS "settlement_type" text;

ALTER TABLE "translator_profiles"
  ADD COLUMN IF NOT EXISTS "operational_status" text NOT NULL DEFAULT 'normal';

ALTER TABLE "translator_profiles"
  ADD COLUMN IF NOT EXISTS "operational_note" text;

ALTER TABLE "translator_profiles"
  ADD COLUMN IF NOT EXISTS "reassignment_allowed" boolean NOT NULL DEFAULT true;
