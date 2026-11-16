-- =====================================================================
-- [운영 적용용 — 별도 승인 후 실행] 선입금 원장 ↔ 판매관리 입금완료 기록 연결
--   prepaid_ledger + linked_payment_id integer → project_payments(id) ON DELETE RESTRICT (기존 입금 연결)
--                  + confirmed_by integer · confirmed_at timestamp (확정 처리자·시각)
--   부분 유니크 인덱스
--     uq_prepaid_ledger_linked_payment : 같은 청구회차는 활성(reserved/confirmed) 원장 행 하나에만 연결
--     uq_prepaid_ledger_quote_deduction: 견적당 활성 차감 1건(재시도·중복 클릭·동시 요청 이중 차감 방지)
--   · 모두 NULL 허용·기본값 없음 — 기존 행 값 변경 없음(backfill 없음). IF NOT EXISTS — 재실행 안전.
--   · 인덱스 생성 전 기존 데이터가 조건을 어기면 예외로 전체 롤백(데이터를 고치지 않는다).
-- 실행:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/2026-11-17_prepaid_ledger_link.sql
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE prepaid_ledger IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE _pl_before ON COMMIT DROP AS
SELECT count(*) AS n,
       md5(coalesce(string_agg((to_jsonb(l) - 'linked_payment_id' - 'confirmed_by' - 'confirmed_at')::text, ',' ORDER BY l.id), '')) AS h
  FROM prepaid_ledger l;

ALTER TABLE prepaid_ledger
  ADD COLUMN IF NOT EXISTS linked_payment_id integer,
  ADD COLUMN IF NOT EXISTS confirmed_by integer,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamp;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prepaid_ledger_linked_payment_id_project_payments_id_fk') THEN
    ALTER TABLE prepaid_ledger ADD CONSTRAINT prepaid_ledger_linked_payment_id_project_payments_id_fk
      FOREIGN KEY (linked_payment_id) REFERENCES project_payments(id) ON DELETE RESTRICT;
  END IF;
  -- 기존 데이터 사전 점검: 견적당 활성 차감이 2건 이상이면 인덱스를 만들지 않고 중단
  IF EXISTS (SELECT 1 FROM prepaid_ledger WHERE type = 'deduction' AND status IN ('reserved','confirmed') AND quote_id IS NOT NULL
             GROUP BY quote_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '견적당 활성 차감이 2건 이상인 데이터가 있습니다 — 인덱스 생성 전 확인 필요(자동 보정 안 함)';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_prepaid_ledger_linked_payment
  ON prepaid_ledger (linked_payment_id) WHERE linked_payment_id IS NOT NULL AND status IN ('reserved','confirmed');
CREATE UNIQUE INDEX IF NOT EXISTS uq_prepaid_ledger_quote_deduction
  ON prepaid_ledger (quote_id) WHERE type = 'deduction' AND status IN ('reserved','confirmed') AND quote_id IS NOT NULL;

DO $$
DECLARE b record; a record; c int;
BEGIN
  SELECT count(*) INTO c FROM information_schema.columns WHERE table_schema='public' AND table_name='prepaid_ledger'
     AND column_name IN ('linked_payment_id','confirmed_by','confirmed_at') AND is_nullable='YES' AND column_default IS NULL;
  IF c <> 3 THEN RAISE EXCEPTION '신규 컬럼 정의 불일치(%/3)', c; END IF;
  SELECT * INTO b FROM _pl_before;
  SELECT count(*) AS n, md5(coalesce(string_agg((to_jsonb(l) - 'linked_payment_id' - 'confirmed_by' - 'confirmed_at')::text, ',' ORDER BY l.id), '')) AS h INTO a FROM prepaid_ledger l;
  IF b.n <> a.n OR b.h <> a.h THEN RAISE EXCEPTION '기존 원장 데이터 변경 감지 — 롤백'; END IF;
  IF EXISTS (SELECT 1 FROM prepaid_ledger WHERE linked_payment_id IS NOT NULL OR confirmed_by IS NOT NULL OR confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION '신규 컬럼에 값 존재 — 일괄 지정 금지';
  END IF;
END $$;
COMMIT;
