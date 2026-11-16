-- =====================================================================
-- [운영 적용용 — 별도 승인 후 실행] 선입금 원장 수정 이력 + 등록자
--   선행: 2026-11-17_prepaid_ledger_link.sql
--   + prepaid_ledger.created_by integer (NULL 허용 — 기존 행 NULL)
--   + prepaid_ledger.memo text (비고 — NULL 허용 — 기존 행 NULL)
--   + prepaid_ledger_history (원장 행 변경 전·후·사유·수정자·시각) — 신규 테이블, 기존 데이터 변경 없음
-- 실행:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/2026-11-18_prepaid_ledger_history.sql
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 선행 마이그레이션(2026-11-17_prepaid_ledger_link) 적용 확인 — 미적용이면 잠금·변경 없이 즉시 중단(전체 롤백)
DO $$
DECLARE cols int; fk int; idx int;
BEGIN
  SELECT count(*) INTO cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'prepaid_ledger' AND column_name IN ('linked_payment_id', 'confirmed_by', 'confirmed_at');
  SELECT count(*) INTO fk FROM pg_constraint WHERE conname = 'prepaid_ledger_linked_payment_id_project_payments_id_fk';
  SELECT count(*) INTO idx FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'prepaid_ledger' AND indexname IN ('uq_prepaid_ledger_linked_payment', 'uq_prepaid_ledger_quote_deduction');
  IF cols <> 3 OR fk <> 1 OR idx <> 2 THEN
    RAISE EXCEPTION '선행 마이그레이션 2026-11-17_prepaid_ledger_link.sql 미적용(컬럼 %/3 · FK %/1 · 인덱스 %/2) — 먼저 적용하세요. 아무것도 변경하지 않았습니다.', cols, fk, idx;
  END IF;
END $$;

LOCK TABLE prepaid_ledger IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE _plh_before ON COMMIT DROP AS
SELECT count(*) AS n, md5(coalesce(string_agg((to_jsonb(l) - 'created_by' - 'memo')::text, ',' ORDER BY l.id), '')) AS h FROM prepaid_ledger l;

ALTER TABLE prepaid_ledger ADD COLUMN IF NOT EXISTS created_by integer;
ALTER TABLE prepaid_ledger ADD COLUMN IF NOT EXISTS memo text;

CREATE TABLE IF NOT EXISTS prepaid_ledger_history (
  id serial PRIMARY KEY,
  ledger_id integer NOT NULL,
  account_id integer NOT NULL,
  action varchar(30) NOT NULL,
  before jsonb,
  after jsonb,
  reason text,
  changed_by integer,
  changed_by_email text,
  changed_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prepaid_ledger_history_ledger ON prepaid_ledger_history (ledger_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_prepaid_ledger_history_account ON prepaid_ledger_history (account_id, changed_at);

DO $$
DECLARE b record; a record;
BEGIN
  SELECT * INTO b FROM _plh_before;
  SELECT count(*) AS n, md5(coalesce(string_agg((to_jsonb(l) - 'created_by' - 'memo')::text, ',' ORDER BY l.id), '')) AS h INTO a FROM prepaid_ledger l;
  IF b.n <> a.n OR b.h <> a.h THEN RAISE EXCEPTION '기존 원장 데이터 변경 감지 — 롤백'; END IF;
  IF EXISTS (SELECT 1 FROM prepaid_ledger WHERE created_by IS NOT NULL OR memo IS NOT NULL) THEN RAISE EXCEPTION '신규 컬럼에 값 존재 — 일괄 지정 금지'; END IF;
END $$;
COMMIT;
