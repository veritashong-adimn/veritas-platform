-- =====================================================================
-- [운영 적용용 — 별도 승인 후 실행] 외화 청구·수금 컬럼 추가
--   project_payments    + billing_currency varchar(3) · foreign_amount numeric(14,2) · invoice_fx_rate numeric(18,6) · invoice_fx_date date
--   payment_transactions + txn_type varchar(20) · offset_source_payment_id integer → project_payments(id) ON DELETE SET NULL
--   · lib/db/src/schema/project_payments.ts · payment_transactions.ts 와 동일 정의(모두 NULL 허용·기본값 없음).
--   · 기존 행 값은 변경하지 않는다(모두 NULL = 원화 청구·실제 입금 — 기존 동작 그대로). backfill·환산 없음.
--   · NULL 허용·기본값 없는 ADD COLUMN 은 메타데이터만 변경(테이블 재작성 없음). FK 는 신규 NULL 컬럼이라 즉시 검증.
--   · IF NOT EXISTS — 중복 실행해도 오류 없음.
--   · 잠금: 두 테이블을 ACCESS EXCLUSIVE 로 잡는다(수 ms). 다른 트랜잭션이 잡고 있으면 5초 후 중단 — 아무것도 바뀌지 않음.
--   · 같은 트랜잭션 안에서 기존 데이터 체크섬(신규 컬럼 제외) 전후 비교 → 다르면 예외·전체 롤백.
-- 실행:  psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/2026-11-17_fx_billing.sql
-- 순서:  ① 백업(Neon 브랜치/스냅샷 또는 pg_dump) → ② _verify.sql(적용 전) → ③ 이 SQL → ④ _verify.sql(적용 후)
--        → ⑤ 신규 코드 배포   (역순 금지: 신규 코드는 이 컬럼을 조회한다 — 컬럼 없으면 판매상세·수금관리 500)
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE project_payments, payment_transactions IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE _fx_mig_before ON COMMIT DROP AS
SELECT (SELECT count(*) FROM project_payments) AS pp_n,
       (SELECT md5(coalesce(string_agg((to_jsonb(p) - 'billing_currency' - 'foreign_amount' - 'invoice_fx_rate' - 'invoice_fx_date')::text, ',' ORDER BY p.id), '')) FROM project_payments p) AS pp_sum,
       (SELECT count(*) FROM payment_transactions) AS pt_n,
       (SELECT md5(coalesce(string_agg((to_jsonb(t) - 'txn_type' - 'offset_source_payment_id')::text, ',' ORDER BY t.id), '')) FROM payment_transactions t) AS pt_sum;

ALTER TABLE project_payments
  ADD COLUMN IF NOT EXISTS billing_currency varchar(3),
  ADD COLUMN IF NOT EXISTS foreign_amount   numeric(14,2),
  ADD COLUMN IF NOT EXISTS invoice_fx_rate  numeric(18,6),
  ADD COLUMN IF NOT EXISTS invoice_fx_date  date;

ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS txn_type varchar(20),
  ADD COLUMN IF NOT EXISTS offset_source_payment_id integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_transactions_offset_source_payment_id_project_payments_id_fk') THEN
    ALTER TABLE payment_transactions
      ADD CONSTRAINT payment_transactions_offset_source_payment_id_project_payments_id_fk
      FOREIGN KEY (offset_source_payment_id) REFERENCES project_payments(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
DECLARE b record; a record; ok int; filled bigint;
BEGIN
  SELECT count(*) INTO ok FROM information_schema.columns
   WHERE table_schema = 'public' AND is_nullable = 'YES' AND column_default IS NULL
     AND ((table_name = 'project_payments' AND column_name IN ('billing_currency', 'foreign_amount', 'invoice_fx_rate', 'invoice_fx_date'))
       OR (table_name = 'payment_transactions' AND column_name IN ('txn_type', 'offset_source_payment_id')));
  IF ok <> 6 THEN RAISE EXCEPTION '신규 컬럼 정의 불일치(%/6)', ok; END IF;

  SELECT * INTO b FROM _fx_mig_before;
  SELECT (SELECT count(*) FROM project_payments) AS pp_n,
         (SELECT md5(coalesce(string_agg((to_jsonb(p) - 'billing_currency' - 'foreign_amount' - 'invoice_fx_rate' - 'invoice_fx_date')::text, ',' ORDER BY p.id), '')) FROM project_payments p) AS pp_sum,
         (SELECT count(*) FROM payment_transactions) AS pt_n,
         (SELECT md5(coalesce(string_agg((to_jsonb(t) - 'txn_type' - 'offset_source_payment_id')::text, ',' ORDER BY t.id), '')) FROM payment_transactions t) AS pt_sum
    INTO a;
  IF b.pp_n <> a.pp_n OR b.pp_sum <> a.pp_sum OR b.pt_n <> a.pt_n OR b.pt_sum <> a.pt_sum THEN
    RAISE EXCEPTION '기존 청구·입금 데이터 변경 감지 — 롤백';
  END IF;

  SELECT (SELECT count(*) FROM project_payments WHERE billing_currency IS NOT NULL OR foreign_amount IS NOT NULL OR invoice_fx_rate IS NOT NULL OR invoice_fx_date IS NOT NULL)
       + (SELECT count(*) FROM payment_transactions WHERE txn_type IS NOT NULL OR offset_source_payment_id IS NOT NULL) INTO filled;
  IF filled <> 0 THEN RAISE EXCEPTION '신규 컬럼에 값 존재(%) — 일괄 지정 금지', filled; END IF;
END $$;

COMMIT;
