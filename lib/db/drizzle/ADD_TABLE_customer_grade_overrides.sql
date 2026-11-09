-- ─────────────────────────────────────────────────────────────────────────────
-- 고객 등급 관리자 지정 — 신규 테이블 1개 추가 전용 마이그레이션 (2026-11-09)
--
--  · 자동 등급(매출·거래 실적 계산값)은 저장하지 않는다. 이 테이블은 관리자가 지정한 등급만 기록한다.
--  · 지정 해제 = 행 삭제가 아니라 released_at/released_by 기록(지정·해제 이력 보존) → 자동 등급으로 복귀.
--  · 거래처당 '현재 지정 중'(released_at IS NULL) 기록은 1건만 허용(부분 유니크 인덱스).
--  · 기존 테이블·컬럼·데이터는 변경하지 않는다(companies 는 FK 참조 대상일 뿐).
--  · IF NOT EXISTS 로 재실행 안전. 트랜잭션으로 전부 적용 또는 전부 미적용.
--  · 적용 대상: 개발 DB 만. 운영 DB 적용은 별도 승인 후 진행. drizzle-kit push 사용 금지.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

CREATE TABLE IF NOT EXISTS customer_grade_overrides (
  id           serial PRIMARY KEY,
  company_id   integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  grade        varchar(10) NOT NULL CHECK (grade IN ('VIP', '우수', '일반', '휴면', '신규')),
  reason       text NOT NULL,
  set_at       timestamp NOT NULL DEFAULT now(),
  set_by       integer,
  released_at  timestamp,
  released_by  integer
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_grade_overrides_active
  ON customer_grade_overrides (company_id) WHERE released_at IS NULL;

COMMIT;
