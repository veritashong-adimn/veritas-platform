// ─── 과거 CRM 자료 최신화(업로드 즉시 반영) — 기존 통합 동기화·통번역사 판정 엔진 재사용 ─────────────
// 목적: 운영 화면에서 최신 CRM 파일을 올리는 것만으로 과거 CRM 자료를 최신 원본 기준으로 갱신한다.
//   · 판매목록 + 진행관리표 = 한 세트. 두 파일 모두 받아 하나의 트랜잭션으로 전체 교체(전부 또는 전무).
//     - 엔진: legacyArchiveSync(buildFullSyncPreview → executeFullSync). 전체 기간(full) 비교, 기준일 = 오늘(KST).
//     - 건별 비교·승인 없음. 서버 내부 안전장치만 유지:
//         필수 열 확인 · 자료 유형 판별 · 빈 파일 · 삭제 비율 이상(부분 파일 의심) · source identity 충돌 · 기준선 변경 감지
//         · 연결 무결성 검사 · 실패 시 전체 롤백(기존 자료 유지).
//     - 최신 파일에 없는 행 = 비활성(is_effective=false). 물리 삭제 없음 → 이전 버전 보존, 실행 단위 되돌리기 가능.
//     - 플랫폼 운영 판매건으로 전환된 자료(실제 지급·입금 기록 연결)는 자동 삭제하지 않음(엔진의 충돌 분리 규칙).
//   · 통번역사 명부: translatorImportPlan(통합 판정) 그대로 — 신규·정보 보완(공란만)만 자동 반영, 동일인 불확실 건은 보류.
//     명부 포함 기준(주민번호 또는 수행이력 중 하나 이상)은 판정 엔진의 등록 자격 규칙(not_eligible)으로 적용된다.
//   · 처리 로그: import_batches(module='crm_refresh') + import_row_sources(status='refresh_log') — 집계값만(주민번호 등 원문 미저장).
import { sql } from "drizzle-orm";
import { importBatchesTable, importRowSourcesTable } from "@workspace/db";
import {
  buildFullSyncPreview, executeFullSync, summarizeFullSync, SyncError,
} from "./legacyArchiveSync";
import { buildImportPlan, executeImportPlan, planSummary, loadSavedDecisions, PlanError, type ManualDecision } from "./translatorImportPlan";
import { todayKst } from "../lib/legacyPayoutRule";

export type RefreshKind = "sales_progress" | "translator" | "company" | "contact";
const LOG_MODULE = "crm_refresh";

// 필수 열(원본 헤더, 공백 무시). 하나라도 없으면 정상적인 전체 자료가 아닌 것으로 보고 교체하지 않는다.
export const REQUIRED_COLUMNS = {
  sales_list: ["판매번호", "거래처명", "상품명", "총액"],
  progress: ["거래처명", "상품명", "통번역사명", "통번역사납품일", "통번역사지급일"],
} as const;
const squash = (s: unknown) => String(s ?? "").replace(/\s/g, "");
export function missingColumns(headers: string[], required: readonly string[]): string[] {
  const hs = new Set(headers.map(squash));
  return required.filter(c => !hs.has(squash(c)));
}

export class RefreshError extends Error {
  code: string; status: number; detail?: unknown;
  constructor(code: string, status: number, message: string, detail?: unknown) { super(message); this.code = code; this.status = status; this.detail = detail; }
}

// 처리 로그 1건(성공·실패 공통). 실패 로그는 트랜잭션 밖에서 남긴다(롤백돼도 기록 유지).
export async function writeRefreshLog(dbx: any, o: {
  kind: RefreshKind; ok: boolean; fileNames: string[]; userId: number | null; summary: Record<string, unknown>; error?: string | null; code?: string | null;
}) {
  const [b] = await dbx.insert(importBatchesTable).values({
    module: LOG_MODULE, importType: o.kind, originalFilename: o.fileNames.filter(Boolean).join(" | ") || null,
    totalRows: Number((o.summary as any)?.totalRows ?? 0) || 0, successRows: 0, errorRows: o.ok ? 0 : 1,
    status: o.ok ? "completed" : "failed", createdBy: o.userId, sourceSystem: "old_crm", isCurrent: false,
  }).returning({ id: importBatchesTable.id });
  await dbx.insert(importRowSourcesTable).values({
    batchId: b.id, module: LOG_MODULE, rowKey: "log", status: "refresh_log", sourceSystem: "old_crm",
    sourceRaw: { kind: o.kind, ok: o.ok, error: o.error ?? null, code: o.code ?? null, summary: o.summary, at: new Date().toISOString() },
  });
  return Number(b.id);
}

