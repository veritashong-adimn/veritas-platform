-- [복구용 — 필요 시에만] 정리 전 비고로 되돌린다(백업 표 _bak_perf_remark_20261120 기준, 비고 컬럼만).
--   정리 후 사용자가 직접 고친 비고는 덮어쓰지 않도록, 현재 비고가 '정리 결과값'과 같을 때만 되돌린다.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE FUNCTION pg_temp.strip_auto_remark(r text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT NULLIF(array_to_string(ARRAY(
    SELECT u.s FROM unnest(string_to_array(r, ' · ')) WITH ORDINALITY u(s, o)
     WHERE u.s <> '' AND u.s !~ '^\[과거 CRM\] ' AND u.s !~ '^(수행자 )?[^·]{1,40}\(Master 미연결\)$'
       AND u.s !~ '^과거 지급 확인: (지급완료|미지급) 확인\(.*\)$'
     ORDER BY u.o), ' · '), '')
$f$;
UPDATE performance_assignments pa SET remark = k.remark
  FROM _bak_perf_remark_20261120 k
 WHERE pa.id = k.id AND pa.remark IS NOT DISTINCT FROM pg_temp.strip_auto_remark(k.remark);
COMMIT;
-- 확인 후 백업 표 삭제(선택):  DROP TABLE _bak_perf_remark_20261120;
