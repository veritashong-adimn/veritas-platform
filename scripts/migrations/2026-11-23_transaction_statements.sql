-- =====================================================================
-- [운영 적용용 — 별도 승인 후 실행] 거래명세서 거래일자 저장 테이블
--   transaction_statements 신규(견적당 1건, quote_id UNIQUE) — 기존 테이블·데이터 변경 없음(빈 테이블 생성만).
--   · lib/db/src/schema/transaction_statements.ts 와 동일 정의(FK 이름 drizzle 규칙).
--   · quote FK ON DELETE CASCADE(견적 영구삭제 시 함께 삭제 — 변경 이력은 logs 에 유지), 청구 회차 FK ON DELETE SET NULL.
--   · IF NOT EXISTS — 재실행 안전. 같은 트랜잭션에서 견적·청구 데이터 체크섬 전후 비교 → 다르면 롤백.
-- 실행:  psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/2026-11-23_transaction_statements.sql
-- 순서:  ① 암호화 백업·복원검증 → ② _verify.sql(적용 전) → ③ 이 SQL → ④ _verify.sql(적용 후) → ⑤ 신규 코드 배포
--        (역순 금지: 신규 코드는 거래명세서를 열 때 이 테이블을 조회한다 — 없으면 거래명세서 출력 설정 조회 오류)
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TEMP TABLE _ts_before ON COMMIT DROP AS
SELECT (SELECT count(*) FROM quotes) q_n, (SELECT md5(coalesce(string_agg(to_jsonb(q)::text, ',' ORDER BY q.id), '')) FROM quotes q) q_h,
       (SELECT count(*) FROM project_payments) pp_n, (SELECT md5(coalesce(string_agg(to_jsonb(p)::text, ',' ORDER BY p.id), '')) FROM project_payments p) pp_h;

CREATE TABLE IF NOT EXISTS transaction_statements (
  id serial PRIMARY KEY,
  quote_id integer NOT NULL,
  statement_no text NOT NULL,
  transaction_date date NOT NULL,
  date_source text NOT NULL DEFAULT 'manual',
  linked_payment_id integer,
  created_at timestamp NOT NULL DEFAULT now(),
  created_by integer,
  updated_at timestamp NOT NULL DEFAULT now(),
  updated_by integer,
  CONSTRAINT transaction_statements_quote_id_unique UNIQUE (quote_id),
  CONSTRAINT transaction_statements_quote_id_quotes_id_fk FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE,
  CONSTRAINT transaction_statements_linked_payment_id_project_payments_id_fk FOREIGN KEY (linked_payment_id) REFERENCES project_payments(id) ON DELETE SET NULL,
  CONSTRAINT transaction_statements_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT transaction_statements_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES users(id)
);

DO $$
DECLARE b record; a record; f int;
BEGIN
  SELECT count(*) INTO f FROM pg_constraint WHERE conrelid = 'public.transaction_statements'::regclass AND contype IN ('f','u');
  IF f <> 5 THEN RAISE EXCEPTION 'transaction_statements 제약 불일치(%/5) — 롤백', f; END IF;
  SELECT * INTO b FROM _ts_before;
  SELECT (SELECT count(*) FROM quotes) q_n, (SELECT md5(coalesce(string_agg(to_jsonb(q)::text, ',' ORDER BY q.id), '')) FROM quotes q) q_h,
         (SELECT count(*) FROM project_payments) pp_n, (SELECT md5(coalesce(string_agg(to_jsonb(p)::text, ',' ORDER BY p.id), '')) FROM project_payments p) pp_h INTO a;
  IF a.q_n <> b.q_n OR a.q_h <> b.q_h OR a.pp_n <> b.pp_n OR a.pp_h <> b.pp_h THEN RAISE EXCEPTION '견적·청구 데이터 변경 감지 — 롤백'; END IF;
  RAISE NOTICE '거래명세서 테이블 적용 완료 — 견적 %행·청구 %행 보존', a.q_n, a.pp_n;
END $$;
COMMIT;
