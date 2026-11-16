-- [복구용 — 필요 시에만] 이전 버전 코드로 되돌린 뒤 실행. 원장 수정 이력·등록자·비고(memo)가 삭제된다.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE IF EXISTS prepaid_ledger_history;
ALTER TABLE prepaid_ledger DROP COLUMN IF EXISTS memo;
ALTER TABLE prepaid_ledger DROP COLUMN IF EXISTS created_by;
COMMIT;
