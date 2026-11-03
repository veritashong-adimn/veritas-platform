/**
 * 회사 자료보관함 — 접근권한 판정(단일 진입점).
 *
 * 모든 목록·검색·상세·파일·AI 검색 API 는 이 모듈의 판정 함수를 거친다(서버 측 강제).
 *
 * 판정 규칙
 *  1. 고객·통번역사 계정(admin/staff 외)은 무조건 차단.
 *  2. 모듈 권한: menu.archive 필요. 최고관리자(admin + roleId 없음)는 RBAC 규칙상 전체 통과.
 *  3. archive.admin 보유자(및 최고관리자)는 모든 자료 전체 권한.
 *  4. 그 외: 문서 ACL + 소속 폴더 → 상위 폴더 ACL 을 모두 모아 (문서에 no_inherit 표식이 있으면 폴더 상속 해제)
 *       · 일치하는 deny 가 하나라도 있으면 해당 동작 차단 (명시 차단 우선)
 *       · 아니면 일치하는 allow 가 있으면 허용
 *       · 아무것도 없으면 차단 (기본 비공개)
 *  5. 등록자 본인은 자신의 자료에 대해 열람·수정 계열 권한을 가진다(명시 deny 는 여전히 우선).
 *  6. 승인본이 없는 초안/검토중 자료는 열람권자라도 수정권자·등록자·승인권자에게만 보인다.
 *     일반 열람자는 '최신 승인 버전'만 받는다.
 */
import type { Request } from "express";
import {
  db, usersTable, archiveFoldersTable, archiveAclTable, archiveAuditLogsTable,
  type ArchiveDocument, type ArchiveAcl,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { getPermissionsForRole } from "../lib/rbac";

export const ARCHIVE_ACTIONS = [
  "view",      // 목록·검색·상세 메타 열람
  "preview",   // 미리보기
  "download",  // 원본 다운로드
  "print",     // 인쇄
  "upload",    // (폴더) 자료 등록
  "edit",      // 메타 수정·새 버전 등록·이동
  "delete",    // 소프트 삭제
  "restore",   // 휴지통 복원
  "share",     // 외부 공유(요청)
  "ai",        // AI 검색·활용
  "manage",    // 권한 설정
] as const;
export type ArchiveAction = (typeof ARCHIVE_ACTIONS)[number];

const OWNER_ACTIONS: ArchiveAction[] = ["view", "preview", "download", "print", "edit", "delete"];

export interface ArchiveActor {
  id: number;
  email: string;
  role: string;
  roleId: number | null;
  department: string | null;
  isSuper: boolean;
  hasModule: boolean;
  isArchiveAdmin: boolean;
  canUpload: boolean;
  canApprove: boolean;
  canPurge: boolean;
}

/** 요청 사용자 → 자료보관함 행위자. 모듈 접근 불가여도 객체는 반환(hasModule=false). */
export async function loadArchiveActor(req: Request): Promise<ArchiveActor> {
  const u = req.user!;
  const staffLike = u.role === "admin" || u.role === "staff";
  const isSuper = u.role === "admin" && !u.roleId;
  let perms = new Set<string>();
  if (u.roleId) perms = await getPermissionsForRole(u.roleId);
  const [row] = await db.select({ department: usersTable.department, isActive: usersTable.isActive, deletedAt: usersTable.deletedAt })
    .from(usersTable).where(eq(usersTable.id, u.id)).limit(1);
  const alive = !!row && row.isActive && !row.deletedAt;
  const has = (k: string) => isSuper || perms.has(k);
  const hasModule = staffLike && alive && has("menu.archive");
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    roleId: u.roleId ?? null,
    department: row?.department?.trim() || null,
    isSuper,
    hasModule,
    isArchiveAdmin: hasModule && has("archive.admin"),
    canUpload: hasModule && has("archive.upload"),
    canApprove: hasModule && has("archive.approve"),
    canPurge: hasModule && has("archive.purge"),
  };
}

