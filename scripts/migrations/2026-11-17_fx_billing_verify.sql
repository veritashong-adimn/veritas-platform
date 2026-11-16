-- [읽기 전용] 적용 전·후 실행 — 두 결과의 rows / data_checksum 이 같아야 기존 청구·입금 데이터 무변경
--   psql "$PROD_DATABASE_URL" -f scripts/migrations/2026-11-17_fx_billing_verify.sql
BEGIN;
SET TRANSACTION READ ONLY;
SELECT 'project_payments' AS t, count(*) AS rows,
       md5(string_agg(concat_ws('|', id, project_id, sequence, amount, supply_amount, vat_amount, payment_method, deposit_status, deposit_confirmed,
                                issue_date, expected_date, paid_date, billing_company_id, billing_company_name_snapshot, updated_at), ',' ORDER BY id)) AS data_checksum
  FROM project_payments
UNION ALL
SELECT 'payment_transactions', count(*),
       md5(string_agg(concat_ws('|', id, project_payment_id, project_id, paid_date, method, customer_paid_amount, settled_amount, fee_amount,
                                currency, fx_rate, foreign_amount, krw_amount, bank_account, updated_at), ',' ORDER BY id))
  FROM payment_transactions;
SELECT table_name, column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND ((table_name = 'project_payments' AND column_name IN ('billing_currency', 'foreign_amount', 'invoice_fx_rate', 'invoice_fx_date'))
     OR (table_name = 'payment_transactions' AND column_name IN ('txn_type', 'offset_source_payment_id')))
 ORDER BY table_name, column_name;
-- 적용 직후: 신규 컬럼 값 없음(0)이어야 함(적용 전에도 오류 없이 0)
SELECT (SELECT count(*) FROM project_payments p WHERE to_jsonb(p) ->> 'billing_currency' IS NOT NULL OR to_jsonb(p) ->> 'foreign_amount' IS NOT NULL
          OR to_jsonb(p) ->> 'invoice_fx_rate' IS NOT NULL OR to_jsonb(p) ->> 'invoice_fx_date' IS NOT NULL)
     + (SELECT count(*) FROM payment_transactions t WHERE to_jsonb(t) ->> 'txn_type' IS NOT NULL OR to_jsonb(t) ->> 'offset_source_payment_id' IS NOT NULL) AS non_null_rows;
COMMIT;
