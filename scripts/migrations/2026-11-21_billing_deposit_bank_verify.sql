-- [읽기 전용] 적용 전·후 — rows / data_checksum(신규 2칸 제외)이 같아야 기존 청구정보 무변경
BEGIN; SET TRANSACTION READ ONLY;
SELECT count(*) AS rows, md5(coalesce(string_agg((to_jsonb(p) - 'deposit_bank' - 'deposit_bank_confirmed')::text, ',' ORDER BY p.id), '')) AS data_checksum FROM project_payments p;
SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
 WHERE table_name = 'project_payments' AND column_name IN ('deposit_bank', 'deposit_bank_confirmed') ORDER BY 1;
COMMIT;
