-- [읽기 전용] payout_adjustments 운영 적용 전·후 검증 — 같은 SQL 을 적용 직전·직후에 실행해 출력(diff)을 비교한다.
-- 실행:  psql "$PROD_DATABASE_URL" -Atq -v ON_ERROR_STOP=1 -f lib/db/sql/2026-11-payout-adjustments-verify.sql > verify_before.txt
--        (up.sql 적용 후) ... > verify_after.txt ;  diff verify_before.txt verify_after.txt
-- 기대 결과: 'schema.*' 와 'new.*' 줄만 달라지고(테이블·컬럼 생성, 신규 0건), 그 외 기존 지급·금융 지표는 전부 동일.
--   · payout_round_items 체크섬은 신규 컬럼 adjustment_id 를 제외하고 계산(컬럼 추가만으로 값이 바뀌지 않게).
--   · 운영 사용 중 사용자가 수행정보를 수정하면 performance.* 가 달라질 수 있으므로 적용 직전·직후에 연속 실행한다.
\set ON_ERROR_STOP on
BEGIN; SET TRANSACTION READ ONLY;

-- ── 스키마 존재 여부 ─────────────────────────────────────────────────────────
SELECT 'schema.payout_adjustments_table|' || coalesce(to_regclass('public.payout_adjustments')::text, 'absent');
SELECT 'schema.payout_round_items.adjustment_id|' || CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'payout_round_items' AND column_name = 'adjustment_id') THEN 'present' ELSE 'absent' END;
SELECT 'schema.constraints|' || coalesce(string_agg(conname || ':' || contype::text || ':' || confdeltype::text, ',' ORDER BY conname), 'none')
  FROM pg_constraint WHERE conrelid = to_regclass('public.payout_adjustments');
SELECT 'schema.indexes|' || coalesce(string_agg(indexname, ',' ORDER BY indexname), 'none')
  FROM pg_indexes WHERE schemaname = 'public' AND (tablename = 'payout_adjustments' OR indexname = 'uq_payout_round_items_adjustment');

-- ── 지급회차 ────────────────────────────────────────────────────────────────
SELECT 'payout_rounds.count|' || count(*) FROM payout_rounds;
SELECT 'payout_rounds.by_status|' || coalesce(string_agg(status || '=' || n, ',' ORDER BY status), 'none')
  FROM (SELECT status::text, count(*) n FROM payout_rounds GROUP BY 1) x;
SELECT 'payout_rounds.checksum|' || md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id), '')) FROM payout_rounds r;

-- ── 수행정보 지급 상태·금액(지급 관련 컬럼만) ─────────────────────────────────
SELECT 'performance.count|' || count(*) FROM performance_assignments;
SELECT 'performance.paid_count|' || count(*) FROM performance_assignments WHERE payment_status = 'paid';
SELECT 'performance.paid_cost_total|' || coalesce(sum(cost_total), 0) FROM performance_assignments WHERE payment_status = 'paid';
SELECT 'performance.cost_total_sum|' || coalesce(sum(cost_total), 0) || '|withholding_sum|' || coalesce(sum(withholding_tax), 0)
  || '|net_sum|' || coalesce(sum(net_payment), 0) FROM performance_assignments WHERE deleted_at IS NULL;
SELECT 'performance.payment_checksum|' || md5(coalesce(string_agg(concat_ws('|', id, payment_status, cost_total, withholding_tax, net_payment,
  actual_payment_date, actual_payment_amount, payout_round_id, contract_currency, contract_amount_foreign, deleted_at), ',' ORDER BY id), ''))
  FROM performance_assignments;

-- ── 지급회차 건별 확정 스냅샷(지급액·원천세 합계) ────────────────────────────
SELECT 'payout_round_items.count|' || count(*) || '|gross|' || coalesce(sum(gross_amount), 0) || '|withholding|' || coalesce(sum(withholding_amount), 0)
  || '|vat|' || coalesce(sum(vat_amount), 0) || '|net|' || coalesce(sum(net_amount), 0) FROM payout_round_items;
SELECT 'payout_round_items.checksum_excl_adjustment_id|' || md5(coalesce(string_agg((to_jsonb(i) - 'adjustment_id')::text, ',' ORDER BY i.id), '')) FROM payout_round_items i;

-- ── 국내 송금(payout_transfers) ─────────────────────────────────────────────
SELECT 'payout_transfers.count|' || count(*) || '|amount|' || coalesce(sum(amount), 0) || '|paid|' || count(*) FILTER (WHERE status = 'paid') FROM payout_transfers;
SELECT 'payout_transfers.checksum|' || md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY t.id), '')) FROM payout_transfers t;

-- ── 해외송금(performance_remittances) ──────────────────────────────────────
SELECT 'remittances.count|' || count(*) || '|by_currency|' || coalesce((SELECT string_agg(currency || '=' || s, ',' ORDER BY currency)
  FROM (SELECT currency, sum(foreign_amount) s FROM performance_remittances GROUP BY 1) c), 'none') FROM performance_remittances;
SELECT 'remittances.checksum|' || md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id), '')) FROM performance_remittances r;

-- ── 기타 기존 금융기록(변경 없어야 함) ───────────────────────────────────────
SELECT 'settlements.checksum|' || count(*) || '|' || md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id), '')) FROM settlements x;
SELECT 'project_payments.checksum|' || count(*) || '|' || md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id), '')) FROM project_payments x;
SELECT 'payment_transactions.checksum|' || count(*) || '|' || md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id), '')) FROM payment_transactions x;

-- ── 신규 정정 테이블 ────────────────────────────────────────────────────────
SELECT 'new.payout_adjustments.count|' || CASE WHEN to_regclass('public.payout_adjustments') IS NULL THEN 'absent'
  ELSE (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.payout_adjustments', false, true, '')))[1]::text END;
SELECT 'new.payout_round_items.adjustment_rows|' || CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'payout_round_items' AND column_name = 'adjustment_id') THEN 'absent'
  ELSE (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.payout_round_items where adjustment_id is not null', false, true, '')))[1]::text END;
COMMIT;
