-- ─────────────────────────────────────────────────────────────────────────────
-- 수행정보 지급상태 3단계 통합 마이그레이션 (§12-2)
--   6단계(미지급·지급대기·지급예정·일부지급·지급완료·지급보류)
--     → 3단계(미지급·지급보류·지급완료)
--
-- 변환 규칙(무손실):
--   unpaid            → unpaid       (미지급, 유지)
--   payment_waiting   → unpaid       (지급대기  → 미지급)
--   payment_scheduled → unpaid       (지급예정  → 미지급)
--   partial           → unpaid       (일부지급  → 미지급)
--   payment_hold      → payment_hold (지급보류, 유지)
--   paid              → paid         (지급완료, 유지)
--
-- Postgres 네이티브 enum은 값 삭제가 불가하므로: ① 데이터 변환 → ② enum 타입 교체.
-- 전체를 단일 트랜잭션으로 실행하여 중단 시 자동 롤백. 실행 전 백업 권장.
--
-- 실행:  psql "$DATABASE_URL" -f scripts/consolidate-payment-status.sql
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── ① 데이터 변환 (enum이 아직 6값일 때 먼저 실행) ──────────────────────────────
UPDATE performance_assignments
   SET payment_status = 'unpaid'
 WHERE payment_status IN ('payment_waiting', 'payment_scheduled', 'partial');

-- ── ② enum 타입 교체 (6값 → 3값) ──────────────────────────────────────────────
-- 신규 3값 enum 생성
CREATE TYPE performance_payment_status_new AS ENUM ('unpaid', 'payment_hold', 'paid');

-- 컬럼 default 는 구 타입을 참조하므로 잠시 제거
ALTER TABLE performance_assignments
  ALTER COLUMN payment_status DROP DEFAULT;

-- 컬럼 타입을 신규 enum 으로 변환 (①에서 이미 변환되어 캐스팅 안전)
ALTER TABLE performance_assignments
  ALTER COLUMN payment_status TYPE performance_payment_status_new
  USING payment_status::text::performance_payment_status_new;

-- default 복원
ALTER TABLE performance_assignments
  ALTER COLUMN payment_status SET DEFAULT 'unpaid';

-- 구 타입 제거 후 신규 타입을 원래 이름으로 rename (스키마 정의와 일치)
DROP TYPE performance_payment_status;
ALTER TYPE performance_payment_status_new RENAME TO performance_payment_status;

COMMIT;

-- ── 검증(선택) — 실행 후 아래로 분포 확인 ──────────────────────────────────────
--   SELECT payment_status, count(*) FROM performance_assignments GROUP BY payment_status;
--   SELECT enum_range(NULL::performance_payment_status);   -- {unpaid,payment_hold,paid}
