-- 지급 정정·승인·차액 정산(payout_adjustments) — 2026-11 승인 스키마. 추가(additive) 변경만 포함, 기존 행 UPDATE·DELETE 없음.
-- 실행:  psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/sql/2026-11-payout-adjustments-up.sql
-- 순서:  ① 암호화 백업·복원검증 → ② -verify.sql(적용 전) → ③ 이 SQL → ④ -verify.sql(적용 후, 기존 지표 동일 확인) → ⑤ 신규 코드 배포
-- 재실행 안전: IF NOT EXISTS 로 멱등. 전체를 한 트랜잭션으로 실행(중간 실패 시 전부 롤백).
-- 롤백:  lib/db/sql/2026-11-payout-adjustments-down.sql (신규 객체만 제거 — 배포 후 생성된 정정 기록도 함께 삭제되므로 백업 후 실행)
-- 제약명은 Drizzle 명명 규칙(<table>_<col>_<ref>_<refcol>_fk)과 일치 — 이후 drizzle-kit 비교 시 불필요한 재생성 방지.
BEGIN;
CREATE TABLE IF NOT EXISTS payout_adjustments (
  id serial PRIMARY KEY,
  assignment_id integer NOT NULL CONSTRAINT payout_adjustments_assignment_id_performance_assignments_id_fk REFERENCES performance_assignments(id),
  project_id integer NOT NULL,
  kind varchar(30) NOT NULL,
  source_round_id integer,
  payee_type text,
  payee_id integer,
  payee_name text,
  currency varchar(3) NOT NULL DEFAULT 'KRW',
  requested_patch jsonb NOT NULL,
  before_values jsonb NOT NULL,
  after_values jsonb,
  delta_gross numeric(16,2) NOT NULL DEFAULT '0',
  delta_withholding numeric(16,2) NOT NULL DEFAULT '0',
  delta_vat numeric(16,2) NOT NULL DEFAULT '0',
  delta_net numeric(16,2) NOT NULL DEFAULT '0',
  delta_foreign numeric(16,2),
  tax_correction_needed boolean NOT NULL DEFAULT false,
  invoice_correction_needed boolean NOT NULL DEFAULT false,
  reason text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'requested',
  requested_by integer CONSTRAINT payout_adjustments_requested_by_users_id_fk REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamp NOT NULL DEFAULT now(),
  decided_by integer CONSTRAINT payout_adjustments_decided_by_users_id_fk REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamp,
  decision_note text,
  settlement_type varchar(30),
  settlement_status varchar(20),
  settlement_round_id integer,
  settled_at timestamp,
  settled_by integer CONSTRAINT payout_adjustments_settled_by_users_id_fk REFERENCES users(id) ON DELETE SET NULL,
  settlement_ref text,
  settlement_note text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_adjustments_pending ON payout_adjustments (assignment_id) WHERE status = 'requested';
CREATE INDEX IF NOT EXISTS idx_payout_adjustments_status ON payout_adjustments (status);
CREATE INDEX IF NOT EXISTS idx_payout_adjustments_assignment ON payout_adjustments (assignment_id);
CREATE INDEX IF NOT EXISTS idx_payout_adjustments_settlement_round ON payout_adjustments (settlement_round_id);
ALTER TABLE payout_round_items ADD COLUMN IF NOT EXISTS adjustment_id integer;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_round_items_adjustment ON payout_round_items (adjustment_id) WHERE adjustment_id IS NOT NULL;
COMMIT;
