-- 롤백: 2026-11-payment-txn-schedule-up.sql 로 추가한 컬럼 제거. 입금예정 내역(customer_paid_amount=0)의 예정액·예정일·결제구분 정보가 사라지므로 백업 후 실행.
--   실제 입금액(customer_paid_amount)·입금일은 영향 없음. 입금예정 전용 행(실입금 0)은 남는다 — 필요 시 아래 확인 후 별도 정리.
--   확인: SELECT id, project_payment_id FROM payment_transactions WHERE coalesce(customer_paid_amount,0) = 0 AND paid_date IS NULL AND expected_amount IS NOT NULL;
BEGIN;
ALTER TABLE payment_transactions DROP COLUMN IF EXISTS expected_amount;
ALTER TABLE payment_transactions DROP COLUMN IF EXISTS expected_date;
ALTER TABLE payment_transactions DROP COLUMN IF EXISTS payment_type;
COMMIT;
