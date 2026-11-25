-- 청구회차 1 : 입금내역 N — 입금내역별 결제구분·입금예정일·입금예정액(2026-11). 추가(additive) 컬럼만, 기존 행 UPDATE·DELETE 없음.
-- 실행:  psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/sql/2026-11-payment-txn-schedule-up.sql
-- 순서:  ① 백업 → ② -verify.sql(적용 전) → ③ 이 SQL → ④ -verify.sql(적용 후, 기존 지표 동일 확인) → ⑤ 신규 코드 배포
-- 재실행 안전: IF NOT EXISTS 로 멱등. 한 트랜잭션.
-- 의미:
--   · payment_type    = 입금내역의 결제구분(lump_sum·advance·interim·balance). NULL = 미지정(기존 입금거래).
--   · expected_date   = 입금예정일. expected_amount = 입금예정액(아직 받지 않은 금액 — 실제 입금액·미수금 계산에 포함하지 않음).
--   · 실제 입금액은 기존 customer_paid_amount 그대로(예정 내역은 0). 기존 집계 SQL(SUM(customer_paid_amount))은 수정 없이 정확.
-- 롤백:  lib/db/sql/2026-11-payment-txn-schedule-down.sql
BEGIN;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS payment_type varchar(20);
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS expected_date date;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS expected_amount numeric(14, 2);
COMMIT;
