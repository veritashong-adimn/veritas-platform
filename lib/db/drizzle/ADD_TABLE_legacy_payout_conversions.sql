-- 과거 CRM 미지급 수행건 → 운영 지급(은행이체) 전환 승인 이력 테이블(신규).
-- 운영 DB 적용: 이 파일만 개별 실행(전체 drizzle-kit push 금지 — 스키마에 없는 quote/inquiry 번호 시퀀스를 DROP 함).
-- 멱등(IF NOT EXISTS). 기존 테이블·데이터 변경 없음.
CREATE TABLE IF NOT EXISTS legacy_payout_conversions (
  id serial PRIMARY KEY,
  progress_row_id integer NOT NULL REFERENCES legacy_archive_rows(id),
  sale_row_id integer REFERENCES legacy_archive_rows(id),
  sale_no text,
  translator_name text,
  delivery_date text,
  amount_pretax numeric,
  amount_posttax numeric,
  legacy_status varchar(30),
  status varchar(20) NOT NULL DEFAULT 'requested',
  request_note text,
  requested_by integer REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamp NOT NULL DEFAULT now(),
  decision_note text,
  decided_by integer REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamp,
  project_id integer,
  assignment_id integer
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_legacy_payout_conv_active ON legacy_payout_conversions (progress_row_id) WHERE status IN ('requested','approved');
CREATE INDEX IF NOT EXISTS idx_legacy_payout_conv_status ON legacy_payout_conversions (status);
