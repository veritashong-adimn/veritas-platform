-- =====================================================================
-- [운영 적용용 — 별도 승인 후 실행] 외주업체 국내/해외 정산유형 + 해외 실제 송금내역
--   ① performance_assignments + vendor_settlement_type text · contract_currency text · contract_amount_foreign numeric(16,2)  (NULL 허용, 기본값 없음)
--   ② company_vendor_profiles + country text (NULL 허용)
--   ③ performance_remittances 신규 테이블(수행행 1:N 송금기록, FK 삭제규칙 NO ACTION — 송금 이력 있는 수행행 물리삭제 차단)
--   · lib/db/src/schema/{performance_assignments,company_vendor_profiles,performance_remittances}.ts 와 동일 정의(FK 이름 drizzle 규칙).
--   · 기본값 없는 NULL 컬럼 추가 = 메타데이터만 변경(테이블 재작성·기존 행 수정 없음). 신규 테이블은 빈 상태.
--   · IF NOT EXISTS — 재실행 안전(중복 생성 없음). 같은 트랜잭션에서 기존 데이터 체크섬(신규 컬럼 제외) 전후 비교 → 다르면 전체 롤백.
-- 실행:  psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/2026-11-22_vendor_settlement_remittance.sql
-- 순서:  ① 암호화 백업·복원검증 → ② _preverify.sql → ③ 이 SQL → ④ _postverify.sql → ⑤ 신규 코드 배포
--        (역순 금지: 신규 코드는 이 컬럼·테이블을 조회한다 — 없으면 판매상세 수행정보·지급회차 조회 오류)
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE performance_assignments, company_vendor_profiles IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE _vsr_before ON COMMIT DROP AS
SELECT (SELECT count(*) FROM performance_assignments) AS pa_n,
       (SELECT md5(coalesce(string_agg((to_jsonb(p) - 'vendor_settlement_type' - 'contract_currency' - 'contract_amount_foreign')::text, ',' ORDER BY p.id), '')) FROM performance_assignments p) AS pa_h,
       (SELECT count(*) FROM company_vendor_profiles) AS vp_n,
       (SELECT md5(coalesce(string_agg((to_jsonb(v) - 'country')::text, ',' ORDER BY v.id), '')) FROM company_vendor_profiles v) AS vp_h;

ALTER TABLE performance_assignments
  ADD COLUMN IF NOT EXISTS vendor_settlement_type text,
  ADD COLUMN IF NOT EXISTS contract_currency text,
  ADD COLUMN IF NOT EXISTS contract_amount_foreign numeric(16,2);
ALTER TABLE company_vendor_profiles ADD COLUMN IF NOT EXISTS country text;

CREATE TABLE IF NOT EXISTS performance_remittances (
  id serial PRIMARY KEY,
  assignment_id integer NOT NULL,
  remit_date date,
  currency text NOT NULL,
  foreign_amount numeric(16,2) NOT NULL,
  fx_rate numeric(18,6),
  krw_amount numeric(14,2),
  bank_fee numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'completed',
  memo text,
  created_by integer,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_by integer,
  updated_at timestamp NOT NULL DEFAULT now(),
  deleted_at timestamp,
  deleted_by integer,
  CONSTRAINT performance_remittances_assignment_id_performance_assignments_id_fk FOREIGN KEY (assignment_id) REFERENCES performance_assignments(id),
  CONSTRAINT performance_remittances_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT performance_remittances_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES users(id),
  CONSTRAINT performance_remittances_deleted_by_users_id_fk FOREIGN KEY (deleted_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_performance_remittances_assignment ON performance_remittances(assignment_id);

DO $$
DECLARE b record; a record; c int; f int;
BEGIN
  SELECT count(*) INTO c FROM information_schema.columns WHERE table_schema='public' AND column_default IS NULL AND is_nullable='YES'
     AND ((table_name='performance_assignments' AND ((column_name='vendor_settlement_type' AND data_type='text') OR (column_name='contract_currency' AND data_type='text')
                                                  OR (column_name='contract_amount_foreign' AND data_type='numeric' AND numeric_precision=16 AND numeric_scale=2)))
       OR (table_name='company_vendor_profiles' AND column_name='country' AND data_type='text'));
  IF c <> 4 THEN RAISE EXCEPTION '신규 컬럼 정의 불일치(%/4) — 롤백', c; END IF;
  SELECT count(*) INTO f FROM pg_constraint WHERE conrelid = 'public.performance_remittances'::regclass AND contype = 'f'
     AND confrelid = 'public.performance_assignments'::regclass AND confdeltype = 'a';
  IF f <> 1 THEN RAISE EXCEPTION 'performance_remittances → performance_assignments FK(삭제규칙 NO ACTION) 불일치 — 롤백'; END IF;
  SELECT * INTO b FROM _vsr_before;
  SELECT (SELECT count(*) FROM performance_assignments) AS pa_n,
         (SELECT md5(coalesce(string_agg((to_jsonb(p) - 'vendor_settlement_type' - 'contract_currency' - 'contract_amount_foreign')::text, ',' ORDER BY p.id), '')) FROM performance_assignments p) AS pa_h,
         (SELECT count(*) FROM company_vendor_profiles) AS vp_n,
         (SELECT md5(coalesce(string_agg((to_jsonb(v) - 'country')::text, ',' ORDER BY v.id), '')) FROM company_vendor_profiles v) AS vp_h INTO a;
  IF a.pa_n <> b.pa_n OR a.pa_h <> b.pa_h OR a.vp_n <> b.vp_n OR a.vp_h <> b.vp_h THEN RAISE EXCEPTION '기존 수행·외주프로필 데이터 변경 감지 — 롤백'; END IF;
  RAISE NOTICE '외주 정산유형·해외송금 스키마 적용 완료 — 수행정보 %행·외주프로필 %행 보존', a.pa_n, a.vp_n;
END $$;
COMMIT;
