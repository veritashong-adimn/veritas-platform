-- ─────────────────────────────────────────────────────────────────────────────
-- 비교견적 고도화(v2) — 컬럼 추가 전용 마이그레이션 (2026-11-09)
--
--  · 추가만 한다: 모든 컬럼 NULL 허용, DEFAULT 없음 → 기존 행 값은 전부 NULL 로 남는다(데이터 보정 없음).
--  · 기존 컬럼·인덱스·FK·제약은 변경/삭제하지 않는다. 다른 테이블은 건드리지 않는다.
--  · IF NOT EXISTS 로 재실행해도 안전(멱등). 트랜잭션으로 묶어 전부 적용 또는 전부 미적용.
--  · 적용 대상: 개발 DB 만. 운영 DB 적용은 별도 승인 후 진행.
--
--  comparison_quote_vendors (업체 Master)
--    contact_name    담당자명
--    logo_ref        업체 로고 — R2 비공개 내부 참조("r2cq:{key}?type=…"). 원본 URL 미저장/미노출
--    stamp_ref       업체 직인·서명 이미지 — 동일 방식
--    design_settings 업체별 견적서 디자인 설정(JSON: { accentColor, docTitle })
--
--  comparison_quotes (비교견적 — 생성 시점 스냅샷)
--    stamp_ref       직인·서명 스냅샷(로고는 기존 logo_url 컬럼에 같은 내부 참조로 보관)
--    issue_type      발행 구분: 'vendor_confirmed'(실제 업체 견적) | 'internal_simulation'(내부 비교용)
--                    NULL = 미지정(기존 데이터) → 화면/PDF 는 내부 비교용으로 취급, 값은 변경하지 않음
--    terms           견적 조건(JSON: validity, schedule, deliveryMethod, scope, revisionTerms, paymentTerms, otherNotes)
--    design_settings 디자인 설정 스냅샷(JSON)
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE comparison_quote_vendors ADD COLUMN IF NOT EXISTS contact_name    varchar(100);
ALTER TABLE comparison_quote_vendors ADD COLUMN IF NOT EXISTS logo_ref        text;
ALTER TABLE comparison_quote_vendors ADD COLUMN IF NOT EXISTS stamp_ref       text;
ALTER TABLE comparison_quote_vendors ADD COLUMN IF NOT EXISTS design_settings jsonb;

ALTER TABLE comparison_quotes ADD COLUMN IF NOT EXISTS stamp_ref       text;
ALTER TABLE comparison_quotes ADD COLUMN IF NOT EXISTS issue_type      varchar(30);
ALTER TABLE comparison_quotes ADD COLUMN IF NOT EXISTS terms           jsonb;
ALTER TABLE comparison_quotes ADD COLUMN IF NOT EXISTS design_settings jsonb;

COMMIT;
