-- 복구(롤백): 신규 객체만 제거. 기존 데이터 영향 없음(adjustment_id 는 기존 행 전부 NULL).
BEGIN;
DROP INDEX IF EXISTS uq_payout_round_items_adjustment;
ALTER TABLE payout_round_items DROP COLUMN IF EXISTS adjustment_id;
DROP TABLE IF EXISTS payout_adjustments;
COMMIT;