// ── 판매목록 + 진행관리표 전체 교체 ─────────────────────────────────────────────
export async function applySalesProgress(db: any, o: { salesBuffer: Buffer; progressBuffer: Buffer; salesName: string; progressName: string; userId: number | null }) {
  const started = Date.now();
  const set = await buildFullSyncPreview(db, {
    salesBuffer: o.salesBuffer, progressBuffer: o.progressBuffer, salesName: o.salesName, progressName: o.progressName,
    asOfDate: todayKst(), scope: "full", userId: o.userId,
  });
  // 필수 열 — 파일이 바뀌었거나 다른 자료를 올린 경우 교체 차단
  const miss = [
    ...missingColumns(set.sales.headers, REQUIRED_COLUMNS.sales_list).map(c => `판매목록: '${c}' 열 없음`),
    ...missingColumns(set.progress.headers, REQUIRED_COLUMNS.progress).map(c => `진행관리표: '${c}' 열 없음`),
  ];
  if (miss.length) throw new RefreshError("REQUIRED_COLUMNS_MISSING", 400, `필수 열이 없어 교체하지 않았습니다 — ${miss.join(" · ")}`, { missing: miss });
  if (set.sales.total === 0 || set.progress.total === 0) throw new RefreshError("EMPTY_FILE", 400, "자료 행이 없는 파일이 있어 교체하지 않았습니다.");
  if (set.blockers.length) throw new RefreshError("SYNC_BLOCKED", 409, `안전 확인에 걸려 교체하지 않았습니다(기존 자료 유지) — ${set.blockers.map(b => b.message).join(" / ")}`, { blockers: set.blockers });
  const summary = summarizeFullSync(set);
  const result = await db.transaction(async (tx: any) => executeFullSync(tx, {
    fullSyncId: set.id, salesToken: set.sales.planToken, progressToken: set.progress.planToken, userId: o.userId,
  }));
  const side = (s: any, r: any) => ({
    fileRows: s.total, added: r.applied?.created ?? 0, updated: r.applied?.updated ?? 0, unchanged: r.unchangedSkipped ?? 0,
    removed: r.deleted ?? 0, protectedFromRemoval: r.deletionConflicts ?? 0, held: r.held ?? 0,
    effectiveAfter: r.effective?.after ?? null,
  });
  return {
    mode: result.mode as "applied" | "no_change", runId: result.runId as string | null, asOfDate: result.asOfDate as string, elapsedMs: Date.now() - started,
    sales: side(summary.sales, result.sales), progress: side(summary.progress, result.progress),
    links: { carried: (result.sales.linksCarried ?? 0) + (result.progress.linksCarried ?? 0), created: (result.sales.newLinks ?? 0) + (result.progress.newLinks ?? 0), relinked: result.relinked?.length ?? 0 },
    cancelled: result.cancelled, integrity: result.integrity,
    totalRows: summary.sales.total + summary.progress.total,
  };
}

// ── 통번역사 명부 최신화 ─────────────────────────────────────────────────────────
// 자동 반영 = 판정 엔진의 NEW(등록 자격 충족 + 실제 이메일) · UPDATE(기존 공란 보완). 이전에 관리자가 저장한 수동 판정은 유지.
// MANUAL(동일인 불확실)·HOLD(자격 미충족·이메일 없음 등)는 등록하지 않는다 — 임의 병합·근거 없는 생성 금지.
// 기존 Master 는 삭제·비활성화하지 않는다(수행·지급이력 보존). 명부 포함 기준은 '파일 행의 신규 등록'에만 적용.
export async function applyTranslatorList(db: any, o: { buffer: Buffer; fileName: string; userId: number | null; snapshotId: string }) {
  const started = Date.now();
  const plan0 = await buildImportPlan(db, o.buffer);
  if (plan0.rows.length === 0) throw new RefreshError("EMPTY_FILE", 400, "통번역사 행이 없는 파일입니다(성명 열을 찾지 못했거나 빈 파일).");
  const s0 = planSummary(plan0);
  // 명부 포함 기준 ③(주민번호 없음 + 수행이력 있음): 진행관리표 수행이력이 이 성명으로만 확인되고, 같은 이름의 기존 Master 가 없으며
  //   그 이력이 다른 Master 에 연결되지 않은 경우(엔진 사유 history_name_only + allowOwnHistory)만 자동 등록한다.
  //   관리자가 이전에 저장한 수동 판정이 있으면 그 판정을 따른다. 동명 Master·식별정보 충돌 등은 그대로 보류(임의 병합 금지).
  const saved = await loadSavedDecisions(db);
  const decisions: Record<string, ManualDecision> = {};
  let autoHistoryOnly = 0;
  for (const r of plan0.rows) {
    if (r.category !== "MANUAL" || r.firstRowOfDuplicate || r.reasonCode !== "history_name_only" || !r.allowOwnHistory) continue;
    if (saved.has(r.personKey)) continue;
    decisions[String(r.rowNumber)] = "different_own_history"; autoHistoryOnly++;
  }
  const result = await db.transaction(async (tx: any) => executeImportPlan(tx, {
    buffer: o.buffer, fileName: o.fileName, snapshotId: o.snapshotId, planToken: plan0.planToken, decisions, performerId: o.userId,
  }));
  const holdReasons: Record<string, number> = {};
  for (const r of plan0.rows) {
    if (r.firstRowOfDuplicate) continue;
    const auto = decisions[String(r.rowNumber)] != null;
    if (r.category === "HOLD" || (r.category === "MANUAL" && !auto) || (r.category === "NEW" && !r.creatable)) {
      const k = r.category === "NEW" ? "no_email" : r.reasonCode; holdReasons[k] = (holdReasons[k] ?? 0) + 1;
    }
  }
  const pc = s0.personCounts as Record<string, number>;
  const notEligible = Object.entries(s0.byReason as Record<string, number>).filter(([k]) => k.endsWith(":not_eligible")).reduce((a, [, n]) => a + n, 0);
  return {
    mode: result.mode as "applied" | "no_change", batchId: result.batchId as number | null, elapsedMs: Date.now() - started,
    fileRows: plan0.rows.length,
    persons: { same: pc.SAME ?? 0, update: pc.UPDATE ?? 0, new: pc.NEW ?? 0, hold: pc.HOLD ?? 0, manual: pc.MANUAL ?? 0 },
    applied: { created: result.created, updated: result.updated, manualApproved: result.manualApproved, manualHeld: result.manualHeld },
    excludedNoRrnNoHistory: notEligible, autoHistoryOnly, notRegistered: holdReasons,
    activeTranslators: { before: result.aliveBefore, after: result.aliveAfter },
    totalRows: plan0.rows.length,
  };
}

