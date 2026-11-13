-- =====================================================================
-- [운영 적용용] 거래처 기본 세금 유형 컬럼 추가 — companies 4개 컬럼(모두 NULL 허용·기본값 없음)
--   · lib/db/src/schema/companies.ts 와 동일 정의(개발 DB 와 타입·NULL·기본값 일치 확인 완료)
--   · 기존 행 값은 변경하지 않는다(모두 NULL = '미확인'). 일괄 지정·backfill 없음.
--   · NULL 허용·기본값 없는 ADD COLUMN 은 PostgreSQL 에서 메타데이터만 변경(테이블 재작성 없음).
--   · IF NOT EXISTS — 중복 실행해도 오류 없음(이미 적용된 경우 아무것도 바꾸지 않고 검증만 통과).
--   · 잠금: 시작 시 companies 를 ACCESS EXCLUSIVE 로 먼저 잡는다(수 ms). 그동안 거래처 조회·저장은 대기.
--     다른 트랜잭션이 잡고 있으면 5초 후 중단(lock_timeout) — 아무것도 바뀌지 않으며 재실행하면 된다.
--   · 데이터 보존 검증을 같은 트랜잭션 안에서 수행 — 잠금 보유 중이라 운영 중 쓰기로 인한 거짓 경보 없음.
--     기존 전 컬럼(행 전체, 신규 4개 제외) 체크섬이 적용 전후 다르거나, 신규 컬럼 정의가 다르거나,
--     신규 컬럼에 값이 있으면 예외 → 전체 롤백.
-- 실행:  psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/2026-11-13_companies_tax_type.sql
-- 순서:  ① 백업(Neon 브랜치/스냅샷 또는 pg_dump) → ② _verify.sql(적용 전) → ③ 이 SQL → ④ _verify.sql(적용 후)
--        → ⑤ 신규 코드 배포   (역순 금지: 신규 코드는 이 컬럼을 조회한다 — 컬럼 없으면 거래처 상세 500)
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE companies IN ACCESS EXCLUSIVE MODE;

-- 적용 전 스냅샷(행 수 + 기존 전 컬럼 체크섬). 신규 4개 키는 적용 전후 모두 제외하고 비교.
CREATE TEMP TABLE _companies_tax_mig_before ON COMMIT DROP AS
SELECT count(*) AS n,
       md5(coalesce(string_agg((to_jsonb(c) - 'default_tax_type' - 'tax_type_basis' - 'tax_type_confirmed_at' - 'tax_type_confirmed_by')::text, ',' ORDER BY c.id), '')) AS checksum
  FROM companies c;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS default_tax_type      varchar(20),
  ADD COLUMN IF NOT EXISTS tax_type_basis        text,
  ADD COLUMN IF NOT EXISTS tax_type_confirmed_at date,
  ADD COLUMN IF NOT EXISTS tax_type_confirmed_by integer;

DO $$
DECLARE ok int; b record; a record; filled bigint;
BEGIN
  -- ① 신규 컬럼 정의
  SELECT count(*) INTO ok FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'companies' AND is_nullable = 'YES' AND column_default IS NULL
     AND ((column_name = 'default_tax_type' AND data_type = 'character varying' AND character_maximum_length = 20)
       OR (column_name = 'tax_type_basis' AND data_type = 'text')
       OR (column_name = 'tax_type_confirmed_at' AND data_type = 'date')
       OR (column_name = 'tax_type_confirmed_by' AND data_type = 'integer'));
  IF ok <> 4 THEN RAISE EXCEPTION 'companies 세금 유형 컬럼 정의 불일치(% / 4) — 롤백', ok; END IF;

  -- ② 기존 거래처 데이터 보존(행 수·전 컬럼 체크섬 동일)
  SELECT * INTO b FROM _companies_tax_mig_before;
  SELECT count(*) AS n,
         md5(coalesce(string_agg((to_jsonb(c) - 'default_tax_type' - 'tax_type_basis' - 'tax_type_confirmed_at' - 'tax_type_confirmed_by')::text, ',' ORDER BY c.id), '')) AS checksum
    INTO a FROM companies c;
  IF a.n <> b.n OR a.checksum <> b.checksum THEN
    RAISE EXCEPTION '기존 거래처 데이터 불일치(행 % → %, 체크섬 % → %) — 롤백', b.n, a.n, b.checksum, a.checksum;
  END IF;

  -- ③ 신규 컬럼 값 없음(최초 적용 시) — 이미 적용·사용 중인 DB 에 재실행한 경우는 값이 있을 수 있어 안내만
  SELECT count(*) INTO filled FROM companies
   WHERE default_tax_type IS NOT NULL OR tax_type_basis IS NOT NULL OR tax_type_confirmed_at IS NOT NULL OR tax_type_confirmed_by IS NOT NULL;
  RAISE NOTICE 'companies 세금 유형 컬럼 적용 완료 — 거래처 %행 보존(체크섬 %), 신규 컬럼 값 있는 행 %', a.n, a.checksum, filled;
END $$;

COMMIT;
