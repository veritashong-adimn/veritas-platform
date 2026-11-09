-- ─────────────────────────────────────────────────────────────────────────────
-- 고객관리 제외 목록 — 신규 테이블 1개 추가 전용 마이그레이션 (2026-11-09)
--
--  · 고객관리 화면의 [삭제] = 이 테이블에 제외 기록 1행 추가. 거래처(companies) 원본은 변경하지 않는다.
--  · [복원] = 해당 행에 restored_at/restored_by 기록(행 삭제 없음 → 제외·복원 이력 보존).
--  · 한 거래처당 '현재 제외 중'(restored_at IS NULL) 기록은 1건만 허용(부분 유니크 인덱스).
--  · 기존 테이블·컬럼·데이터는 변경하지 않는다. companies 는 FK 참조 대상일 뿐 구조 변경 없음.
--    (거래처 완전삭제 시 제외 기록도 함께 삭제되도록 ON DELETE CASCADE)
--  · IF NOT EXISTS 로 재실행 안전(멱등). 트랜잭션으로 전부 적용 또는 전부 미적용.
--  · 적용 대상: 개발 DB 만. 운영 DB 적용은 별도 승인 후 진행. drizzle-kit push 사용 금지.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

CREATE TABLE IF NOT EXISTS customer_list_exclusions (
  id           serial PRIMARY KEY,
  company_id   integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reason       text,
  excluded_at  timestamp NOT NULL DEFAULT now(),
  excluded_by  integer,
  restored_at  timestamp,
  restored_by  integer
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_list_exclusions_active
  ON customer_list_exclusions (company_id) WHERE restored_at IS NULL;

COMMIT;
