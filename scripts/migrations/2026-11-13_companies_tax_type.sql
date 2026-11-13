-- =====================================================================
-- [운영 적용용] 거래처 기본 세금 유형 컬럼 추가 — companies 4개 컬럼(모두 NULL 허용·기본값 없음)
--   · lib/db/src/schema/companies.ts 와 동일 정의(개발 DB 와 타입·NULL·기본값 일치 확인 완료)
--   · 기존 행 값은 변경하지 않는다(모두 NULL = '미확인'). 일괄 지정·backfill 없음.
--   · NULL 허용·기본값 없는 ADD COLUMN 은 PostgreSQL 에서 메타데이터만 변경(테이블 재작성 없음).
--   · IF NOT EXISTS — 중복 실행해도 오류 없음.
--   · lock_timeout — 다른 트랜잭션이 테이블을 잡고 있으면 5초 후 중단(서비스 대기 방지). 실패 시 재실행하면 된다.
-- 실행:  psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/2026-11-13_companies_tax_type.sql
-- 순서:  ① 이 SQL 적용 → ② 검증 쿼리(_verify.sql) → ③ 신규 코드 배포  (역순 금지: 신규 코드는 이 컬럼을 조회한다)
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_tax_type      varchar(20);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_type_basis        text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_type_confirmed_at date;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_type_confirmed_by integer;

-- 적용 확인: 4개 컬럼 정의가 기대와 다르면 전체 롤백
DO $$
DECLARE ok int;
BEGIN
  SELECT count(*) INTO ok FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'companies' AND is_nullable = 'YES' AND column_default IS NULL
     AND ((column_name = 'default_tax_type' AND data_type = 'character varying' AND character_maximum_length = 20)
       OR (column_name = 'tax_type_basis' AND data_type = 'text')
       OR (column_name = 'tax_type_confirmed_at' AND data_type = 'date')
       OR (column_name = 'tax_type_confirmed_by' AND data_type = 'integer'));
  IF ok <> 4 THEN RAISE EXCEPTION 'companies 세금 유형 컬럼 정의 불일치(% / 4) — 롤백', ok; END IF;
END $$;

COMMIT;
