-- =====================================================================
-- [운영 적용용 — 별도 승인 후 실행] 과거 CRM 이관 시 수행정보 비고에 자동 생성된 관리용 문구 제거
--   비고(remark)를 ' · ' 로 나눈 조각 중 아래와 '정확히 일치하는 조각'만 제거하고, 나머지 조각은 순서·글자 그대로 다시 합친다.
--     ① '[과거 CRM] …'                         (과거 CRM 이관 태그: 과거 CRM · 과거 지급완료(지급일 …) · 과거 지급 확인 필요)
--     ② '(수행자 )이름(Master 미연결)'            (Master 연결 여부는 통번역사 연결·수행자명 스냅샷에 있음)
--     ③ '과거 지급 확인: 지급완료|미지급 확인(근거)' (확인 결과·근거·확인자·일시는 감사로그 legacy_payout_review_resolved 에 있음)
--   남는 내용이 없으면 비고는 NULL. 사용자가 입력한 업무 비고 조각은 바꾸지 않는다.
--   변경하지 않는 것: 비고 외 모든 컬럼(통번역사 연결·지급금액·지급상태·지급일·정산·이관 출처·updated_at 포함).
--   안전장치(같은 트랜잭션): 비고 외 전 컬럼 체크섬 전후 동일 · 남은 자동 문구 0건 · 변경 건수 = 대상 건수 → 아니면 전체 롤백.
--   원래 비고는 _bak_perf_remark_20261120 에 보관(롤백: _rollback.sql).
-- 실행:  psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/2026-11-20_legacy_auto_remark_cleanup.sql
-- 순서:  ① _verify.sql(적용 전) → ② 이 SQL → ③ _verify.sql(적용 후: 남은 자동 문구 0, 비고 외 체크섬 동일)
-- 재실행: 대상이 없으면 아무것도 바꾸지 않는다(기존 백업은 보존).
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE performance_assignments IN SHARE ROW EXCLUSIVE MODE;

-- 정리 규칙(이 트랜잭션 전용 임시 함수)
CREATE FUNCTION pg_temp.strip_auto_remark(r text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT NULLIF(array_to_string(ARRAY(
    SELECT u.s FROM unnest(string_to_array(r, ' · ')) WITH ORDINALITY u(s, o)
     WHERE u.s <> ''
       AND u.s !~ '^\[과거 CRM\] '
       AND u.s !~ '^(수행자 )?[^·]{1,40}\(Master 미연결\)$'
       AND u.s !~ '^과거 지급 확인: (지급완료|미지급) 확인\(.*\)$'
     ORDER BY u.o), ' · '), '')
$f$;

CREATE TEMP TABLE _ar_before ON COMMIT DROP AS
SELECT count(*) AS n,
       md5(coalesce(string_agg((to_jsonb(pa) - 'remark')::text, ',' ORDER BY pa.id), '')) AS h,
       count(*) FILTER (WHERE pa.remark IS DISTINCT FROM pg_temp.strip_auto_remark(pa.remark)) AS targets
  FROM performance_assignments pa;

CREATE TABLE IF NOT EXISTS _bak_perf_remark_20261120 (id integer PRIMARY KEY, remark text, backed_up_at timestamp NOT NULL DEFAULT now());
INSERT INTO _bak_perf_remark_20261120 (id, remark)
SELECT id, remark FROM performance_assignments WHERE remark IS DISTINCT FROM pg_temp.strip_auto_remark(remark)
ON CONFLICT (id) DO NOTHING;

UPDATE performance_assignments SET remark = pg_temp.strip_auto_remark(remark)
 WHERE remark IS DISTINCT FROM pg_temp.strip_auto_remark(remark);

DO $$
DECLARE b record; a record; left_n int; changed int;
BEGIN
  SELECT * INTO b FROM _ar_before;
  SELECT count(*) AS n, md5(coalesce(string_agg((to_jsonb(pa) - 'remark')::text, ',' ORDER BY pa.id), '')) AS h INTO a FROM performance_assignments pa;
  IF a.n <> b.n OR a.h <> b.h THEN RAISE EXCEPTION '비고 외 컬럼 변경 감지 — 롤백'; END IF;
  SELECT count(*) INTO left_n FROM performance_assignments
   WHERE remark ~ '\[과거 CRM\]|\(Master 미연결\)|과거 지급 확인: (지급완료|미지급) 확인\(';
  IF left_n <> 0 THEN RAISE EXCEPTION '자동 문구가 남은 행 % 건 — 롤백(규칙 확인 필요)', left_n; END IF;
  SELECT count(*) INTO changed FROM _bak_perf_remark_20261120 k JOIN performance_assignments pa ON pa.id = k.id
   WHERE pa.remark IS NOT DISTINCT FROM pg_temp.strip_auto_remark(k.remark) AND pa.remark IS DISTINCT FROM k.remark;
  IF changed < b.targets THEN RAISE EXCEPTION '변경 건수 불일치(대상 %, 변경 %) — 롤백', b.targets, changed; END IF;
  RAISE NOTICE '자동 비고 문구 정리 완료 — 대상 %건, 비고 외 컬럼 체크섬 동일, 남은 자동 문구 0건', b.targets;
END $$;
COMMIT;
