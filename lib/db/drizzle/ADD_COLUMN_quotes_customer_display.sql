-- ─────────────────────────────────────────────────────────────────────────────
-- 견적서 거래처정보 편집 — 컬럼 추가 전용 마이그레이션 (2026-11-17)
--
--  · quotes.customer_display jsonb — 견적서별 수신처 표시 편집값 { fields, hidden }.
--  · NULL 허용, DEFAULT 없음 → 기존 견적은 NULL(출력 그대로). 데이터 보정 없음.
--  · 다른 컬럼·테이블은 건드리지 않는다. IF NOT EXISTS 로 재실행해도 안전.
--  · 적용 대상: 개발 DB 만. 운영 DB 적용은 별도 승인 후 진행.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
-- 잠금 대기 상한 — 다른 트랜잭션이 quotes 를 잡고 있으면 기다리지 않고 실패(재시도). 컬럼 추가 자체는 메타데이터만 변경.
SET LOCAL lock_timeout = '5s';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_display jsonb;
COMMIT;
