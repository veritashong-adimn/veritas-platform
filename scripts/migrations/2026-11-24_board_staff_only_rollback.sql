-- [복구용 — 필요 시에만] 직원전용 게시판 신규 테이블 제거. 직원전용 게시글이 있으면 중단(데이터 보호).
--   enum 값 'staff_only' 는 PostgreSQL 에서 제거할 수 없어 남겨 둔다(사용되지 않으면 무해).
--   R2 의 board-private/ 파일은 이 SQL 로 지우지 않는다.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM board_posts WHERE category::text = 'staff_only') THEN
    RAISE EXCEPTION '직원전용 게시글이 있어 롤백 중단 — 먼저 게시글을 정리하세요';
  END IF;
END $$;
DROP TABLE IF EXISTS board_post_files;
DROP TABLE IF EXISTS board_post_targets;
COMMIT;
