-- [읽기 전용] 적용 전·후 — rows / data_checksum 이 같아야 기존 원장 무변경 (신규 컬럼 created_by·memo 제외)
--   psql "$DATABASE_URL" -f scripts/migrations/2026-11-18_prepaid_ledger_history_verify.sql
BEGIN; SET TRANSACTION READ ONLY;
SELECT count(*) AS rows, md5(coalesce(string_agg(concat_ws('|', id, account_id, project_id, quote_id, type, status, amount, balance_before, balance_after, supply_amount, tax_amount, description, transaction_date, created_at, linked_payment_id, confirmed_by, confirmed_at), ',' ORDER BY id), '')) AS data_checksum FROM prepaid_ledger;
SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='prepaid_ledger' AND column_name IN ('created_by','memo') ORDER BY 1;
SELECT to_regclass('public.prepaid_ledger_history') AS history_table;
COMMIT;
