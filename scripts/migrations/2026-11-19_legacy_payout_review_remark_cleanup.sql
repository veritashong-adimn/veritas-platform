-- =====================================================================
-- [운영 적용용 — 별도 승인 후 실행] 과거 CRM 수행정보 비고의 '[과거 CRM] 과거 지급 확인 필요' 문구 제거
--   대상: performance_assignments.remark 가 '[과거 CRM] 과거 지급 확인 필요' 로 시작하는 행(운영 사전 조회 145건)
--   처리: 맨 앞 문구(와 뒤따르는 ' · ')만 제거하고 나머지 비고는 그대로 둔다. 문구만 있던 비고는 NULL.
--     예) '[과거 CRM] 과거 지급 확인 필요 · 수행자 안정은(Master 미연결) · 외대통대19졸' → '수행자 안정은(Master 미연결) · 외대통대19졸'
--   변경하지 않는 것: 비고 외 모든 컬럼(통번역사·지급금액·지급일·지급상태·정산·이관 출처·updated_at 포함).
--   안전장치: 같은 트랜잭션에서 ① 비고 외 전 컬럼 체크섬 전후 비교 ② 남은 문구 0건 ③ 변경 건수 = 사전 대상 건수 → 다르면 전체 롤백.
--   되돌리기용 원본 비고를 _bak_perf_remark_20261119 에 보관(롤백 SQL: _rollback.sql).
-- 실행:  psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/2026-11-19_legacy_payout_review_remark_cleanup.sql
-- 순서:  ① 백업 → ② _verify.sql(적용 전) → ③ 이 SQL → ④ _verify.sql(적용 후: 남은 문구 0, 비고 외 체크섬 동일)
-- 재실행: 대상이 없으면 아무것도 바꾸지 않는다(백업 표가 이미 있으면 기존 백업을 보존하고 새 대상만 추가).
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE performance_assignments IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE _remark_before ON COMMIT DROP AS
SELECT count(*) AS n,
       md5(coalesce(string_agg((to_jsonb(pa) - 'remark')::text, ',' ORDER BY pa.id), '')) AS h,
       count(*) FILTER (WHERE remark LIKE '[과거 CRM] 과거 지급 확인 필요%') AS targets
  FROM performance_assignments pa;

CREATE TABLE IF NOT EXISTS _bak_perf_remark_20261119 (id integer PRIMARY KEY, remark text, backed_up_at timestamp NOT NULL DEFAULT now());
INSERT INTO _bak_perf_remark_20261119 (id, remark)
SELECT id, remark FROM performance_assignments WHERE remark LIKE '[과거 CRM] 과거 지급 확인 필요%'
ON CONFLICT (id) DO NOTHING;

UPDATE performance_assignments
   SET remark = NULLIF(regexp_replace(remark, '^\[과거 CRM\] 과거 지급 확인 필요( · )?', ''), '')
 WHERE remark LIKE '[과거 CRM] 과거 지급 확인 필요%';

DO $$
DECLARE b record; a record; left_n int; changed int;
BEGIN
  SELECT * INTO b FROM _remark_before;
  SELECT count(*) AS n, md5(coalesce(string_agg((to_jsonb(pa) - 'remark')::text, ',' ORDER BY pa.id), '')) AS h INTO a FROM performance_assignments pa;
  IF a.n <> b.n OR a.h <> b.h THEN RAISE EXCEPTION '비고 외 컬럼 변경 감지 — 롤백'; END IF;
  SELECT count(*) INTO left_n FROM performance_assignments WHERE remark LIKE '%[과거 CRM] 과거 지급 확인 필요%';
  IF left_n <> 0 THEN RAISE EXCEPTION '문구가 남은 행 % 건 — 롤백', left_n; END IF;
  SELECT count(*) INTO changed FROM _bak_perf_remark_20261119 k JOIN performance_assignments pa ON pa.id = k.id
   WHERE pa.remark IS DISTINCT FROM k.remark AND k.remark LIKE '[과거 CRM] 과거 지급 확인 필요%';
  IF changed < b.targets THEN RAISE EXCEPTION '변경 건수 불일치(대상 %, 변경 %) — 롤백', b.targets, changed; END IF;
  RAISE NOTICE '비고 정리 완료 — 대상 %건, 비고 외 컬럼 체크섬 동일, 남은 문구 0건', b.targets;
END $$;
COMMIT;
