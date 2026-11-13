-- [읽기 전용] 적용 전·후 실행 — 두 결과의 rows / data_checksum 이 같아야 기존 거래처 데이터 무변경
--   psql "$PROD_DATABASE_URL" -f scripts/migrations/2026-11-13_companies_tax_type_verify.sql
BEGIN;
SET TRANSACTION READ ONLY;
SELECT count(*) AS rows,
       md5(string_agg(concat_ws('|', id, name, business_number, company_type, customer_type, notes, updated_at, deleted_at), ',' ORDER BY id)) AS data_checksum
  FROM companies;
SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'companies'
   AND column_name IN ('default_tax_type', 'tax_type_basis', 'tax_type_confirmed_at', 'tax_type_confirmed_by')
 ORDER BY column_name;
-- 적용 직후: 4개 컬럼 모두 값 없음(NULL) 이어야 함 — 일괄 지정 없음 확인(적용 전에도 오류 없이 0)
SELECT count(*) FILTER (WHERE to_jsonb(c) ->> 'default_tax_type' IS NOT NULL OR to_jsonb(c) ->> 'tax_type_basis' IS NOT NULL
                          OR to_jsonb(c) ->> 'tax_type_confirmed_at' IS NOT NULL OR to_jsonb(c) ->> 'tax_type_confirmed_by' IS NOT NULL) AS non_null_rows
  FROM companies c;
COMMIT;
