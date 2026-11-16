-- [복구용 — 필요 시에만] 먼저 이전 버전 코드로 되돌린 뒤 실행(신규 코드는 이 칸을 조회한다).
--   ⚠ 적용 후 입력한 청구정보 입금은행·은행 확인 값이 삭제된다(입금거래의 은행·입금액·입금일·입금상태는 영향 없음).
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE project_payments DROP COLUMN IF EXISTS deposit_bank_confirmed;
ALTER TABLE project_payments DROP COLUMN IF EXISTS deposit_bank;
COMMIT;
