-- ─────────────────────────────────────────────────────────────────────────────
-- 복수견적(대안 견적안) 그룹 — 컬럼 추가 전용 마이그레이션 (2026-11-20)
--
--  · 추가만 한다: NULL 허용, DEFAULT 없음 → 기존 행 값은 전부 NULL(복수견적 아님)로 남는다(데이터 보정 없음).
--  · 기존 컬럼·인덱스·FK·제약은 변경/삭제하지 않는다. 다른 테이블은 건드리지 않는다.
--  · IF NOT EXISTS 로 재실행해도 안전(멱등). 트랜잭션으로 묶어 전부 적용 또는 전부 미적용.
--  · 적용 대상: 개발 DB 만. 운영 DB 적용은 별도 승인 후 진행.
--
--  quotes.quote_group_id  복수견적 그룹 기준 견적(A안) id. 같은 값을 가진 견적들이 하나의 복수견적 그룹.
--                         그룹 내 동시에 판매확정되는 견적안은 1개만 허용(애플리케이션에서 검증).
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS quote_group_id integer;
CREATE INDEX IF NOT EXISTS quotes_quote_group_id_idx ON quotes (quote_group_id) WHERE quote_group_id IS NOT NULL;

COMMIT;
