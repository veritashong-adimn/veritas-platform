-- C-4I-b Legacy Archive — Effective Version Layer (targeted additive migration)
-- 대상: legacy_archive_rows (현재 0 rows). 전부 additive. 기존 컬럼/他 테이블/Current Master·Sales 무영향. FK 없음.
-- 의미: is_current(C-4G 스냅샷 provenance)와 별개의 is_effective(업무 최신 유효 version). 과거 version 은 삭제 없이 보존.

ALTER TABLE legacy_archive_rows ADD COLUMN IF NOT EXISTS match_status varchar(20);
ALTER TABLE legacy_archive_rows ADD COLUMN IF NOT EXISTS is_effective boolean NOT NULL DEFAULT true;
ALTER TABLE legacy_archive_rows ADD COLUMN IF NOT EXISTS superseded_by_id integer;      -- 논리 포인터(FK 아님)
ALTER TABLE legacy_archive_rows ADD COLUMN IF NOT EXISTS logical_group_key text;        -- version chain key(내부 UUID)
ALTER TABLE legacy_archive_rows ADD COLUMN IF NOT EXISTS effective_version integer;

CREATE INDEX IF NOT EXISTS idx_legacy_archive_rows_effective ON legacy_archive_rows (source_type, is_effective);
CREATE INDEX IF NOT EXISTS idx_legacy_archive_rows_logical_group ON legacy_archive_rows (logical_group_key);

-- 되돌리기(필요 시):
--   DROP INDEX IF EXISTS idx_legacy_archive_rows_logical_group;
--   DROP INDEX IF EXISTS idx_legacy_archive_rows_effective;
--   ALTER TABLE legacy_archive_rows DROP COLUMN IF EXISTS effective_version;
--   ALTER TABLE legacy_archive_rows DROP COLUMN IF EXISTS logical_group_key;
--   ALTER TABLE legacy_archive_rows DROP COLUMN IF EXISTS superseded_by_id;
--   ALTER TABLE legacy_archive_rows DROP COLUMN IF EXISTS is_effective;
--   ALTER TABLE legacy_archive_rows DROP COLUMN IF EXISTS match_status;