export function errorInfo(err: unknown): { status: number; code: string; message: string; detail?: unknown } {
  if (err instanceof RefreshError) return { status: err.status, code: err.code, message: err.message, detail: err.detail };
  if (err instanceof SyncError) return { status: err.status, code: err.code, message: `${err.message} (기존 자료 유지)`, detail: (err as any).detail };
  if (err instanceof PlanError) return { status: err.status, code: err.code, message: `${err.message}` };
  return { status: 500, code: "INTERNAL", message: `처리 중 오류 — 전체 롤백되어 기존 자료가 유지됩니다. (${(err as Error)?.message ?? ""})` };
}

// ── 현황(파일명·최근 업데이트·현재 건수·최근 결과) ────────────────────────────────
export async function refreshStatus(db: any) {
  const one = async (q: any) => ((await db.execute(q)).rows as any[])[0] ?? {};
  const counts = await one(sql`SELECT
    (SELECT count(*) FROM legacy_archive_rows WHERE source_type = 'sales_list' AND is_effective)::int AS sales,
    (SELECT count(*) FROM legacy_archive_rows WHERE source_type = 'progress' AND is_effective)::int AS progress,
    (SELECT count(*) FROM users WHERE role = 'translator' AND deleted_at IS NULL AND is_active)::int AS translators,
    (SELECT count(*) FROM companies WHERE deleted_at IS NULL)::int AS companies,
    (SELECT count(*) FROM contacts WHERE deleted_at IS NULL)::int AS contacts`);
  // 최근 처리 로그(성공·실패) — 종류별 최신 1건
  const logs = (await db.execute(sql`
    SELECT DISTINCT ON (b.import_type) b.import_type AS kind, b.id, b.status, b.original_filename, (b.created_at AT TIME ZONE 'UTC') AS created_at, s.source_raw AS log, u.name AS by_name
    FROM import_batches b LEFT JOIN import_row_sources s ON s.batch_id = b.id AND s.status = 'refresh_log' LEFT JOIN users u ON u.id = b.created_by
    WHERE b.module = ${LOG_MODULE} ORDER BY b.import_type, b.id DESC`)).rows as any[];
  const lastLog = new Map(logs.map(r => [r.kind, r]));
  // 최근 반영(성공) — 기존 경로(상세 도구·대량등록)로 반영한 것도 포함
  const lastApplied = (await db.execute(sql`
    SELECT 'sales_progress' AS kind, (max(b.created_at) AT TIME ZONE 'UTC') AS at FROM import_batches b WHERE b.module = 'legacy_archive' AND b.status = 'completed'
    UNION ALL SELECT 'translator', (max(created_at) AT TIME ZONE 'UTC') FROM import_batches WHERE module = 'translator' AND status = 'completed'
    UNION ALL SELECT 'company', (max(created_at) AT TIME ZONE 'UTC') FROM import_batches WHERE module = 'company' AND status = 'completed'
    UNION ALL SELECT 'contact', (max(created_at) AT TIME ZONE 'UTC') FROM import_batches WHERE module = 'contact' AND status = 'completed'`)).rows as any[];
  const appliedAt = new Map(lastApplied.map(r => [r.kind, r.at]));
  const view = (kind: RefreshKind, count: Record<string, number>) => {
    const l = lastLog.get(kind);
    return {
      kind, counts: count, lastAppliedAt: appliedAt.get(kind) ?? null,
      last: l ? { at: l.created_at, ok: l.status === "completed", fileName: l.original_filename ?? null, by: l.by_name ?? null,
        error: l.log?.error ?? null, summary: l.log?.summary ?? null } : null,
    };
  };
  return {
    today: todayKst(),
    items: [
      view("sales_progress", { sales: Number(counts.sales ?? 0), progress: Number(counts.progress ?? 0) }),
      view("translator", { translators: Number(counts.translators ?? 0) }),
      view("company", { companies: Number(counts.companies ?? 0) }),
      view("contact", { contacts: Number(counts.contacts ?? 0) }),
    ],
  };
}
