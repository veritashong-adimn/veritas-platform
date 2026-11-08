import {
  pgTable, serial, integer, text, varchar, timestamp, boolean, date, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────────
// 회사 자료보관함(Company Archive) — 데이터 자산 하위 신규 모듈 전용 테이블 7개.
//  · 기존 테이블/enum 을 변경하지 않는다. users 는 FK 참조만 한다(onDelete: set null → 사용자 삭제와 무관하게 보존).
//  · 12개 하위 메뉴는 독립 저장소가 아니라 이 단일 저장소를 폴더(menuKey)·자료유형으로 분류 조회한다.
//  · 파일 실체는 R2 `archive/` 접두사에 저장하며, 서버의 권한검증 스트리밍 경로로만 제공한다.
//  · 원본(버전 파일) / 최신 승인본(approvedVersionId) / AI 검색용 텍스트(versions.extractedText, aiAllowed)를 분리한다.
// ─────────────────────────────────────────────────────────────────────────────

/** 폴더(분류) 트리 — 깊이 제한 없음(parentId 자기참조). 비활성화로 숨김, 삭제는 소프트 삭제(deletedAt)만 — 물리 삭제 금지. */
export const archiveFoldersTable = pgTable("archive_folders", {
  id: serial("id").primaryKey(),
  parentId: integer("parent_id"),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description"),
  /** 하위 메뉴 연결 키(forms|manuals|contracts|records|hr|management). 하위 폴더는 상위의 값을 상속. */
  menuKey: varchar("menu_key", { length: 30 }),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  isSystem: boolean("is_system").notNull().default(false),   // 기본 분류체계로 생성된 폴더
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  /** 소프트 삭제(복원 가능). 문서·하위 폴더가 없는 폴더만 삭제 가능. */
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by").references(() => usersTable.id, { onDelete: "set null" }),
}, (t) => [index("archive_folders_parent_idx").on(t.parentId)]);

/** 자료(문서) 메타데이터. 파일 자체는 버전 테이블에 있다. */
export const archiveDocumentsTable = pgTable("archive_documents", {
  id: serial("id").primaryKey(),
  folderId: integer("folder_id").notNull().references(() => archiveFoldersTable.id),
  title: text("title").notNull(),
  /** 자료 유형: general|form_template|form_issued|contract|manual|email|record|report|policy|other */
  docType: varchar("doc_type", { length: 30 }).notNull().default("general"),
  /** 서류양식: 발급·작성본이 어떤 표준양식에서 나왔는지 */
  templateDocumentId: integer("template_document_id"),
  isStandardForm: boolean("is_standard_form").notNull().default(false),
  description: text("description"),
  keywords: text("keywords"),
  authorName: text("author_name"),
  ownerDepartment: text("owner_department"),
  documentDate: date("document_date"),
  /** 보안등급: internal(사내일반)|restricted(제한)|confidential(기밀)|secret(극비) */
  securityLevel: varchar("security_level", { length: 20 }).notNull().default("restricted"),
  aiAllowed: boolean("ai_allowed").notNull().default(false),
  retentionUntil: date("retention_until"),
  expiresAt: date("expires_at"),
  requiresApproval: boolean("requires_approval").notNull().default(false),
  /** 상태: draft|in_review|approved|revised|discarded */
  status: varchar("status", { length: 20 }).notNull().default("draft"),
  currentVersionId: integer("current_version_id"),
  approvedVersionId: integer("approved_version_id"),
  /** AI(Phase 3) 처리 상태: none|extracted|empty|failed|skipped */
  aiStatus: varchar("ai_status", { length: 20 }).notNull().default("none"),
  aiSummary: text("ai_summary"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  // ── Soft Delete (휴지통) ──
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by"),
  deletionReason: text("deletion_reason"),
}, (t) => [
  index("archive_documents_folder_idx").on(t.folderId),
  index("archive_documents_status_idx").on(t.status),
]);

/** 버전(원본 파일). 승인된 버전은 덮어쓰지 않는다 — 변경은 항상 새 버전 행. */
export const archiveDocumentVersionsTable = pgTable("archive_document_versions", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => archiveDocumentsTable.id, { onDelete: "cascade" }),
  versionNo: integer("version_no").notNull(),
  storageKey: text("storage_key").notNull(),            // R2 key (archive/…). 클라이언트에 노출 금지.
  originalFileName: text("original_file_name").notNull(),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  sha256: varchar("sha256", { length: 64 }),
  /** AI·검색용 추출 텍스트(원본과 분리 보관) */
  extractedText: text("extracted_text"),
  extractMethod: varchar("extract_method", { length: 40 }),
  changeReason: text("change_reason"),
  /** 상태: draft|in_review|approved|rejected|superseded */
  status: varchar("status", { length: 20 }).notNull().default("draft"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  approvedBy: integer("approved_by").references(() => usersTable.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
}, (t) => [
  index("archive_versions_document_idx").on(t.documentId),
  index("archive_versions_sha_idx").on(t.sha256),
]);

/**
 * 접근권한(ACL). 폴더 또는 문서 단위. 상위 폴더 → 하위 폴더 → 문서로 상속.
 * 판정: 경로상 일치하는 deny 가 하나라도 있으면 차단 > allow > 기본 비공개.
 */
export const archiveAclTable = pgTable("archive_acl", {
  id: serial("id").primaryKey(),
  folderId: integer("folder_id").references(() => archiveFoldersTable.id, { onDelete: "cascade" }),
  documentId: integer("document_id").references(() => archiveDocumentsTable.id, { onDelete: "cascade" }),
  /** all_staff|role|department|user|no_inherit(문서 전용 표식: 폴더 권한 상속 해제) */
  subjectType: varchar("subject_type", { length: 20 }).notNull(),
  subjectId: integer("subject_id"),          // role → roles.id, user → users.id
  subjectValue: text("subject_value"),       // department → 부서명
  effect: varchar("effect", { length: 10 }).notNull().default("allow"),   // allow|deny
  actions: jsonb("actions").$type<string[]>().notNull(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("archive_acl_folder_idx").on(t.folderId),
  index("archive_acl_document_idx").on(t.documentId),
]);

/** 기존 업무 데이터 연결(참조만, 복사 없음). entityType: company|contact|inquiry|quote|project|translator|settlement|payment|user */
export const archiveLinksTable = pgTable("archive_links", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => archiveDocumentsTable.id, { onDelete: "cascade" }),
  entityType: varchar("entity_type", { length: 30 }).notNull(),
  entityId: integer("entity_id").notNull(),
  note: text("note"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("archive_links_uniq").on(t.documentId, t.entityType, t.entityId),
  index("archive_links_entity_idx").on(t.entityType, t.entityId),
]);

/** 승인 요청. 요청자는 자신의 요청을 승인할 수 없다(최고관리자 제외). AI 작성 여부 기록. */
export const archiveApprovalsTable = pgTable("archive_approvals", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => archiveDocumentsTable.id, { onDelete: "cascade" }),
  versionId: integer("version_id"),
  /** register|new_version|restore_version|acl_change|purge|share|ai_draft */
  requestType: varchar("request_type", { length: 30 }).notNull(),
  /** 변경 전후 내용 등 */
  payload: jsonb("payload"),
  reason: text("reason"),
  isAiAuthored: boolean("is_ai_authored").notNull().default(false),
  requestedBy: integer("requested_by").references(() => usersTable.id, { onDelete: "set null" }),
  requestedAt: timestamp("requested_at").notNull().defaultNow(),
  /** pending|approved|rejected|cancelled */
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  decidedBy: integer("decided_by").references(() => usersTable.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at"),
  decisionNote: text("decision_note"),
}, (t) => [
  index("archive_approvals_status_idx").on(t.status),
  index("archive_approvals_document_idx").on(t.documentId),
]);

/** 자료보관함 전용 감사로그 (기존 logs.entity_type enum 을 변경하지 않기 위해 분리). */
export const archiveAuditLogsTable = pgTable("archive_audit_logs", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id"),
  folderId: integer("folder_id"),
  versionId: integer("version_id"),
  action: varchar("action", { length: 40 }).notNull(),
  userId: integer("user_id"),
  userEmail: text("user_email"),
  actorType: varchar("actor_type", { length: 10 }).notNull().default("user"),   // user|ai
  metadata: jsonb("metadata"),
  ip: text("ip"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("archive_audit_document_idx").on(t.documentId),
  index("archive_audit_created_idx").on(t.createdAt),
]);

export type ArchiveFolder = typeof archiveFoldersTable.$inferSelect;
export type ArchiveDocument = typeof archiveDocumentsTable.$inferSelect;
export type ArchiveDocumentVersion = typeof archiveDocumentVersionsTable.$inferSelect;
export type ArchiveAcl = typeof archiveAclTable.$inferSelect;
export type ArchiveApproval = typeof archiveApprovalsTable.$inferSelect;
