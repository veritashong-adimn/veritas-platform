// 통번역사 수동 통합 "실행" 엔진 — 단일 트랜잭션·실패 시 전체 롤백(§12). DRY-RUN 기본(§13).
//  · 물리삭제 금지(§10): mergedMaster 는 soft-exclude(users.deleted_at + operational_status='merged')로 운영목록/선택창 제외.
//  · 과거 이력 귀속(§7): tasks/settlements/performance_assignments/payout(payee_id)/legacy_master_mappings 를 대표로 재지정.
//  · 진행관리표 원본(legacy_archive_rows)은 변경하지 않는다(§8·§9) — 이름만 일치 이력은 자동 귀속하지 않음.
//  · 모든 재지정의 before/after 를 translator_merge_audit 에 기록 → 영구매핑(translator_merges)과 함께 복구 근거(§11).
//  · dbx 주입형(운영 db 또는 격리 테스트 db) — 동일 로직으로 격리환경 검증(§15) 가능.
import { sql } from "drizzle-orm";
import { buildMergePreview } from "./translatorMerge";

type Dbx = any;
const rows = (q: any) => (q as any).rows as any[];
const n = (v: any) => Number(v ?? 0);

export interface MergeExecuteParams {
  masterIds: number[];
  representativeId: number;
  samePersonConfirmed: boolean;   // §6 대표의 동일인 확인 체크
  confirmToken?: string;          // 최종 승인 토큰(commit 시 필수)
  performedBy?: number | null;
  commit: boolean;                // false=DRY-RUN
  note?: string;
}

// 재지정 대상 정의(권위 목록 — masterDependency 와 일치). extra 는 soft-link 조건.
const REPOINTS: { table: string; field: string; extra: string }[] = [
  { table: "tasks", field: "translator_id", extra: "" },
  { table: "settlements", field: "translator_id", extra: "" },
  { table: "performance_assignments", field: "individual_user_id", extra: "" },
  { table: "payout_round_items", field: "payee_id", extra: "AND payee_type='individual'" },
  { table: "payout_transfers", field: "payee_id", extra: "AND payee_type='individual'" },
  { table: "legacy_master_mappings", field: "entity_id", extra: "AND entity_type='translator' AND status<>'rolled_back'" },
];

export function expectedConfirmToken(representativeId: number, mergedIds: number[]): string {
  return `MERGE:${representativeId}:${[...mergedIds].sort((a, b) => a - b).join(",")}`;
}

// 통합 전후 불변식(전역 집계) — 재지정은 소유자만 바꾸므로 건수·금액 총합은 불변이어야 한다(§9).
async function invariants(dbx: Dbx) {
  const one = async (q: any) => n(rows(await dbx.execute(q))[0]?.v);
  return {
    tasks: await one(sql`SELECT count(*) v FROM tasks`),
    settlementCnt: await one(sql`SELECT count(*) v FROM settlements`),
    settlementSum: await one(sql`SELECT coalesce(sum(translator_amount),0) v FROM settlements`),
    transferCnt: await one(sql`SELECT count(*) v FROM payout_transfers`),
    transferSum: await one(sql`SELECT coalesce(sum(amount),0) v FROM payout_transfers`),
    poiCnt: await one(sql`SELECT count(*) v FROM payout_round_items`),
    perfCnt: await one(sql`SELECT count(*) v FROM performance_assignments`),
    progress: await one(sql`SELECT count(*) v FROM legacy_archive_rows WHERE source_type='progress'`),
    sales: await one(sql`SELECT count(*) v FROM legacy_archive_rows WHERE source_type='sales_list'`),
    legacyMap: await one(sql`SELECT count(*) v FROM legacy_master_mappings`),
  };
}

