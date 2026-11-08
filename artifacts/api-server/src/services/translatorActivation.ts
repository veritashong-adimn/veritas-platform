// ─── 수행정보 통번역사 검색 대상 · 배정 시 자동 활성화 ──────────────────────────
// 판매관리 → 수행정보 통번역사 검색(view=picker)과 수행정보 저장(PUT /admin/projects/:id/performances)에서만 사용한다.
//
// 검색 대상(isPickerEligible)
//  - 활성 인원: 기존 정책 그대로 모두 대상.
//  - 비활성 인원: 과거 CRM 이관(legacy_migrated)·초대 대기 등 등록 인원은 대상.
//    단 '삭제·제외' 인원은 제외 — ① 운영상태 excluded ② 휴지통 삭제(최신 활성/비활성 감사로그가 deactivated).
//    (deleted_at 소프트삭제 인원은 목록 API 조회 조건에서 이미 제외된다)
//
// 자동 활성화(activateTranslatorOnAssignment)
//  - 검색·상세 열람이 아니라 수행정보 '저장'이 성공하는 트랜잭션 안에서만 실행 → 저장 실패 시 함께 롤백.
//  - 기존 수동 활성화(PATCH /admin/translators/:id/activate)와 같은 상태 변경: users.is_active=true, 가용상태 available.
//    운영상태(legacy_migrated 등)는 출처 표시이므로 변경하지 않는다(수동 활성화와 동일).
//  - 감사로그(logs, action=activated)에 이전·이후 상태, 처리자, 판매건·수행정보 ID 기록. 이름·연락처·주민번호 미기록.
import { usersTable, translatorProfilesTable, logsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

type Dbx = any; // db 또는 트랜잭션(tx)

/** 휴지통 '삭제'(비활성 처리) 상태인 통번역사 id — 활성/비활성 감사로그 중 가장 최근이 deactivated */
export async function loadTrashDeactivatedIds(dbx: Dbx, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows: Array<{ eid: number; action: string; at: Date; lid: number }> = await dbx
    .select({ eid: logsTable.entityId, action: logsTable.action, at: logsTable.createdAt, lid: logsTable.id })
    .from(logsTable)
    .where(and(eq(logsTable.entityType, "translator"), inArray(logsTable.entityId, ids), inArray(logsTable.action, ["deactivated", "activated"])));
  const latest = new Map<number, { action: string; at: number; lid: number }>();
  for (const r of rows) {
    const at = new Date(r.at).getTime();
    const cur = latest.get(r.eid);
    if (!cur || at > cur.at || (at === cur.at && r.lid > cur.lid)) latest.set(r.eid, { action: r.action, at, lid: r.lid });
  }
  return new Set([...latest].filter(([, v]) => v.action === "deactivated").map(([id]) => id));
}

/** 수행정보 통번역사 검색 대상 여부 */
export function isPickerEligible(
  row: { id: number; isActive: boolean | null; operationalStatus: string | null },
  trashDeactivated: Set<number>,
): boolean {
  if (row.isActive) return true;                              // 활성 인원 — 기존 정책 유지
  if (row.operationalStatus === "excluded") return false;     // 제외 처리
  return !trashDeactivated.has(row.id);                       // 휴지통 삭제 제외
}

/**
 * 수행정보 저장 트랜잭션 안에서 비활성 통번역사를 활성화한다. 활성화했으면 true.
 * 이미 활성·삭제·제외·휴지통 삭제 인원, 통번역사가 아닌 id 는 변경하지 않는다(false).
 */
export async function activateTranslatorOnAssignment(
  tx: Dbx,
  translatorId: number,
  ctx: { projectId: number; assignmentId: number; performedBy: number | null; performedByEmail: string | null },
): Promise<boolean> {
  const [u] = await tx.select({ id: usersTable.id, role: usersTable.role, isActive: usersTable.isActive, deletedAt: usersTable.deletedAt })
    .from(usersTable).where(eq(usersTable.id, translatorId));
  if (!u || u.role !== "translator" || u.deletedAt || u.isActive) return false;
  const [p] = await tx.select({ operationalStatus: translatorProfilesTable.operationalStatus, availabilityStatus: translatorProfilesTable.availabilityStatus })
    .from(translatorProfilesTable).where(eq(translatorProfilesTable.userId, translatorId));
  const trash = await loadTrashDeactivatedIds(tx, [translatorId]);
  if (!isPickerEligible({ id: translatorId, isActive: false, operationalStatus: p?.operationalStatus ?? null }, trash)) return false;

  // 조건부 갱신(is_active=false 일 때만) — 동시 저장 시 중복 활성화·중복 로그 방지
  const updated = await tx.update(usersTable)
    .set({ isActive: true })
    .where(and(eq(usersTable.id, translatorId), eq(usersTable.isActive, false)))
    .returning({ id: usersTable.id });
  if (updated.length === 0) return false;
  if (p) {
    await tx.update(translatorProfilesTable)
      .set({ availabilityStatus: "available", updatedAt: new Date() })
      .where(eq(translatorProfilesTable.userId, translatorId));
  }
  await tx.insert(logsTable).values({
    entityType: "translator",
    entityId: translatorId,
    action: "activated",
    performedBy: ctx.performedBy,
    performedByEmail: ctx.performedByEmail,
    metadata: JSON.stringify({
      trigger: "performance_assignment",          // 수행정보 배정 저장에 따른 자동 활성화
      projectId: ctx.projectId,
      performanceAssignmentId: ctx.assignmentId,
      before: { isActive: false, availabilityStatus: p?.availabilityStatus ?? null, operationalStatus: p?.operationalStatus ?? null },
      after: { isActive: true, availabilityStatus: p ? "available" : null, operationalStatus: p?.operationalStatus ?? null },
    }),
  });
  return true;
}
