import { pgTable, serial, integer, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { companyVendorProfilesTable } from "./company_vendor_profiles";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────────
// 외주업체 서류(vendor_documents) — 회사(외주업체 역할)에 연결되는 각종 보관 서류.
//  · [SSOT] 문서는 회사(company) 기준으로 보관한다. companyId 는 필수(§12) — 외주역할이 나중에
//    비활성/변경돼도 서류가 사라지지 않고 회사 상세에서 계속 조회된다.
//  · [profile 연결] vendorProfileId 는 알 때만 연결(nullable). company_vendor_profiles 가
//    soft-delete 되어도(물리삭제 금지) FK 는 유효하게 유지된다.
//  · [저장소 재사용] 파일 실체는 기존 R2 오브젝트 저장소(objectStorage/presigned URL)에 저장하고,
//    이 테이블은 메타데이터만 보관한다. project_files 와 동일한 패턴(§4 "중복 저장소 금지").
//  · [documentType] 계약서/견적서/회사소개서/인증·허가서/보험서류/보안·NDA/기타 등 선택형이되,
//    varchar 로 두어 직접입력(자유값)도 허용한다 — 목록으로 강제 제한하지 않는다.
//  · [soft-delete] companies/quotes 와 동일한 삭제 패턴. 회사/외주업체를 삭제하지 않는 한
//    서류가 임의로 사라지지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
export const vendorDocumentsTable = pgTable("vendor_documents", {
  id: serial("id").primaryKey(),

  // 식별: 회사 필수 + 외주 프로필(선택)
  companyId: integer("company_id")
    .notNull()
    .references(() => companiesTable.id, { onDelete: "cascade" }),
  vendorProfileId: integer("vendor_profile_id")
    .references(() => companyVendorProfilesTable.id, { onDelete: "set null" }),

  // 문서 분류(선택형 + 직접입력 허용). 예: 계약서 | 견적서 | 회사소개서 | 인증/허가서 | 보험서류 | 보안/NDA | 기타
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

export type VendorDocument = typeof vendorDocumentsTable.$inferSelect;
export type InsertVendorDocument = typeof vendorDocumentsTable.$inferInsert;
