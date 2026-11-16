-- [읽기 전용] 적용 전·후 실행 — 남은 문구 건수, 비고 외 전 컬럼 체크섬(전후 동일해야 함)
--   psql "$PROD_DATABASE_URL" -f scripts/migrations/2026-11-19_legacy_payout_review_remark_cleanup_verify.sql
BEGIN; SET TRANSACTION READ ONLY;
SELECT count(*) FILTER (WHERE remark LIKE '%[과거 CRM] 과거 지급 확인 필요%') AS phrase_rows,
       count(*) AS total_rows,
       md5(coalesce(string_agg((to_jsonb(pa) - 'remark')::text, ',' ORDER BY pa.id), '')) AS non_remark_checksum
  FROM performance_assignments pa;
SELECT count(*) AS backup_rows FROM pg_class WHERE relname = '_bak_perf_remark_20261119';
COMMIT;
