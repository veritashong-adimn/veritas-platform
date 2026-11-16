-- [읽기 전용] 적용 전·후 — 자동 문구가 있는 행 수(적용 후 0), 비고 외 전 컬럼 체크섬(전후 동일), 백업 표 존재 여부
--   psql "$PROD_DATABASE_URL" -f scripts/migrations/2026-11-20_legacy_auto_remark_cleanup_verify.sql
BEGIN; SET TRANSACTION READ ONLY;
SELECT count(*) FILTER (WHERE remark ~ '\[과거 CRM\]|\(Master 미연결\)|과거 지급 확인: (지급완료|미지급) 확인\(') AS auto_text_rows,
       count(*) AS total_rows,
       md5(coalesce(string_agg((to_jsonb(pa) - 'remark')::text, ',' ORDER BY pa.id), '')) AS non_remark_checksum
  FROM performance_assignments pa;
SELECT count(*) AS backup_table_exists FROM pg_class WHERE relname = '_bak_perf_remark_20261120';
COMMIT;
