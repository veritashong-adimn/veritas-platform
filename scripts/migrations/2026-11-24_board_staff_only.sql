-- =====================================================================
-- [운영 적용용 — 별도 승인 후 실행] 게시판 직원전용 자료(카테고리 staff_only · 대상 직원 · 첨부파일)
--   · board_category enum 에 'staff_only' 추가(기존 값 유지)
--   · board_post_targets(post_id, user_id) · board_post_files 신규 — 빈 테이블 생성만, 기존 게시글·데이터 변경 없음.
--   · lib/db/src/schema/board_posts.ts 와 동일 정의. IF NOT EXISTS — 재실행 안전.
-- 실행:  psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/2026-11-24_board_staff_only.sql
-- 순서:  ① 백업 → ② 이 SQL → ③ _verify.sql → ④ 신규 코드 배포 (역순 금지: 신규 코드는 두 테이블을 조회한다)
-- =====================================================================
\set ON_ERROR_STOP on
-- enum 값 추가는 트랜잭션 밖에서(같은 트랜잭션 안에서 새 값 사용 불가 — 여기서는 사용하지 않음)
ALTER TYPE board_category ADD VALUE IF NOT EXISTS 'staff_only';

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TEMP TABLE _bp_before ON COMMIT DROP AS
SELECT count(*) n, md5(coalesce(string_agg(to_jsonb(b)::text, ',' ORDER BY b.id), '')) h FROM board_posts b;

CREATE TABLE IF NOT EXISTS board_post_targets (
  post_id integer NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT board_post_targets_post_id_user_id_pk PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_board_post_targets_user ON board_post_targets (user_id);

CREATE TABLE IF NOT EXISTS board_post_files (
  id serial PRIMARY KEY,
  post_id integer NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
  original_file_name text NOT NULL,
  file_path text NOT NULL,
  mime_type text,
  file_size integer,
  uploaded_by integer REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_board_post_files_post ON board_post_files (post_id);

DO $$
DECLARE b record; a record;
BEGIN
  SELECT * INTO b FROM _bp_before;
  SELECT count(*) n, md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id), '')) h INTO a FROM board_posts x;
  IF a.n <> b.n OR a.h <> b.h THEN RAISE EXCEPTION '기존 게시글 변경 감지 — 롤백'; END IF;
  RAISE NOTICE '직원전용 게시판 스키마 적용 — 기존 게시글 % 건 불변', b.n;
END $$;
COMMIT;
