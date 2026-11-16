-- =====================================================================
-- [운영 적용용 — 별도 승인 후 실행] 청구정보 입금은행·은행 확인 칸 추가
--   project_payments + deposit_bank text (NULL 허용, 기본값 없음 — 기존 행 NULL: 화면은 최근 입금거래 은행 표시)
--                    + deposit_bank_confirmed boolean NOT NULL DEFAULT false (기존 행 false = 미확인)
--   · lib/db/src/schema/project_payments.ts 와 동일 정의. 기존 행의 다른 값은 변경하지 않는다(입금액·입금일·입금상태·수금 기록 불변).
--   · PostgreSQL 11+ 에서 상수 DEFAULT 가 있는 ADD COLUMN 도 메타데이터만 변경(테이블 재작성 없음).
--   · IF NOT EXISTS — 재실행 안전. 같은 트랜잭션에서 기존 전 컬럼 체크섬(신규 2개 제외) 전후 비교 → 다르면 롤백.
-- 실행:  psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/2026-11-21_billing_deposit_bank.sql
-- 순서:  ① 백업 → ② _verify.sql(적용 전) → ③ 이 SQL → ④ _verify.sql(적용 후) → ⑤ 신규 코드 배포
--        (역순 금지: 신규 코드는 이 컬럼을 조회한다 — 없으면 판매상세 청구정보 조회 오류)
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE project_payments IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE _pp_bank_before ON COMMIT DROP AS
SELECT count(*) AS n, md5(coalesce(string_agg((to_jsonb(p) - 'deposit_bank' - 'deposit_bank_confirmed')::text, ',' ORDER BY p.id), '')) AS h FROM project_payments p;

ALTER TABLE project_payments
  ADD COLUMN IF NOT EXISTS deposit_bank text,
  ADD COLUMN IF NOT EXISTS deposit_bank_confirmed boolean NOT NULL DEFAULT false;

DO $$
DECLARE b record; a record; c int;
BEGIN
  SELECT count(*) INTO c FROM information_schema.columns WHERE table_schema='public' AND table_name='project_payments'
     AND ((column_name='deposit_bank' AND data_type='text' AND is_nullable='YES' AND column_default IS NULL)
       OR (column_name='deposit_bank_confirmed' AND data_type='boolean' AND is_nullable='NO' AND column_default='false'));
  IF c <> 2 THEN RAISE EXCEPTION '신규 컬럼 정의 불일치(%/2) — 롤백', c; END IF;
  SELECT * INTO b FROM _pp_bank_before;
  SELECT count(*) AS n, md5(coalesce(string_agg((to_jsonb(p) - 'deposit_bank' - 'deposit_bank_confirmed')::text, ',' ORDER BY p.id), '')) AS h INTO a FROM project_payments p;
  IF a.n <> b.n OR a.h <> b.h THEN RAISE EXCEPTION '기존 청구정보 데이터 변경 감지 — 롤백'; END IF;
  RAISE NOTICE '청구정보 입금은행 칸 추가 완료 — 기존 %행 보존', a.n;
END $$;
COMMIT;
