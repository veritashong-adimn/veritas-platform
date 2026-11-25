-- [읽기 전용] 적용 전·후 검증 — 같은 SQL 을 적용 직전·직후에 실행해 diff 비교. 기대: 'schema.*' 줄만 달라짐.
\set ON_ERROR_STOP on
BEGIN; SET TRANSACTION READ ONLY;
SELECT 'schema.payment_transactions.cols|' || string_agg(column_name || ':' || data_type, ',' ORDER BY column_name)
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_transactions' AND column_name IN ('payment_type', 'expected_date', 'expected_amount');
SELECT 'payment_transactions.count|' || count(*) || '|sum_paid|' || coalesce(sum(customer_paid_amount), 0) FROM payment_transactions;
SELECT 'payment_transactions.by_type|' || coalesce(string_agg(t || ':' || n || ':' || s, ',' ORDER BY t), 'none')
  FROM (SELECT coalesce(txn_type, 'null') t, count(*) n, sum(customer_paid_amount) s FROM payment_transactions GROUP BY 1) x;
SELECT 'project_payments.count|' || count(*) || '|sum_amount|' || coalesce(sum(amount), 0) FROM project_payments;
-- 청구회차별 실입금(수금관리 SSOT 규칙) 합계 — 적용 전·후 동일해야 함
SELECT 'collections.paid_total|' || coalesce(sum(CASE WHEN coalesce(tx.n, 0) > 0 THEN tx.s WHEN pp.deposit_status = 'completed' THEN pp.amount ELSE 0 END), 0)
  FROM project_payments pp LEFT JOIN (SELECT project_payment_id, count(*) n, sum(customer_paid_amount) s FROM payment_transactions GROUP BY 1) tx ON tx.project_payment_id = pp.id;
SELECT 'payment_transactions.monthly|' || coalesce(string_agg(m || ':' || s, ',' ORDER BY m), 'none')
  FROM (SELECT to_char(paid_date, 'YYYY-MM') m, sum(customer_paid_amount) s FROM payment_transactions WHERE paid_date IS NOT NULL GROUP BY 1) x;
COMMIT;
