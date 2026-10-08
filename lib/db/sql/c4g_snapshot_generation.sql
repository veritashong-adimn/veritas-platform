-- C-4G Legacy Archive — 스냅샷 세대(Snapshot Generation) 모델 (targeted additive migration)
-- 대상: legacy_archive_rows (현재 0 rows), import_batches (기존 행 존재 — 他 모듈 공용)
-- 영향: 전부 additive. 기존 데이터/응답/他 모듈 무영향. FK 변경 없음. 되돌리기 가능.

-- 1) 행 단위 current/historical 플래그. 현재 0행이므로 NOT NULL DEFAULT true 안전.
ALTER TABLE legacy_archive_rows ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;

-- 2) source_type 별 최신 스냅샷 필터용 index.
CREATE INDEX IF NOT EXISTS idx_legacy_archive_rows_current ON legacy_archive_rows (source_type, is_current);

-- 3) import_batches 를 스냅샷 세대 기준으로 재사용(nullable → 기존 他 모듈 배치는 null, 영향 없음).
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS source_type varchar(20);
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS is_current boolean;

-- 되돌리기(필요 시):
--   ALTER TABLE import_batches DROP COLUMN IF EXISTS is_current;
--   ALTER TABLE import_batches DROP COLUMN IF EXISTS source_type;
--   DROP INDEX IF EXISTS idx_legacy_archive_rows_current;
--   ALTER TABLE legacy_archive_rows DROP COLUMN IF EXISTS is_current;
