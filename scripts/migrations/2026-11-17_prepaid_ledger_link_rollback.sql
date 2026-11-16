-- [복구용 — 필요 시에만] 먼저 이전 버전 코드로 되돌린 뒤 실행. 기존 입금 연결 정보(linked_payment_id)·확정자/시각이 삭제된다.
--   롤백 전 확인: SELECT id, account_id, quote_id, amount, linked_payment_id FROM prepaid_ledger WHERE linked_payment_id IS NOT NULL;
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP INDEX IF EXISTS uq_prepaid_ledger_quote_deduction;
DROP INDEX IF EXISTS uq_prepaid_ledger_linked_payment;
ALTER TABLE prepaid_ledger DROP CONSTRAINT IF EXISTS prepaid_ledger_linked_payment_id_project_payments_id_fk;
ALTER TABLE prepaid_ledger DROP COLUMN IF EXISTS confirmed_at;
ALTER TABLE prepaid_ledger DROP COLUMN IF EXISTS confirmed_by;
ALTER TABLE prepaid_ledger DROP COLUMN IF EXISTS linked_payment_id;
COMMIT;
