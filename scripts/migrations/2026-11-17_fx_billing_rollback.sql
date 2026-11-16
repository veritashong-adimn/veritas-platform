-- [복구용 — 필요 시에만] 외화 청구·수금 컬럼 제거
--   ⚠ 먼저 이전 버전 코드로 되돌린 뒤 실행할 것(신규 코드는 이 컬럼을 조회하므로 컬럼이 없으면 판매상세·수금관리 오류).
--   ⚠ 적용 후 입력한 외화 청구금액·인보이스 환율·상계 거래 구분이 삭제된다.
--     외화 입금거래 자체(통화·외화금액·환율·원화환산)는 기존 컬럼이라 남는다 — 단 상계 거래는 일반 입금으로 보이게 되므로
--     롤백 전에 txn_type='offset' 거래를 확인할 것:  SELECT * FROM payment_transactions WHERE txn_type = 'offset';
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_offset_source_payment_id_project_payments_id_fk;
ALTER TABLE payment_transactions DROP COLUMN IF EXISTS offset_source_payment_id;
ALTER TABLE payment_transactions DROP COLUMN IF EXISTS txn_type;
ALTER TABLE project_payments DROP COLUMN IF EXISTS invoice_fx_date;
ALTER TABLE project_payments DROP COLUMN IF EXISTS invoice_fx_rate;
ALTER TABLE project_payments DROP COLUMN IF EXISTS foreign_amount;
ALTER TABLE project_payments DROP COLUMN IF EXISTS billing_currency;
COMMIT;
