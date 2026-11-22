-- [검증] 직원전용 게시판 스키마 적용 확인(READ ONLY)
BEGIN READ ONLY;
SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS board_category FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'board_category';
SELECT table_name, count(*) AS columns FROM information_schema.columns WHERE table_name IN ('board_post_targets', 'board_post_files') GROUP BY 1 ORDER BY 1;
SELECT category, count(*) FROM board_posts GROUP BY 1 ORDER BY 1;
COMMIT;
