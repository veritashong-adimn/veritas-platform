-- =====================================================================
-- PROD 테스트 데이터 진단 (READ-ONLY, 절대 쓰기 없음)
-- 실행:  psql "$PROD_DATABASE_URL" -f scripts/prod_readonly_diagnose.sql -o scripts/prod_diag_out.txt
--   · 접속 문자열은 env 참조만 (화면/로그 노출 금지)
--   · 아래 트랜잭션은 READ ONLY 라 DELETE/UPDATE/INSERT 시 에러로 즉시 중단됨
-- =====================================================================
\pset pager off
\pset footer off
BEGIN;
SET TRANSACTION READ ONLY;

\echo '################ [0] DB 식별 (which database am I on?) ################'
SELECT current_database() AS db, current_user AS usr, inet_server_addr() AS host, version();

\echo ''
\echo '################ [1] 테스트 회사 식별 ################'
SELECT id, name, company_type, billing_type, customer_type,
       deleted_at, created_at
FROM companies
WHERE name IN ('모바일테스트주식회사','글로벌링크 코퍼레이션','베리타스코 주식회사')
ORDER BY id;

\echo ''
\echo '-- (참고) 유사/오타 대비: 부분일치 스캔 --'
SELECT id, name, deleted_at FROM companies
WHERE name LIKE '%테스트%' OR name LIKE '%글로벌링크%' OR name LIKE '%베리타스%'
ORDER BY id;

\echo ''
\echo '################ [2] 위 회사들을 참조하는 모든 자식 레코드 건수 ################'
\echo '-- 회사 삭제 안전성 판단용. company_id 로 직접 연결된 테이블 전수 카운트 --'
WITH tc AS (
  SELECT id FROM companies
  WHERE name IN ('모바일테스트주식회사','글로벌링크 코퍼레이션','베리타스코 주식회사')
)
SELECT 'contacts'              AS child_table, count(*) FROM contacts              WHERE company_id IN (SELECT id FROM tc)
UNION ALL SELECT 'divisions',              count(*) FROM divisions              WHERE company_id IN (SELECT id FROM tc)
UNION ALL SELECT 'company_aliases',        count(*) FROM company_aliases        WHERE company_id IN (SELECT id FROM tc)
UNION ALL SELECT 'company_name_history',   count(*) FROM company_name_history   WHERE company_id IN (SELECT id FROM tc)
UNION ALL SELECT 'company_sensitive',      count(*) FROM company_sensitive      WHERE company_id IN (SELECT id FROM tc)
UNION ALL SELECT 'quotes(company_id)',     count(*) FROM quotes                 WHERE company_id IN (SELECT id FROM tc)
UNION ALL SELECT 'billing_batches',        count(*) FROM billing_batches        WHERE company_id IN (SELECT id FROM tc)
UNION ALL SELECT 'prepaid_accounts',       count(*) FROM prepaid_accounts       WHERE company_id IN (SELECT id FROM tc)
UNION ALL SELECT 'project_payments(billing_company_id)', count(*) FROM project_payments WHERE billing_company_id IN (SELECT id FROM tc)
UNION ALL SELECT 'projects(company_id, no-FK)',          count(*) FROM projects  WHERE company_id IN (SELECT id FROM tc)
UNION ALL SELECT 'projects(requesting_company_id)',      count(*) FROM projects  WHERE requesting_company_id IN (SELECT id FROM tc)
UNION ALL SELECT 'projects(billing_company_id)',         count(*) FROM projects  WHERE billing_company_id IN (SELECT id FROM tc)
UNION ALL SELECT 'projects(payer_company_id)',           count(*) FROM projects  WHERE payer_company_id IN (SELECT id FROM tc)
ORDER BY 1;

\echo ''
\echo '################ [3] 누적청구 billing_batches #2~#5 ################'
SELECT b.id, b.company_id, c.name AS company_name, b.status,
       b.total_amount, b.quote_id, b.period_start, b.period_end, b.created_at,
       (SELECT count(*) FROM billing_batch_items      i WHERE i.batch_id = b.id) AS item_cnt,
       (SELECT count(*) FROM billing_batch_work_items w WHERE w.batch_id = b.id) AS work_item_cnt
FROM billing_batches b
LEFT JOIN companies c ON c.id = b.company_id
WHERE b.id IN (2,3,4,5)
ORDER BY b.id;

\echo ''
\echo '-- 3-1) 해당 배치의 billing_batch_items (project/quote 연결 확인) --'
SELECT id, batch_id, project_id, quote_id, amount, service_name, created_at
FROM billing_batch_items
WHERE batch_id IN (2,3,4,5)
ORDER BY batch_id, id;

