-- C-4D Legacy Archive — Source Identity 전환 (targeted additive migration)
-- 대상: legacy_archive_rows (현재 0 rows → 즉시 적용, 데이터 재작성/락 위험 없음)
-- 영향: 이 테이블만. FK 변경 없음. 다른 테이블/Current Master 무관. 되돌리기 가능.
--
-- 의미:
--   · row_hash 는 CONTENT HASH(내용 지문)로 역할 축소 → UNIQUE 제거(파일 내부 동일행 보존을 위해).
--   · source identity = (file_hash + source_type + source_sheet + source_row) 로 재업로드 멱등.

ALTER TABLE legacy_archive_rows ADD COLUMN IF NOT EXISTS file_hash text;

-- row_hash UNIQUE 제거 → 파일 내부 동일내용·다른행이 공존 가능해야 함(C-4D 핵심).
DROP INDEX IF EXISTS uq_legacy_archive_rows_row_hash;

-- row_hash 는 검색/내용대조용 일반 index 로 유지.
CREATE INDEX IF NOT EXISTS idx_legacy_archive_rows_row_hash ON legacy_archive_rows (row_hash);

-- 재업로드(동일 파일) 멱등 기준 = source identity.
CREATE UNIQUE INDEX IF NOT EXISTS uq_legacy_archive_rows_source_identity
  ON legacy_archive_rows (file_hash, source_type, source_sheet, source_row);

-- 되돌리기(필요 시):
--   DROP INDEX IF EXISTS uq_legacy_archive_rows_source_identity;
--   DROP INDEX IF EXISTS idx_legacy_archive_rows_row_hash;
--   CREATE UNIQUE INDEX uq_legacy_archive_rows_row_hash ON legacy_archive_rows (row_hash);
--   ALTER TABLE legacy_archive_rows DROP COLUMN IF EXISTS file_hash;
