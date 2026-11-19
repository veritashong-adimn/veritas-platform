-- [복구용 — 필요 시에만, 별도 승인] 먼저 이전 버전 코드로 되돌린 뒤 실행(신규 코드는 이 테이블을 조회한다).
--   · 저장된 거래일자가 있으면 중단(사용자 확정 날짜 보호). 견적·청구 데이터는 영향 없음.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE n bigint := 0;
BEGIN
  IF to_regclass('public.transaction_statements') IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM transaction_statements' INTO n; END IF;
  IF n > 0 THEN RAISE EXCEPTION '저장된 거래명세서 거래일자 %건 존재 — 자동 복구 중단(수동 검토 필요)', n; END IF;
END $$;
DROP TABLE IF EXISTS transaction_statements;
COMMIT;