// ─── ACL 컨텍스트 (요청당 1회 로드: 폴더 트리 + ACL 전체) ─────────────────────

export interface FolderNode { id: number; parentId: number | null; name: string; menuKey: string | null; isActive: boolean; sortOrder: number }

export interface AclContext {
  folders: Map<number, FolderNode>;
  folderAcl: Map<number, ArchiveAcl[]>;
  docAcl: Map<number, ArchiveAcl[]>;
}

export async function loadAclContext(): Promise<AclContext> {
  const [folders, acl] = await Promise.all([
    db.select({
      id: archiveFoldersTable.id, parentId: archiveFoldersTable.parentId, name: archiveFoldersTable.name,
      menuKey: archiveFoldersTable.menuKey, isActive: archiveFoldersTable.isActive, sortOrder: archiveFoldersTable.sortOrder,
    }).from(archiveFoldersTable),
    db.select().from(archiveAclTable),
  ]);
  const ctx: AclContext = { folders: new Map(), folderAcl: new Map(), docAcl: new Map() };
  for (const f of folders) ctx.folders.set(f.id, f);
  for (const a of acl) {
    if (a.documentId) push(ctx.docAcl, a.documentId, a);
    else if (a.folderId) push(ctx.folderAcl, a.folderId, a);
  }
  return ctx;
}
function push<K, V>(m: Map<K, V[]>, k: K, v: V) { const arr = m.get(k); if (arr) arr.push(v); else m.set(k, [v]); }

/** 폴더 → 루트까지 조상 id 목록(자기 포함, 순환 방지). */
export function folderChain(ctx: AclContext, folderId: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  let cur: number | null = folderId;
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = ctx.folders.get(cur)?.parentId ?? null;
  }
  return out;
}

/** 폴더가 속한 하위 메뉴 키(가장 가까운 조상의 menuKey). */
export function folderMenuKey(ctx: AclContext, folderId: number): string | null {
  for (const id of folderChain(ctx, folderId)) {
    const k = ctx.folders.get(id)?.menuKey;
    if (k) return k;
  }
  return null;
}

/** 폴더 경로 표시용 ("회사 경영·관리 / 재무·회계·세무") */
export function folderPath(ctx: AclContext, folderId: number): string {
  return folderChain(ctx, folderId).reverse().map(id => ctx.folders.get(id)?.name ?? "?").join(" / ");
}

/** 폴더 + 모든 하위 폴더 id */
export function folderDescendants(ctx: AclContext, rootId: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const f of ctx.folders.values()) if (f.parentId != null) push(children, f.parentId, f.id);
  const out = new Set<number>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return out;
}

function entryMatches(e: ArchiveAcl, actor: ArchiveActor): boolean {
  switch (e.subjectType) {
    case "all_staff": return true;
    case "role": return actor.roleId != null && e.subjectId === actor.roleId;
    case "user": return e.subjectId === actor.id;
    case "department":
      return !!actor.department && !!e.subjectValue && e.subjectValue.trim() === actor.department;
    default: return false;
  }
}

function resolve(actor: ArchiveActor, entries: ArchiveAcl[], ownerExtra: ArchiveAction[]): Set<ArchiveAction> {
  if (!actor.hasModule) return new Set();
  if (actor.isArchiveAdmin) return new Set(ARCHIVE_ACTIONS);
  const allow = new Set<string>(ownerExtra);
  const deny = new Set<string>();
  for (const e of entries) {
    if (!entryMatches(e, actor)) continue;
    const acts = Array.isArray(e.actions) ? e.actions : [];
    for (const a of acts) (e.effect === "deny" ? deny : allow).add(a);
  }
  const out = new Set<ArchiveAction>();
  for (const a of ARCHIVE_ACTIONS) if (allow.has(a) && !deny.has(a)) out.add(a);
  if (!actor.canUpload) out.delete("upload");
  return out;
}