export async function runMergeExecute(dbx: Dbx, p: MergeExecuteParams) {
  const repId = Number(p.representativeId);
  const preview = await buildMergePreview(dbx, p.masterIds, repId);
  if (preview.guard.blocked) return { dryRun: !p.commit, committed: false, blocked: true, reasons: preview.guard.reasons, representativeId: repId };

  const foundIds = preview.masters.map((m) => m.id);
  if (!foundIds.includes(repId)) return { dryRun: !p.commit, committed: false, blocked: true, reasons: ["대표 Master가 대상에 없습니다"], representativeId: repId };
  const mergedIds = foundIds.filter((i) => i !== repId);

  // §2 주민번호 상충(명백한 신원 충돌)은 guard 에서 이미 하드 차단됨.
  // 식별정보 '없음'은 차단 사유가 아니다(§1·§2) — 대표의 '실제 동일인임을 확인합니다' 체크가 유일한 실행 게이트.
  const sharedId = preview.signals.sharedRrn || preview.signals.sharedPhone || preview.signals.sharedEmail;
  const samePersonConfirmed = !!p.samePersonConfirmed;
  // 하드 차단 사유(reasons)에는 '식별정보 없음'을 넣지 않는다 — 화면 차단표시와 실제 실행가능 여부를 일치시킨다(§4).
  const reasons: string[] = [];

  // 재지정 계획(건수) — 읽기 전용
  const MA = sql.raw(`ARRAY[${mergedIds.length ? mergedIds.join(",") : "-1"}]::int[]`);
  const plan: { table: string; field: string; count: number }[] = [];
  for (const r of REPOINTS) {
    const c = n(rows(await dbx.execute(sql.raw(`SELECT count(*) v FROM ${r.table} WHERE ${r.field} = ANY(ARRAY[${mergedIds.length ? mergedIds.join(",") : "-1"}]::int[]) ${r.extra}`)))[0]?.v);
    plan.push({ table: r.table, field: r.field, count: c });
  }
  const ambiguousHistory = preview.masters.some((m) => m.history.ambiguous);

  const base = {
    dryRun: !p.commit, committed: false, blocked: reasons.length > 0, reasons,
    representativeId: repId, mergedMasterIds: mergedIds,
    plan, ambiguousHistory,
    confirmToken: expectedConfirmToken(repId, mergedIds),   // commit 시 그대로 echo
    // §6 동일인 확인은 항상 필수(대표의 명시적 확인). sharedIdentifier 는 참고신호일 뿐 확인을 대체하지 않는다.
    requiresSamePersonConfirm: true,
    samePersonConfirmed,                                     // 현재 체크 상태(echo)
    sharedIdentifier: sharedId,                              // 참고신호: 공유 식별자 존재 여부
    // canExecute: 하드 차단 없음 + 동일인 확인 완료 → 실제 실행 가능(화면 버튼 활성화 기준, §3·§4).
    canExecute: reasons.length === 0 && samePersonConfirmed,
    note: "식별정보(주민번호·전화·이메일)가 없어도 '실제 동일인임을 확인합니다' 체크 시 통합할 수 있습니다(§1·§2). 서로 다른 유효 주민번호 등 명백한 신원 충돌만 차단됩니다. 진행관리표 이름기반 이력은 자동 귀속하지 않습니다(§7·§8).",
  };

  // DRY-RUN(commit=false): 하드 차단이 없으면 '통과'(plan·검증정보 반환). 동일인 확인은 최종 실행 게이트로만 적용(§3).
  if (!p.commit || reasons.length > 0) return base;

  // ── commit 2단계 승인(§13): 토큰 + 동일인 확인 체크 ──
  if (p.confirmToken !== expectedConfirmToken(repId, mergedIds)) {
    return { ...base, blocked: true, reasons: ["최종 승인 토큰 불일치 — 실행 중단"] };
  }
  if (!samePersonConfirmed) {
    return { ...base, blocked: true, reasons: ["'실제 동일인임을 확인합니다' 체크가 필요합니다(§6)"] };
  }

  // ── 실행(단일 트랜잭션) ──
  let result: any = null;
  await dbx.transaction(async (tx: any) => {
    const before = await invariants(tx);
    const mergeIds: number[] = [];

    for (const M of mergedIds) {
      // 스냅샷(복구용) — 통합 직전 상태
      const snap = rows(await tx.execute(sql`
        SELECT u.deleted_at, u.is_active, p.operational_status
        FROM users u LEFT JOIN translator_profiles p ON p.user_id=u.id WHERE u.id=${M}`))[0] ?? {};
      const mrow = rows(await tx.execute(sql`
        INSERT INTO translator_merges (merged_master_id, representative_master_id, same_person_confirmed, basis, note, performed_by, snapshot, status)
        VALUES (${M}, ${repId}, ${p.samePersonConfirmed}, ${sharedId ? "shared-id" : "manual"}, ${p.note ?? null}, ${p.performedBy ?? null}, ${JSON.stringify(snap)}::jsonb, 'active')
        RETURNING id`))[0];
      const mergeId = n(mrow.id); mergeIds.push(mergeId);

      // FK 재지정 + 감사기록(before/after)
      for (const r of REPOINTS) {
        const upd = rows(await tx.execute(sql.raw(
          `UPDATE ${r.table} SET ${r.field}=${repId} WHERE ${r.field}=${M} ${r.extra} RETURNING id`)));
        for (const u of upd) {
          await tx.execute(sql`INSERT INTO translator_merge_audit (merge_id, action, entity_table, entity_id, field, from_value, to_value)
            VALUES (${mergeId}, 'repoint', ${r.table}, ${n(u.id)}, ${r.field}, ${String(M)}, ${String(repId)})`);
        }
        // payout_transfers 는 payee_key 도 동기화(1인1송금 키)
        if (r.table === "payout_transfers") {
          await tx.execute(sql`UPDATE payout_transfers SET payee_key=${"i:" + repId} WHERE payee_type='individual' AND payee_id=${repId} AND payee_key=${"i:" + M}`);
        }
      }

      // soft-exclude(물리삭제 금지, §10) — 운영목록/선택창 제외, 과거ID 보존
      await tx.execute(sql`UPDATE users SET deleted_at=now(), is_active=false WHERE id=${M} AND role='translator'`);
      await tx.execute(sql`UPDATE translator_profiles SET operational_status='merged', operational_note=${`통합됨 → 대표 #${repId}`}, updated_at=now() WHERE user_id=${M}`);
      await tx.execute(sql`INSERT INTO translator_merge_audit (merge_id, action, entity_table, entity_id, field, from_value, to_value)
        VALUES (${mergeId}, 'exclude', 'users', ${M}, 'deleted_at', ${snap.deleted_at ? String(snap.deleted_at) : null}, 'now')`);
    }

    // §9 불변식 검증 — 전역 건수·금액 불변(재지정은 소유자만 변경)
    const after = await invariants(tx);
    const diffs = Object.keys(before).filter((k) => (before as any)[k] !== (after as any)[k] && k !== "legacyMap");
    // legacyMap 총수도 불변(재지정은 entity_id만 바꿈) — 포함 검증
    if ((before as any).legacyMap !== (after as any).legacyMap) diffs.push("legacyMap");
    if (diffs.length) throw new Error(`불변식 위반(${diffs.join(",")}) — 롤백`);

    // 대표 생존 + merged 제외 확인
    const repAlive = n(rows(await tx.execute(sql`SELECT count(*) v FROM users WHERE id=${repId} AND deleted_at IS NULL`))[0]?.v);
    const mergedGone = n(rows(await tx.execute(sql.raw(`SELECT count(*) v FROM users WHERE id = ANY(ARRAY[${mergedIds.join(",")}]::int[]) AND deleted_at IS NOT NULL`)))[0]?.v);
    if (repAlive !== 1 || mergedGone !== mergedIds.length) throw new Error("사후 상태 검증 실패 — 롤백");

    result = { mergeIds, before, after, invariantsOk: true };
  });

  return { ...base, dryRun: false, committed: true, ...result };
}

// ── 통합 취소/복구(§11) — 감사로그로 모든 재지정 원복 + 스냅샷 상태 복원 ──
export async function revertMerge(dbx: Dbx, mergeId: number, performedBy?: number | null) {
  let out: any = null;
  await dbx.transaction(async (tx: any) => {
    const m = rows(await tx.execute(sql`SELECT * FROM translator_merges WHERE id=${mergeId} AND status='active'`))[0];
    if (!m) throw new Error("되돌릴 활성 통합이 없습니다");
    const M = n(m.merged_master_id), R = n(m.representative_master_id);
    const audits = rows(await tx.execute(sql`SELECT * FROM translator_merge_audit WHERE merge_id=${mergeId} AND action='repoint'`));
    for (const a of audits) {
      await tx.execute(sql.raw(`UPDATE ${a.entity_table} SET ${a.field}=${n(a.from_value)} WHERE id=${n(a.entity_id)} AND ${a.field}=${n(a.to_value)}`));
    }
    await tx.execute(sql`UPDATE payout_transfers SET payee_key=${"i:" + M} WHERE payee_type='individual' AND payee_id=${M} AND payee_key=${"i:" + R}`);
    // 스냅샷 복원
    const snap = m.snapshot ?? {};
    await tx.execute(sql`UPDATE users SET deleted_at=${snap.deleted_at ?? null}, is_active=${snap.is_active ?? true} WHERE id=${M}`);
    await tx.execute(sql`UPDATE translator_profiles SET operational_status=${snap.operational_status ?? "normal"}, operational_note=NULL, updated_at=now() WHERE user_id=${M}`);
    await tx.execute(sql`UPDATE translator_merges SET status='reverted', reverted_at=now(), reverted_by=${performedBy ?? null} WHERE id=${mergeId}`);
    await tx.execute(sql`INSERT INTO translator_merge_audit (merge_id, action, entity_table, entity_id, field, from_value, to_value)
      VALUES (${mergeId}, 'revert_restore', 'users', ${M}, 'status', 'active', 'reverted')`);
    out = { mergeId, restoredMaster: M, representative: R, repointsReverted: audits.length };
  });
  return out;
}
