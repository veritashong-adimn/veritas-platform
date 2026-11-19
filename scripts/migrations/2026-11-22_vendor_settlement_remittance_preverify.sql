-- =====================================================================
-- [읽기 전용 · 적용 전] 해외/국내 외주 정산유형 + 해외송금 내역 스키마 사전 점검
-- 실행:  psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/2026-11-22_vendor_settlement_remittance_preverify.sql
-- 기대:  ① 신규 컬럼 0행  ② performance_remittances = NULL  ③ 기준값(행수·체크섬·합계) 기록 → 적용 후 _postverify 결과와 동일해야 함
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN; SET TRANSACTION READ ONLY;
-- ① 신규 컬럼 존재 여부(기대: 0행 — 이미 있으면 적용 SQL 은 IF NOT EXISTS 로 건너뜀)
SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
 WHERE table_schema='public' AND ((table_name='performance_assignments' AND column_name IN ('vendor_settlement_type','contract_currency','contract_amount_foreign'))
    OR (table_name='company_vendor_profiles' AND column_name='country')) ORDER BY 1,2;
-- ② 신규 테이블 존재 여부(기대: NULL)
SELECT to_regclass('public.performance_remittances') AS performance_remittances;
-- ③ 기준값 — 기존 수행·외주프로필 데이터 체크섬(신규 컬럼 제외) · 수행/지급/정산 건수·합계
SELECT 'performance_assignments' AS tbl, count(*) AS rows,
       md5(coalesce(string_agg((to_jsonb(p) - 'vendor_settlement_type' - 'contract_currency' - 'contract_amount_foreign')::text, ',' ORDER BY p.id), '')) AS data_checksum
  FROM performance_assignments p
UNION ALL
SELECT 'company_vendor_profiles', count(*), md5(coalesce(string_agg((to_jsonb(v) - 'country')::text, ',' ORDER BY v.id), '')) FROM company_vendor_profiles v;
SELECT count(*) FILTER (WHERE deleted_at IS NULL) AS pa_live, count(*) FILTER (WHERE payment_status='paid') AS pa_paid,
       sum(cost_total) AS pa_cost_total, sum(net_payment) AS pa_net_payment, sum(total_purchase_amount) AS pa_purchase_total,
       (SELECT count(*) FROM payout_rounds) AS payout_rounds, (SELECT count(*) FROM payout_round_items) AS payout_round_items,
       (SELECT count(*) FROM payout_transfers) AS payout_transfers, (SELECT count(*) FROM settlements) AS settlements
  FROM performance_assignments;
COMMIT;
