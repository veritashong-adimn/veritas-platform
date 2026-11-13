-- [복구용 — 필요 시에만] 거래처 기본 세금 유형 컬럼 제거
--   ⚠ 먼저 이전 버전 코드로 되돌린 뒤 실행할 것(신규 코드는 이 컬럼을 조회하므로 컬럼이 없으면 거래처 조회 오류).
--   ⚠ 적용 후 입력한 거래처 세금 유형·근거·확인일·확인자 값은 삭제된다(견적·판매·청구 데이터에는 영향 없음 —
--     견적 세금 유형은 quote_items.tax_type 에 별도 저장). 확인 기록은 logs(company_tax_type_changed)에 남는다.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE companies DROP COLUMN IF EXISTS tax_type_confirmed_by;
ALTER TABLE companies DROP COLUMN IF EXISTS tax_type_confirmed_at;
ALTER TABLE companies DROP COLUMN IF EXISTS tax_type_basis;
ALTER TABLE companies DROP COLUMN IF EXISTS default_tax_type;
COMMIT;
