-- =====================================================================
-- [읽기 전용 · 적용 후] 기대값 자동 점검(불일치 시 ERROR) + 기준값 재출력(_preverify 결과와 동일해야 함)
-- 실행:  psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/2026-11-22_vendor_settlement_remittance_postverify.sql
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN; SET TRANSACTION READ ONLY;
DO $$
DECLARE c int; n bigint;
BEGIN
  SELECT count(*) INTO c FROM information_schema.columns WHERE table_schema='public'
     AND ((table_name='performance_assignments' AND column_name IN ('vendor_settlement_type','contract_currency','contract_amount_foreign'))
       OR (table_name='company_vendor_profiles' AND column_name='country'));
  IF c <> 4 THEN RAISE EXCEPTION '신규 컬럼 %/4', c; END IF;
  IF to_regclass('public.performance_remittances') IS NULL THEN RAISE EXCEPTION 'performance_remittances 없음'; END IF;
  IF to_regclass('public.idx_performance_remittances_assignment') IS NULL THEN RAISE EXCEPTION '인덱스 없음'; END IF;
  SELECT count(*) INTO c FROM pg_constraint WHERE conrelid='public.performance_remittances'::regclass AND contype='f';
  IF c <> 4 THEN RAISE EXCEPTION 'performance_remittances FK %/4', c; END IF;
  -- 배포 전 시점 기대값: 신규 컬럼 전부 NULL · 송금내역 0건(배포 후 신규 입력이 생기면 이 두 항목은 0이 아니어도 정상)
  SELECT count(*) INTO n FROM performance_assignments WHERE vendor_settlement_type IS NOT NULL OR contract_currency IS NOT NULL OR contract_amount_foreign IS NOT NULL;
  RAISE NOTICE '신규 컬럼 값 있는 수행행: % (배포 전 기대 0)', n;
  SELECT count(*) INTO n FROM company_vendor_profiles WHERE country IS NOT NULL;
  RAISE NOTICE '국가 입력된 외주프로필: % (배포 전 기대 0)', n;
  SELECT count(*) INTO n FROM performance_remittances;
  RAISE NOTICE '송금내역: % (배포 전 기대 0)', n;
  RAISE NOTICE '구조 점검 통과';
END $$;
-- 기준값(_preverify ③ 와 동일해야 기존 데이터 무변경)
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
