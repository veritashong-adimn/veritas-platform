-- ─────────────────────────────────────────────────────────────────────────────
-- VERITAS OS — 2단계 테스트 거래/금융 데이터 1회성 Cleanup (2026-09-22)
--
-- [원칙]
--   · 고정된(frozen) 테스트 ID 집합만 대상. 광범위 조건(날짜/전체) 금지.
--   · 단일 트랜잭션(all-or-nothing). psql -1 -v ON_ERROR_STOP=1 로 실행.
--   · Master/기준정보(companies·contacts·translators·products·users·settings·
--     prepaid_accounts·prepaid_ledger·comparison_quote_vendors·import_*·logs)는 삭제하지 않는다.
--   · 재실행해도 새 실데이터(신규 ID)는 삭제되지 않는다(IN(고정ID)).
--
-- [Frozen anchors] (2026-09-22 조사 확정)
--   quoteIds(23)   = 81,82,83,84,85,86,87,88,104,106,137,173,174,175,176,177,178,179,181,218,219,220,221
--   projectIds(19) = 70,71,72,73,74,75,76,77,90,92,137,138,139,140,141,145,185,186,187
--   roundIds(4)    = 6,7,10,11
--   billingIds(1)  = 9
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Safety tripwire: 고정 집합 밖의 예상치 못한(=신규 실데이터일 수 있는) 행이 있으면 전체 중단 ──
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM quotes WHERE id NOT IN (81,82,83,84,85,86,87,88,104,106,137,173,174,175,176,177,178,179,181,218,219,220,221)) THEN
    RAISE EXCEPTION 'ABORT: quotes 테이블에 고정집합(23) 밖의 ID가 존재합니다. 조사 재확인 필요.';
  END IF;
  IF EXISTS (SELECT 1 FROM projects WHERE id NOT IN (70,71,72,73,74,75,76,77,90,92,137,138,139,140,141,145,185,186,187)) THEN
    RAISE EXCEPTION 'ABORT: projects 테이블에 고정집합(19) 밖의 ID가 존재합니다. 조사 재확인 필요.';
  END IF;
  IF EXISTS (SELECT 1 FROM payout_rounds WHERE id NOT IN (6,7,10,11)) THEN
    RAISE EXCEPTION 'ABORT: payout_rounds 테이블에 고정집합(4) 밖의 ID가 존재합니다. 조사 재확인 필요.';
  END IF;
  RAISE NOTICE 'Safety tripwire 통과 — 고정집합과 현재 데이터 일치.';
END $$;

-- ── [지급 계열] payout_transfers → payout_round_items → 회차귀속 해제 → payout_rounds ──
DELETE FROM payout_transfers   WHERE payout_round_id IN (6,7,10,11);
DELETE FROM payout_round_items WHERE payout_round_id IN (6,7,10,11);
UPDATE performance_assignments SET payout_round_id = NULL WHERE payout_round_id IN (6,7,10,11);
DELETE FROM payout_rounds       WHERE id IN (6,7,10,11);

-- ── [수행 계열] performance_assignments (performance_expenses/deductions 는 FK CASCADE) ──
DELETE FROM performance_assignments WHERE project_id IN (70,71,72,73,74,75,76,77,90,92,137,138,139,140,141,145,185,186,187);

-- ── [고객 입금 계열] payment_transactions → project_payments ──
DELETE FROM payment_transactions WHERE project_id IN (70,71,72,73,74,75,76,77,90,92,137,138,139,140,141,145,185,186,187);
DELETE FROM project_payments     WHERE project_id IN (70,71,72,73,74,75,76,77,90,92,137,138,139,140,141,145,185,186,187);

-- ── [청구 배치] billing_batches (billing_batch_items/work_items 는 FK CASCADE) — projects 삭제 전에 제거 ──
DELETE FROM billing_batches WHERE id IN (9);

-- ── [업무] quotes (quote_items·quote_item_files·comparison_quotes·comparison_quote_items FK CASCADE) ──
DELETE FROM quotes WHERE id IN (81,82,83,84,85,86,87,88,104,106,137,173,174,175,176,177,178,179,181,218,219,220,221);

-- ── [업무] projects (project_files·translation_units FK CASCADE; prepaid_ledger·invitations SET NULL) ──
DELETE FROM projects WHERE id IN (70,71,72,73,74,75,76,77,90,92,137,138,139,140,141,145,185,186,187);

-- ── 최종 잔존 확인(트랜잭션 내) ──
DO $$
DECLARE q int; p int; pp int; tx int; pa int; pr int; pri int; ptr int;
BEGIN
  SELECT count(*) INTO q   FROM quotes;
  SELECT count(*) INTO p   FROM projects;
  SELECT count(*) INTO pp  FROM project_payments;
  SELECT count(*) INTO tx  FROM payment_transactions;
  SELECT count(*) INTO pa  FROM performance_assignments;
  SELECT count(*) INTO pr  FROM payout_rounds;
  SELECT count(*) INTO pri FROM payout_round_items;
  SELECT count(*) INTO ptr FROM payout_transfers;
  RAISE NOTICE '잔존 — quotes=% projects=% project_payments=% payment_transactions=% performance_assignments=% payout_rounds=% payout_round_items=% payout_transfers=%',
    q,p,pp,tx,pa,pr,pri,ptr;
  IF (q+p+pp+tx+pa+pr+pri+ptr) <> 0 THEN
    RAISE EXCEPTION 'ABORT: 삭제 후에도 대상 테이블에 잔존 행이 있습니다(합계=%). 롤백합니다.', (q+p+pp+tx+pa+pr+pri+ptr);
  END IF;
END $$;