\echo ''
\echo '-- 3-2) 해당 배치의 billing_batch_work_items --'
SELECT id, batch_id, sort_order, work_date, project_name, language, amount
FROM billing_batch_work_items
WHERE batch_id IN (2,3,4,5)
ORDER BY batch_id, id;

\echo ''
\echo '-- 3-3) items 가 가리키는 projects 가 실데이터인지 확인 --'
SELECT DISTINCT p.id AS project_id, p.title, p.status, p.company_id, p.created_at
FROM projects p
WHERE p.id IN (SELECT project_id FROM billing_batch_items WHERE batch_id IN (2,3,4,5))
ORDER BY p.id;

\echo ''
\echo '################ [4] 선입금 prepaid_accounts (5,000,000 / 50,000,000) ################'
SELECT a.id, a.company_id, c.name AS company_name, a.initial_amount,
       a.current_balance, a.status, a.deposit_date, a.note, a.created_at,
       (SELECT count(*) FROM prepaid_ledger l WHERE l.account_id = a.id) AS ledger_cnt
FROM prepaid_accounts a
LEFT JOIN companies c ON c.id = a.company_id
WHERE a.initial_amount IN (5000000, 50000000)
   OR a.current_balance IN (5000000, 50000000)
ORDER BY a.id;

\echo ''
\echo '-- 4-1) (참고) 테스트 회사에 속한 모든 선입금 계정 --'
SELECT a.id, a.company_id, c.name AS company_name, a.initial_amount, a.current_balance, a.status
FROM prepaid_accounts a
LEFT JOIN companies c ON c.id = a.company_id
WHERE a.company_id IN (
  SELECT id FROM companies
  WHERE name IN ('모바일테스트주식회사','글로벌링크 코퍼레이션','베리타스코 주식회사')
)
ORDER BY a.id;

\echo ''
\echo '-- 4-2) 위 선입금 계정들의 prepaid_ledger 원장 --'
SELECT l.id, l.account_id, l.project_id, l.quote_id, l.type, l.status,
       l.amount, l.balance_before, l.balance_after, l.transaction_date, l.description
FROM prepaid_ledger l
WHERE l.account_id IN (
  SELECT id FROM prepaid_accounts
  WHERE initial_amount IN (5000000,50000000) OR current_balance IN (5000000,50000000)
)
ORDER BY l.account_id, l.id;

\echo ''
\echo '################ [5] project_payments / payment_transactions 연관성 ################'
\echo '-- 5-1) 테스트 회사로 청구된 project_payments (있다면 별도 판단 필요) --'
SELECT pp.id, pp.project_id, pp.billing_company_id, c.name AS billing_company,
       pp.amount, pp.deposit_status, pp.payment_category, pp.created_at,
       (SELECT count(*) FROM payment_transactions t WHERE t.project_payment_id = pp.id) AS txn_cnt
FROM project_payments pp
LEFT JOIN companies c ON c.id = pp.billing_company_id
WHERE pp.billing_company_id IN (
  SELECT id FROM companies
  WHERE name IN ('모바일테스트주식회사','글로벌링크 코퍼레이션','베리타스코 주식회사')
)
ORDER BY pp.id;

\echo ''
\echo '-- 5-2) 위 배치 items 가 가리키는 project 들의 project_payments (프로젝트 경유 연결) --'
SELECT pp.id, pp.project_id, pp.billing_company_id, pp.amount, pp.deposit_status
FROM project_payments pp
WHERE pp.project_id IN (SELECT project_id FROM billing_batch_items WHERE batch_id IN (2,3,4,5))
ORDER BY pp.id;

\echo ''
\echo '################ [6] 전체 규모 대조 (테스트 vs 실데이터 감 잡기) ################'
SELECT 'companies(전체)' AS t, count(*) FROM companies
UNION ALL SELECT 'companies(soft-deleted)', count(*) FROM companies WHERE deleted_at IS NOT NULL
UNION ALL SELECT 'billing_batches(전체)', count(*) FROM billing_batches
UNION ALL SELECT 'prepaid_accounts(전체)', count(*) FROM prepaid_accounts
UNION ALL SELECT 'projects(전체)', count(*) FROM projects
UNION ALL SELECT 'project_payments(전체)', count(*) FROM project_payments
ORDER BY 1;

ROLLBACK;
\echo ''
\echo '################ DONE (read-only, rolled back) ################'
