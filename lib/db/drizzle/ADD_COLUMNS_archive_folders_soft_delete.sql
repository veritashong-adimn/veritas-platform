-- 회사 자료보관함 — 폴더 소프트 삭제(복원 가능한 삭제) 컬럼 (2026-11-08, 개발 DB 적용 완료)
-- 기존 행은 NULL(미삭제) 유지. 신규 테이블 없음. 운영 적용 시 이 파일만 개별 실행할 것.
-- ⚠ 전체 `drizzle-kit push` 금지: 스키마에 선언되지 않은 quote_number_seq / inquiry_number_seq 를 DROP 한다.
ALTER TABLE "archive_folders" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
ALTER TABLE "archive_folders" ADD COLUMN IF NOT EXISTS "deleted_by" integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'archive_folders_deleted_by_users_id_fk') THEN
    ALTER TABLE "archive_folders" ADD CONSTRAINT "archive_folders_deleted_by_users_id_fk"
      FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
