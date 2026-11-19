-- =====================================================================
-- [복구용 — 필요 시에만, 별도 승인] 먼저 이전 버전 코드로 되돌린 뒤 실행(신규 코드는 이 컬럼·테이블을 조회한다).
--   · 송금내역(performance_remittances)·정산유형 값이 하나라도 입력됐으면 중단한다(금융 이력 보호).
--     이미 입력된 경우: 이 스크립트 대신 백업(veritas-production-backup-20261119-191439KST) 기준 수동 검토 후 처리.
--   · 기존 수행·지급·정산 데이터(신규 컬럼 외)는 영향 없음.
-- 실행:  psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/2026-11-22_vendor_settlement_remittance_rollback.sql
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE n bigint := 0; m bigint := 0;
BEGIN
  IF to_regclass('public.performance_remittances') IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM performance_remittances' INTO n; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='performance_assignments' AND column_name='vendor_settlement_type') THEN
    EXECUTE 'SELECT count(*) FROM performance_assignments WHERE vendor_settlement_type IS NOT NULL OR contract_currency IS NOT NULL OR contract_amount_foreign IS NOT NULL' INTO m;
  END IF;
  IF n > 0 OR m > 0 THEN RAISE EXCEPTION '송금내역 %건·정산유형 입력 %행 존재 — 자동 복구 중단(수동 검토 필요)', n, m; END IF;
END $$;
DROP TABLE IF EXISTS performance_remittances;
ALTER TABLE company_vendor_profiles DROP COLUMN IF EXISTS country;
ALTER TABLE performance_assignments
  DROP COLUMN IF EXISTS contract_amount_foreign,
  DROP COLUMN IF EXISTS contract_currency,
  DROP COLUMN IF EXISTS vendor_settlement_type;
COMMIT;