/** 폴더에 대한 유효 권한(상위 폴더 상속). */
export function folderActions(actor: ArchiveActor, ctx: AclContext, folderId: number): Set<ArchiveAction> {
  const entries = folderChain(ctx, folderId).flatMap(id => ctx.folderAcl.get(id) ?? []);
  return resolve(actor, entries, []);
}

/** 문서에 대한 유효 권한(문서 예외 + 폴더 상속 + 등록자). */
export function documentActions(
  actor: ArchiveActor, ctx: AclContext,
  doc: Pick<ArchiveDocument, "id" | "folderId" | "createdBy">,
): Set<ArchiveAction> {
  const own = ctx.docAcl.get(doc.id) ?? [];
  // 문서에 no_inherit 표식이 있으면 폴더 상속을 끊는다(비공개·개별 지정 문서)
  const inherit = !own.some(e => e.subjectType === "no_inherit");
  const entries = [
    ...own,
    ...(inherit ? folderChain(ctx, doc.folderId).flatMap(id => ctx.folderAcl.get(id) ?? []) : []),
  ];
  return resolve(actor, entries, doc.createdBy === actor.id ? OWNER_ACTIONS : []);
}

/** 승인 전 버전(초안·검토중)까지 볼 수 있는 사람인가 */
export function canSeeUnapproved(actor: ArchiveActor, acts: Set<ArchiveAction>, doc: Pick<ArchiveDocument, "createdBy">): boolean {
  return actor.isArchiveAdmin || actor.canApprove || acts.has("edit") || doc.createdBy === actor.id;
}

/** 목록·검색·상세에 노출 가능한가 (삭제 자료 제외) */
export function canListDocument(
  actor: ArchiveActor, acts: Set<ArchiveAction>,
  doc: Pick<ArchiveDocument, "createdBy" | "approvedVersionId" | "deletedAt">,
): boolean {
  if (doc.deletedAt) return false;
  if (!acts.has("view")) return false;
  if (doc.approvedVersionId) return true;
  return canSeeUnapproved(actor, acts, doc);
}

/**
 * AI 검색·활용 대상인가 — 요청자 권한 + 문서의 AI 허용 + 승인본 존재 + 폐기·삭제 아님.
 * 초안·폐기 자료는 확정 규정처럼 활용되지 않도록 제외한다.
 */
export function canUseForAi(
  acts: Set<ArchiveAction>,
  doc: Pick<ArchiveDocument, "aiAllowed" | "approvedVersionId" | "status" | "deletedAt">,
): boolean {
  return acts.has("ai") && acts.has("view") && doc.aiAllowed && !!doc.approvedVersionId
    && doc.status !== "discarded" && !doc.deletedAt;
}

// ─── 감사로그 ────────────────────────────────────────────────────────────────

export async function archiveAudit(
  req: Request,
  action: string,
  target: { documentId?: number | null; folderId?: number | null; versionId?: number | null },
  metadata?: Record<string, unknown>,
  actorType: "user" | "ai" = "user",
): Promise<void> {
  try {
    await db.insert(archiveAuditLogsTable).values({
      documentId: target.documentId ?? null,
      folderId: target.folderId ?? null,
      versionId: target.versionId ?? null,
      action,
      userId: req.user?.id ?? null,
      userEmail: req.user?.email ?? null,
      actorType,
      metadata: metadata ?? null,
      ip: (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.ip || null,
    });
  } catch (err) {
    req.log?.error({ err, action }, "[archive] audit log failed");
  }
}

export function sanitizeActions(input: unknown): ArchiveAction[] {
  if (!Array.isArray(input)) return [];
  const set = new Set(ARCHIVE_ACTIONS as readonly string[]);
  return [...new Set(input.filter((a): a is ArchiveAction => typeof a === "string" && set.has(a)))];
}
