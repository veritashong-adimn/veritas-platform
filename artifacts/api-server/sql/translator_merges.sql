-- ─────────────────────────────────────────────────────────────────────────────
-- 통번역사 수동 통합 — 영구 매핑 + 감사 로그 (Phase 3)
-- ⚠ 운영 DB 적용은 대표 승인 후에만. 아래 CREATE 는 신규 2개 테이블만 추가(기존 테이블 미변경).
-- 적용:   psql "$DATABASE_URL" -f artifacts/api-server/sql/translator_merges.sql
-- 롤백:   파일 하단 [ROLLBACK] 블록의 DROP 문 실행(신규 2개 테이블만 제거, 데이터 영향 없음)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS translator_merges (
  id                        serial PRIMARY KEY,
  merged_master_id          integer NOT NULL REFERENCES users(id),
  representative_master_id  integer NOT NULL REFERENCES users(id),
  same_person_confirmed     boolean NOT NULL DEFAULT false,
  basis                     text,
  note                      text,
  performed_by              integer REFERENCES users(id),
  snapshot                  jsonb,
  status                    varchar(20) NOT NULL DEFAULT 'active',
  merged_at                 timestamp NOT NULL DEFAULT now(),
  reverted_at               timestamp,
  reverted_by               integer REFERENCES users(id)
);
-- 한 계정은 동시에 하나의 대표로만 통합(활성 매핑 1개)
CREATE UNIQUE INDEX IF NOT EXISTS uq_translator_merges_merged_active
  ON translator_merges (merged_master_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_translator_merges_rep
  ON translator_merges (representative_master_id);

CREATE TABLE IF NOT EXISTS translator_merge_audit (
  id            serial PRIMARY KEY,
  merge_id      integer NOT NULL REFERENCES translator_merges(id),
  action        varchar(20) NOT NULL,
  entity_table  varchar(40),
  entity_id     integer,
  field         varchar(40),
  from_value    text,
  to_value      text,
  created_at    timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_translator_merge_audit_merge
  ON translator_merge_audit (merge_id);

-- ─── [ROLLBACK] 승인 철회/문제 시 — 신규 2개 테이블만 제거(기존 데이터 영향 0) ───
-- DROP TABLE IF EXISTS translator_merge_audit;
-- DROP TABLE IF EXISTS translator_merges;
