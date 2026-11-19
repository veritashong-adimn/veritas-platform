-- [읽기 전용] 적용 전·후 — 견적·청구 rows/checksum 이 같아야 기존 데이터 무변경. 적용 후 transaction_statements 존재·0행(배포 전).
\set ON_ERROR_STOP on
BEGIN; SET TRANSACTION READ ONLY;
SELECT to_regclass('public.transaction_statements') AS transaction_statements;
SELECT 'quotes' AS tbl, count(*) AS rows, md5(coalesce(string_agg(to_jsonb(q)::text, ',' ORDER BY q.id), '')) AS data_checksum FROM quotes q
UNION ALL
SELECT 'project_payments', count(*), md5(coalesce(string_agg(to_jsonb(p)::text, ',' ORDER BY p.id), '')) FROM project_payments p;
SELECT conname, confdeltype FROM pg_constraint WHERE conrelid = to_regclass('public.transaction_statements') AND contype IN ('f','u') ORDER BY 1;
COMMIT;
