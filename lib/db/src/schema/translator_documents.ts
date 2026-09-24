import { pgTable, serial, integer, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────────
// 통번역사 서류(translator_documents) — 통번역사에게 제출받은 원본 서류의 영구보관 SSOT.
//  · [소유] translatorId = users.id (시스템 전체 통번역사 키. translator_sensitive.translatorId 와 동일 규약).
//    명세의 translatorProfileId 대신, 실제 API/데이터 규약인 userId 기준으로 FK 를 명확히 유지한다(§8).
//  · [저장소 재사용] 파일 실체는 기존 R2 오브젝트 저장소(objectStorage/presigned URL)에 저장하고,
//    이 테이블은 메타데이터만 보관한다. vendor_documents/project_files 와 동일 패턴(DB 에 binary 미저장).
//  · [별개 도메인] 기존 이력서(translator_profiles.resumeUrl)·신분증/통장사본(translator_sensitive)의
//    GCS 저장/AI 흐름은 그대로 두고 섞지 않는다. 이 테이블은 통합 「서류관리」 전용이다(추가서류·이력 보존).
//  · [이력 보존] 이력서를 새로 등록해도 과거 행을 덮어쓰지 않는다. 각 업로드가 개별 행으로 남는다(§6).
//  · [documentType] 이력서/신분증/통장사본/자격증/경력증명서/학위·졸업증명서/교육·수료증/NDA·보안서약서/
//    계약서/기타 등 선택형이되 varchar 로 두어 직접입력(자유값)도 허용한다.
//  · [soft-delete] 물리 삭제 금지. 통번역사/서류를 삭제하지 않는 한 서류가 임의로 사라지지 않는다(§7).
//  · [개인정보] 신분증 등 민감서류의 파일 URL 을 영구 public URL 로 만들지 않는다 — 다운로드는 인증된
//    presigned/스트리밍 경로만 사용한다(§7). 주민등록번호 등 원문은 이 테이블에 저장하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
export const translatorDocumentsTable = pgTable("translator_documents", {
  id: serial("id").primaryKey(),

  translatorId: integer("translator_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),

  // 문서 분류(선택형 + 직접입력 허용).
  documentType: varchar("document_type", { length: 50 }).notNull(),
  documentName: text("document_name"),          // 표시용 문서명(미입력 시 원본 파일명 사용)
  originalFileName: text("original_file_name").notNull(),
  filePath: text("file_path").notNull(),        // R2 objectPath (예: "/objects/uploads/{uuid}")
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  memo: text("memo"),

  uploadedBy: integer("uploaded_by").references(() => usersTable.id, { onDelete: "set null" }),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),

  // ── Soft Delete (휴지통) ────────────────────────────────
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by"),
  deletionReason: text("deletion_reason"),
});

export type TranslatorDocument = typeof translatorDocumentsTable.$inferSelect;
export type InsertTranslatorDocument = typeof translatorDocumentsTable.$inferInsert;
