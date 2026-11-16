-- [복구용 — 필요 시에만] 정리 전 비고로 되돌린다(백업 표 _bak_perf_remark_20261119 기준, 비고 컬럼만).
--   이후 사용자가 직접 고친 비고까지 덮어쓰지 않도록, 현재 비고가 '정리 결과값'과 같을 때만 되돌린다.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
UPDATE performance_assignments pa SET remark = k.remark
  FROM _bak_perf_remark_20261119 k
 WHERE pa.id = k.id
   AND pa.remark IS NOT DISTINCT FROM NULLIF(regexp_replace(k.remark, '^\[과거 CRM\] 과거 지급 확인 필요( · )?', ''), '');
COMMIT;
-- 확인 후 백업 표 삭제(선택):  DROP TABLE _bak_perf_remark_20261119;
