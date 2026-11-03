// ─── 과거 CRM 반복 업로드(증분 동기화) — VERITAS OS ───────────────────────────────
// 목적: 같은 CRM 자료를 여러 차례 업로드해도 중복 생성·연결 손상·정보 유실이 없도록 한다.
//   업로드 → 5분류 미리보기(신규/수정/변경 없음/중복 의심/삭제·취소 의심) → 대표 승인 → 반영 → (필요 시) 배치 되돌리기.
//
// 원칙:
//   · 기존 행 삭제·덮어쓰기 없음. 수정 = 새 버전 append + 이전 버전 is_effective=false(superseded_by_id).
//   · 중복 의심(AMBIGUOUS)은 대표가 승인한 행만 저장한다. 미승인 행은 저장하지 않는다(보류 로그만).
//   · 삭제·취소 의심은 분류·보고만 한다(자동 비활성화/삭제 없음).
//   · 판매목록은 원본 판매번호(고유성·일관성 검증 통과 시)를 동일 자료 판정의 1순위로 사용한다.
//     판매번호가 없는 행·진행관리표는 기존 복합키(거래처·담당자·상품·언어·체결일) 판정을 그대로 쓴다.
//   · 이름·날짜만으로 동일 자료를 확정하지 않는다(복합키 다중 후보 → AMBIGUOUS).
//   · 수정 시 판매·진행 연결은 새 버전으로 이관(carry_over_v1, append)하고 재검토 대상은 보고한다.
//   · 변경 로그·되돌리기 근거 = import_row_sources(batch_id, status, source_raw=JSON 근거). DB 구조 변경 없음.
import crypto from "node:crypto";
import { sql, eq, and, count, isNotNull, inArray } from "drizzle-orm";
import { legacyArchiveRowsTable, importBatchesTable, importRowSourcesTable, legacySalesProgressLinksTable } from "@workspace/db";
import { planLateLinks, LATE_LINK_METHOD } from "./legacyContactRestore";
import {
  buildArchivePreview, computeFileHash, planArchiveImport, sourceIdentityKey, matchIncomingRows,
  stableKey, normName, diffMutable, mutualBestPairs,
  type ArchiveSourceType, type ArchivePreviewRow, type MatchableRow, type RowMatchDecision, type ChangedField,
} from "./legacyArchiveResolve";

const SOURCE_SYSTEM = "old_crm";
export const SYNC_ALGO_VERSION = "sync-v3";
// 이 배치가 동기화(sync) 경로로 생성되었음을 나타내는 import_row_sources 표식. 되돌리기는 이 표식이 있는 배치만 허용.
const SYNC_MARK_STATUS = "sync_batch";
// import_row_sources.status 값(varchar 20) — 변경 로그 종류.
export const SYNC_LOG = {
  batch: SYNC_MARK_STATUS, created: "new", approvedNew: "approved_new", approvedUpdate: "approved_update", updated: "update",
  held: "held", deletionSuspect: "del_suspect", deleted: "sync_deleted", deletionConflict: "del_conflict", linkCarry: "link_carry", linkNew: "link_new", linkReview: "link_review", rolledBack: "rolled_back",
} as const;
const LINK_CARRY_METHOD = "carry_over_v1";
// 확정 연결 기록 — 같은 (판매, 수행) 쌍이 이미 있으면: 확정이면 그대로(무변경), 되돌린(rolled_back) 연결이면 이번 근거로 재확정.
//   (되돌리기 후 같은 파일 재반영 시 UNIQUE(sale,progress) 때문에 연결이 rolled_back 으로 남아 유실되던 문제 방지)
async function upsertConfirmedLink(dbx: any, v: { saleRowId: number; progressRowId: number; saleNo: string | null; matchKey: string; matchMethod: string }) {
  return dbx.insert(legacySalesProgressLinksTable).values({ ...v, decision: "confirmed" })
    .onConflictDoUpdate({ target: [legacySalesProgressLinksTable.saleRowId, legacySalesProgressLinksTable.progressRowId],
      set: { decision: "confirmed", matchKey: v.matchKey, matchMethod: v.matchMethod }, setWhere: sql`${legacySalesProgressLinksTable.decision} = 'rolled_back'` })
    .returning({ id: legacySalesProgressLinksTable.id });
}

export type SyncClass = "NEW" | "UPDATED" | "SAME" | "AMBIGUOUS";
export type SyncScope = "range" | "full";   // 삭제·취소 의심 판정 범위: 업로드 파일 기간(range, 기본) | 전체 기간 파일(full)

export interface SyncRow extends MatchableRow {
  sourceSheet: string;
  saleNo: string | null;        // 판매목록 원본 판매번호(source_raw '판매번호')
  saleDate: string | null;      // 범위 판정용 날짜(record_date → 판매번호 날짜 → 세금계산서 날짜)
}

export interface SyncDecision extends RowMatchDecision {
  key: string;                                  // `${sheet}:${row}` — 승인 대상 식별(파일 내 위치)
  matchBasis: "sale_no" | "stable_key" | "relaxed_key";
}

export interface SaleNoValidation {
  applicable: boolean;          // 판매목록인지
  usable: boolean;              // 판정 1순위로 사용 가능한지
  reason: string;
  total: number; withSaleNo: number; missing: number; invalidFormat: number;
  duplicateInFileRows: number; duplicateInFileKeys: number;
  existingTotal: number; existingWithSaleNo: number; duplicateInExistingKeys: number;
  inconsistentMatches: number;  // 판매번호 일치하나 거래처·상품 모두 상이(번호 재사용 의심)
}

const SALE_NO_RE = /^\d{4}-\d{2}-\d{2}-\d+$/;   // 판매번호 형식 YYYY-MM-DD-NNNN(개발 DB 13,549건 100% 일치)
const SALE_NO_MIN_COVERAGE = 0.95;

function dateOnly(v: unknown): string | null {
  const m = String(v ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
export function extractSaleNo(raw: Record<string, unknown> | null | undefined): string | null {
  const v = raw?.["판매번호"];
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
function saleDateOf(recordDate: string | null, saleNo: string | null, raw: Record<string, unknown> | null | undefined): string | null {
  return dateOnly(recordDate) ?? dateOnly(saleNo) ?? dateOnly(raw?.["세금계산서발행(예정)일"]);
}

export function previewRowToSync(r: ArchivePreviewRow): SyncRow {
  const saleNo = extractSaleNo(r.sourceRaw);
  return {
    sourceRow: r.sourceRow, sourceSheet: r.sourceSheet, rowHash: r.rowHash,
    recordDate: r.recordDate, companyName: r.companyName, contactName: r.contactName,
    translatorName: r.translatorName, productName: r.productName, language: r.language,
    deliveryDate: r.deliveryDate, payoutDate: r.payoutDate, payoutPretax: r.payoutPretax,
    collectionDate: r.collectionDate, collectionStatus: r.collectionStatus,
    supplyAmount: r.supplyAmount, vatAmount: r.vatAmount, totalAmount: r.totalAmount,
    saleNo, saleDate: saleDateOf(r.recordDate, saleNo, r.sourceRaw),
  };
}

function rowKey(r: { sourceSheet: string; sourceRow: number }): string { return `${r.sourceSheet}:${r.sourceRow}`; }

// 판매번호 일치 시 stable 필드 변경도 '수정'으로 표시(판매번호가 동일 자료 근거이므로 거래처명·상품명 정정 허용).
const STABLE_FIELDS: (keyof MatchableRow)[] = ["companyName", "contactName", "productName", "language", "recordDate"];
function diffStable(ex: MatchableRow, inc: MatchableRow): ChangedField[] {
  const norm = (v: unknown) => (v == null || String(v).trim() === "" ? "∅" : String(v).trim());
  const out: ChangedField[] = [];
  for (const f of STABLE_FIELDS) if (norm(ex[f]) !== norm(inc[f])) out.push({ field: f, before: ex[f] ?? null, after: inc[f] ?? null });
  return out;
}

export function validateSaleNumbers(sourceType: ArchiveSourceType, incoming: SyncRow[], existing: SyncRow[]): SaleNoValidation {
  const v: SaleNoValidation = {
    applicable: sourceType === "sales_list", usable: false, reason: "",
    total: incoming.length, withSaleNo: 0, missing: 0, invalidFormat: 0, duplicateInFileRows: 0, duplicateInFileKeys: 0,
    existingTotal: existing.length, existingWithSaleNo: 0, duplicateInExistingKeys: 0, inconsistentMatches: 0,
  };
  if (!v.applicable) { v.reason = "판매목록이 아님 — 복합키 판정 사용"; return v; }
  const inCount = new Map<string, number>();
  for (const r of incoming) {
    if (!r.saleNo) { v.missing++; continue; }
    v.withSaleNo++;
    if (!SALE_NO_RE.test(r.saleNo)) v.invalidFormat++;
    inCount.set(r.saleNo, (inCount.get(r.saleNo) ?? 0) + 1);
  }
  for (const n of inCount.values()) if (n > 1) { v.duplicateInFileKeys++; v.duplicateInFileRows += n; }
  const exCount = new Map<string, number>();
  for (const e of existing) if (e.saleNo) { v.existingWithSaleNo++; exCount.set(e.saleNo, (exCount.get(e.saleNo) ?? 0) + 1); }
  for (const n of exCount.values()) if (n > 1) v.duplicateInExistingKeys++;

  const fileCov = v.total ? v.withSaleNo / v.total : 0;
  const exCov = v.existingTotal ? v.existingWithSaleNo / v.existingTotal : 1;
  if (v.total === 0) v.reason = "업로드 행 없음";
  else if (fileCov < SALE_NO_MIN_COVERAGE) v.reason = `업로드 파일 판매번호 보유율 ${(fileCov * 100).toFixed(1)}% — 기준(95%) 미달, 복합키 판정 사용`;
  else if (exCov < SALE_NO_MIN_COVERAGE) v.reason = `기존 자료 판매번호 보유율 ${(exCov * 100).toFixed(1)}% — 기준(95%) 미달, 복합키 판정 사용`;
  else if (v.invalidFormat > v.withSaleNo * 0.05) v.reason = `판매번호 형식 불일치 ${v.invalidFormat}건 — 기준 초과, 복합키 판정 사용`;
  else { v.usable = true; v.reason = "판매번호 고유성·형식 검증 통과 — 판정 1순위로 사용(중복 번호 행은 중복 의심 처리)"; }
  return v;
}

// 최신 파일 기준 동기화(sync-v3): 기존 effective 중 최신 파일에 없는 행 = 삭제(비활성) 대상.
//   · deletionSuspects = 판정 범위 내 미대응 행 전체(삭제 후보). 실제 삭제 = 충돌 제외분(buildSyncPreview 에서 분리).
//   · 충돌(deletionConflicts) = 플랫폼 운영 전환·연결 보존·식별 불가 → 자동 삭제하지 않고 보고.
export interface DeletionConflict { row: SyncRow; code: "activated" | "linked_progress" | "identity_unresolved"; reason: string }
export interface SyncPlan {
  decisions: SyncDecision[];
  counts: Record<SyncClass | "DELETION_SUSPECT" | "DELETION_CONFLICT", number>;
  sameSetGroups: number;
  saleNo: SaleNoValidation;
  deletionSuspects: SyncRow[];          // (호환 명칭) 실제 삭제 대상 — 충돌 분리 후 갱신
  deletionConflicts: DeletionConflict[];
  relaxedMatches: number;               // 식별 항목(체결일 등) 변경을 동일 업무로 재매칭한 건수
  cancelledSkipped?: number;            // 판매취소 확정으로 비활성화된 수행행과 같은 최신 행 — 재등록하지 않음
  deletionScope: { mode: SyncScope; from: string | null; to: string | null; outOfScope: number; undated: number; inScope: number };
}

// 진행관리표 재매칭 키 — 거래처·상품·통번역사·납품일(체결일·담당자·언어 제외). 체결일 정정 등으로 stable key 가 바뀐 행 대응.
function relaxedKey(r: SyncRow): string | null {
  const d = String(r.deliveryDate ?? "").slice(0, 10);
  if (!r.companyName || !r.productName || !d) return null;
  return [normName(r.companyName), normName(r.productName), normName(r.translatorName), d].join("\u0001");
}
const numOr0 = (v: unknown) => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };

// 순수 판정 core(DB 없음) — preview·execute 공용(동일 입력이면 동일 결과).
export function planSync(sourceType: ArchiveSourceType, incoming: SyncRow[], existing: SyncRow[], scope: SyncScope): SyncPlan {
  const saleV = validateSaleNumbers(sourceType, incoming, existing);
  const decisions = new Array<SyncDecision>(incoming.length);
  const claimed = new Set<string>();                 // 1:1 대응된 기존 row id
  const coveredSaleNos = new Set<string>();          // 판매번호 기준 다중/모호로 '존재는 확인'된 번호
  const coveredStable = new Set<string>();           // 복합키 기준 SAME-set·AMBIGUOUS 그룹(존재는 확인)
  let restIdx: number[] = incoming.map((_, i) => i);
  let pool: SyncRow[] = existing;
  let sameSetGroups = 0;

  if (saleV.usable) {
    const exBySale = new Map<string, SyncRow[]>();
    for (const e of existing) if (e.saleNo) { const a = exBySale.get(e.saleNo); if (a) a.push(e); else exBySale.set(e.saleNo, [e]); }
    const inCount = new Map<string, number>();
    for (const r of incoming) if (r.saleNo) inCount.set(r.saleNo, (inCount.get(r.saleNo) ?? 0) + 1);
    restIdx = [];
    incoming.forEach((r, i) => {
      if (!r.saleNo) { restIdx.push(i); return; }
      const ex = exBySale.get(r.saleNo) ?? [];
      const base = { index: i, key: rowKey(r), matchBasis: "sale_no" as const, groupKey: `sale:${r.saleNo}`, candidateCount: ex.length, sameSet: false };
      const n = inCount.get(r.saleNo) ?? 0;
      if (n > 1) {
        coveredSaleNos.add(r.saleNo);
        decisions[i] = { ...base, classification: "AMBIGUOUS", matchedExistingId: null, matchedLogicalGroupKey: null, matchedEffectiveVersion: null, changedFields: [], confidence: "low", reason: `판매번호가 파일 안에서 ${n}건 중복 — 자동 판정 불가` };
        return;
      }
      if (ex.length === 0) {
        decisions[i] = { ...base, classification: "NEW", matchedExistingId: null, matchedLogicalGroupKey: null, matchedEffectiveVersion: null, changedFields: [], confidence: "high", reason: "신규 판매번호" };
        return;
      }
      if (ex.length > 1) {
        coveredSaleNos.add(r.saleNo);
        decisions[i] = { ...base, classification: "AMBIGUOUS", matchedExistingId: null, matchedLogicalGroupKey: null, matchedEffectiveVersion: null, changedFields: [], confidence: "low", reason: `기존 자료에 같은 판매번호 ${ex.length}건 — 자동 판정 불가` };
        return;
      }
      const e = ex[0];
      claimed.add(String(e.id));
      const coSame = normName(e.companyName) === normName(r.companyName);
      const prodSame = normName(e.productName) === normName(r.productName);
      if (!coSame && !prodSame) {
        saleV.inconsistentMatches++;
        decisions[i] = { ...base, classification: "AMBIGUOUS", matchedExistingId: e.id ?? null, matchedLogicalGroupKey: e.logicalGroupKey ?? null, matchedEffectiveVersion: e.effectiveVersion ?? null, changedFields: [...diffStable(e, r), ...diffMutable(e, r)], confidence: "low", reason: "판매번호는 같으나 거래처·상품명이 모두 다름 — 번호 재사용 의심" };
        return;
      }
      const cf = [...diffStable(e, r), ...diffMutable(e, r)];
      const contentChanged = e.rowHash !== r.rowHash;
      const isUpdate = cf.length > 0 || contentChanged;
      decisions[i] = {
        ...base, classification: isUpdate ? "UPDATED" : "SAME", matchedExistingId: e.id ?? null,
        matchedLogicalGroupKey: e.logicalGroupKey ?? null, matchedEffectiveVersion: e.effectiveVersion ?? null,
        changedFields: cf, confidence: "high",
        reason: cf.length > 0 ? "판매번호 일치 + 내용 변경" : contentChanged ? "판매번호 일치 + 원본 내용 변경(비정규화 항목)" : "판매번호 일치 + 변경 없음",
      };
    });
    pool = existing.filter(e => !e.saleNo);           // 판매번호 없는 기존 행만 복합키 fallback 대상
  }

  if (restIdx.length > 0) {
    const sub = restIdx.map(i => incoming[i]);
    const r2 = matchIncomingRows(sub, pool);
    sameSetGroups = r2.sameSetGroups;
    r2.decisions.forEach((d, j) => {
      const i = restIdx[j];
      decisions[i] = { ...d, index: i, key: rowKey(incoming[i]), matchBasis: "stable_key" };
      if (d.matchedExistingId != null) claimed.add(String(d.matchedExistingId));
      if (d.sameSet || d.classification === "AMBIGUOUS") coveredStable.add(d.groupKey);
    });
  }

  // 삭제·취소 의심: 기존 effective 중 이번 파일의 어떤 행과도 대응되지 않은 행(판정 범위 내). 보고 전용.
  const dates = incoming.map(r => r.saleDate).filter((d): d is string => !!d).sort();
  const from = dates[0] ?? null, to = dates[dates.length - 1] ?? null;
  const deletionSuspects: SyncRow[] = [];
  let outOfScope = 0, undated = 0;
  const poolIds = new Set(pool.map(e => String(e.id)));
  for (const e of existing) {
    if (claimed.has(String(e.id))) continue;
    if (e.saleNo && coveredSaleNos.has(e.saleNo)) continue;
    if (poolIds.has(String(e.id)) && coveredStable.has(stableKey(e))) continue;
    if (scope === "full") { deletionSuspects.push(e); continue; }
    if (!e.saleDate) { undated++; continue; }
    if (from && to && e.saleDate >= from && e.saleDate <= to) deletionSuspects.push(e); else outOfScope++;
  }

  // 재매칭(진행관리표): 신규(NEW) ↔ 삭제 후보를 재매칭 키로 대조.
  //   · 키 그룹의 신규 수 = 삭제 후보 수 → 1:1 대응(금액·지급일·행순 정렬)으로 '수정' 처리(중복 생성·오삭제 방지).
  //   · 수가 다르면 동일성 판단 불가 → 신규는 중복 의심(보류), 기존 행은 삭제하지 않고 충돌로 보고.
  const deletionConflicts: DeletionConflict[] = [];
  let relaxedMatches = 0;
  if (sourceType === "progress") {
    const sus = new Map<string, SyncRow[]>();
    for (const e of deletionSuspects) { const k = relaxedKey(e); if (!k) continue; const a = sus.get(k); if (a) a.push(e); else sus.set(k, [e]); }
    const nw = new Map<string, number[]>();
    decisions.forEach((d, i) => { if (d.classification !== "NEW") return; const k = relaxedKey(incoming[i]); if (!k || !sus.has(k)) return; const a = nw.get(k); if (a) a.push(i); else nw.set(k, [i]); });
    const removed = new Set<string>();
    const ord = (r: SyncRow) => [numOr0(r.payoutPretax).toFixed(2).padStart(16, "0"), r.payoutDate ?? "", String(r.sourceRow).padStart(8, "0")].join("|");
    const asUpdate = (i: number, e: SyncRow, reason: string) => {
      const r = incoming[i];
      Object.assign(decisions[i], {
        classification: "UPDATED", matchBasis: "relaxed_key", matchedExistingId: e.id ?? null, matchedLogicalGroupKey: e.logicalGroupKey ?? null,
        matchedEffectiveVersion: e.effectiveVersion ?? null, changedFields: [...diffStable(e, r), ...diffMutable(e, r)], confidence: "medium", reason,
      });
      claimed.add(String(e.id)); removed.add(String(e.id)); relaxedMatches++;
    };
    for (const [k, idxs] of nw) {
      const exs = sus.get(k)!;
      // 1:1 은 그대로 대응. 복수는 상호 최선 대응(동점·저점수 제외)으로 확실한 쌍만 만든다.
      if (idxs.length === 1 && exs.length === 1) { asUpdate(idxs[0], exs[0], "식별 항목(발행일 등) 변경 — 거래처·상품·통번역사·납품일 일치(1:1) → 동일 업무 수정"); continue; }
      const mb = mutualBestPairs(exs, idxs.map(i => incoming[i]), 0.5);
      for (const [j, ix] of mb.pairs) asUpdate(idxs[ix], exs[j], "식별 항목 변경 — 거래처·상품·통번역사·납품일 일치 + 상호 최선 대응 → 동일 업무 수정");
      const incLeft = mb.incLeft.map(ix => idxs[ix]), exLeft = mb.exLeft.map(j => exs[j]);
      // 남은 신규만 있음 → 추가 수행행(신규 유지) · 남은 기존만 있음 → 최신 파일에 없음(삭제 후보 유지)
      if (incLeft.length && exLeft.length) {
        for (const i of incLeft) Object.assign(decisions[i], { classification: "AMBIGUOUS", confidence: "low", matchBasis: "relaxed_key",
          reason: `거래처·상품·통번역사·납품일이 같은 기존 행 ${exLeft.length}건 ↔ 최신 ${incLeft.length}건 — 동일성 판단 불가(중복 의심)` });
        for (const e of exLeft) { removed.add(String(e.id)); deletionConflicts.push({ row: e, code: "identity_unresolved", reason: `최신 파일의 유사 행 ${incLeft.length}건과 1:1 대응 불가 — 자동 삭제 보류` }); }
      }
    }
    // 유형 C — 거래처/상품 결측으로 보류된 최신 행: 남은 삭제 후보 중 통번역사·납품일이 같은 행과 상호 최선 대응 → 수정.
    //   대응 후보가 전혀 없으면: 전체 비교(full)일 때만 신규로 확정(범위 비교는 범위 밖 기존 행과 중복될 수 있어 보류 유지).
    const cIdx = decisions.map((d, i) => i).filter(i => decisions[i].classification === "AMBIGUOUS" && decisions[i].matchedExistingId == null
      && decisions[i].matchBasis === "stable_key" && (!incoming[i].companyName || !incoming[i].productName));
    if (cIdx.length) {
      const tk = (r: SyncRow) => { const t = normName(r.translatorName), d = String(r.deliveryDate ?? "").slice(0, 10); return t && d ? `${t}\u0001${d}` : null; };
      const pool2 = new Map<string, SyncRow[]>();
      for (const e of deletionSuspects) { if (removed.has(String(e.id))) continue; const k = tk(e); if (!k) continue; const a = pool2.get(k); if (a) a.push(e); else pool2.set(k, [e]); }
      const byK = new Map<string, number[]>();
      for (const i of cIdx) { const k = tk(incoming[i]); if (!k) continue; const a = byK.get(k); if (a) a.push(i); else byK.set(k, [i]); }
      for (const [k, idxs] of byK) {
        const exs = pool2.get(k) ?? [];
        if (!exs.length) {
          if (scope === "full") for (const i of idxs) Object.assign(decisions[i], { classification: "NEW", confidence: "medium", matchBasis: "relaxed_key",
            reason: "거래처/상품 결측 — 통번역사·납품일이 같은 기존 행 없음(전체 비교) → 신규" });
          continue;
        }
        const mb = mutualBestPairs(exs, idxs.map(i => incoming[i]));
        for (const [j, ix] of mb.pairs) asUpdate(idxs[ix], exs[j], "거래처/상품 변경·결측 — 통번역사·납품일 일치 + 상호 최선 대응 → 동일 업무 수정");
      }
    }
    if (removed.size) for (let i = deletionSuspects.length - 1; i >= 0; i--) if (removed.has(String(deletionSuspects[i].id))) deletionSuspects.splice(i, 1);
  }

  const inScope = scope === "full" ? existing.length : existing.length - outOfScope - undated;
  const counts: SyncPlan["counts"] = { NEW: 0, UPDATED: 0, SAME: 0, AMBIGUOUS: 0, DELETION_SUSPECT: deletionSuspects.length, DELETION_CONFLICT: deletionConflicts.length };
  for (const d of decisions) counts[d.classification]++;
  return { decisions, counts, sameSetGroups, saleNo: saleV, deletionSuspects, deletionConflicts, relaxedMatches, deletionScope: { mode: scope, from, to, outOfScope, undated, inScope } };
}

// ─── DB 조회 ───────────────────────────────────────────────────────────────────
const T = legacyArchiveRowsTable;
const L = legacySalesProgressLinksTable;

// 기존 effective 기준선(판정 대상). 판매번호·세금계산서 날짜는 source_raw 에서 투영.
export async function loadSyncBaseline(dbx: any, sourceType: ArchiveSourceType): Promise<SyncRow[]> {
  const rows = await dbx.select({
    id: T.id, sourceRow: T.sourceRow, sourceSheet: T.sourceSheet, rowHash: T.rowHash,
    recordDate: T.recordDate, companyName: T.companyName, contactName: T.contactName,
    translatorName: T.translatorName, productName: T.productName, language: T.language,
    deliveryDate: T.deliveryDate, payoutDate: T.payoutDate, payoutPretax: T.payoutPretax,
    collectionDate: T.collectionDate, collectionStatus: T.collectionStatus,
    supplyAmount: T.supplyAmount, vatAmount: T.vatAmount, totalAmount: T.totalAmount,
    logicalGroupKey: T.logicalGroupKey, effectiveVersion: T.effectiveVersion,
    saleNo: sql<string | null>`nullif(btrim(${T.sourceRaw} ->> '판매번호'), '')`,
    taxDate: sql<string | null>`${T.sourceRaw} ->> '세금계산서발행(예정)일'`,
  }).from(T).where(and(eq(T.sourceType, sourceType), eq(T.isEffective, true)));
  return rows.map((r: any) => ({
    id: r.id, sourceRow: r.sourceRow ?? 0, sourceSheet: r.sourceSheet ?? "", rowHash: r.rowHash,
    recordDate: r.recordDate ?? null, companyName: r.companyName ?? null, contactName: r.contactName ?? null,
    translatorName: r.translatorName ?? null, productName: r.productName ?? null, language: r.language ?? null,
    deliveryDate: r.deliveryDate ?? null, payoutDate: r.payoutDate ?? null, payoutPretax: r.payoutPretax ?? null,
    collectionDate: r.collectionDate ?? null, collectionStatus: r.collectionStatus ?? null,
    supplyAmount: r.supplyAmount ?? null, vatAmount: r.vatAmount ?? null, totalAmount: r.totalAmount ?? null,
    logicalGroupKey: r.logicalGroupKey ?? null, effectiveVersion: r.effectiveVersion ?? null,
    saleNo: sourceType === "sales_list" ? (r.saleNo ?? null) : null,
    saleDate: saleDateOf(r.recordDate ?? null, sourceType === "sales_list" ? (r.saleNo ?? null) : null, { "세금계산서발행(예정)일": r.taxDate }),
  }));
}

// 되돌린(rolled_back) 배치의 행은 '이미 보존됨'으로 보지 않는다 → 되돌린 뒤 같은 파일을 다시 올려 재반영 가능.
export async function loadStoredIdentities(dbx: any, fileHash: string, sourceType: ArchiveSourceType): Promise<Map<string, string>> {
  const rows = await dbx.select({ sheet: T.sourceSheet, row: T.sourceRow, h: T.rowHash })
    .from(T).leftJoin(importBatchesTable, eq(importBatchesTable.id, T.importBatchId))
    .where(and(eq(T.fileHash, fileHash), eq(T.sourceType, sourceType), sql`coalesce(${importBatchesTable.status}, '') <> 'rolled_back'`));
  const map = new Map<string, string>();
  for (const r of rows) { if (r.sheet == null || r.row == null) continue; map.set(sourceIdentityKey(r.sheet as string, r.row as number), r.h as string); }
  return map;
}

// 기준선 지문 — preview 이후 다른 업로드/되돌리기로 기준이 바뀌면 승인 토큰이 무효가 된다.
async function baselineFingerprint(dbx: any, sourceType: ArchiveSourceType): Promise<string> {
  const r = (await dbx.execute(sql`
    SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) AS f, count(*)::int AS n
    FROM legacy_archive_rows WHERE source_type = ${sourceType} AND is_effective = true`)).rows[0] as any;
  const l = (await dbx.execute(sql`SELECT count(*)::int AS n, coalesce(max(id),0)::int AS m FROM legacy_sales_progress_links WHERE decision = 'confirmed'`)).rows[0] as any;
  // 배치 상태(반영·되돌리기) — 같은 파일의 '이미 저장됨' 판정이 바뀌는 경우까지 포함
  const b = (await dbx.execute(sql`SELECT count(*)::int AS n, coalesce(max(id),0)::int AS m, count(*) FILTER (WHERE status = 'rolled_back')::int AS r FROM import_batches WHERE module = 'legacy_archive' AND source_type = ${sourceType}`)).rows[0] as any;
  // 운영 판매 전환(활성 매핑) — 삭제 충돌 판정이 바뀌므로 지문에 포함
  const a = (await dbx.execute(sql`SELECT count(*)::int AS n, coalesce(max(id),0)::int AS m FROM legacy_master_mappings WHERE source_system = 'old_crm' AND entity_type = 'sale' AND status = 'active'`)).rows[0] as any;
  return `${r?.n}:${r?.f}:${l?.n}:${l?.m}:${b?.n}:${b?.m}:${b?.r}:${a?.n}:${a?.m}`;
}

export function computePlanToken(sourceType: ArchiveSourceType, fileHash: string, scope: SyncScope, fingerprint: string): string {
  return crypto.createHash("sha256").update(JSON.stringify({ v: SYNC_ALGO_VERSION, sourceType, fileHash, scope, fingerprint })).digest("hex").slice(0, 32);
}

// ─── 영향 분석(연결·Master 수행이력) — 읽기 전용 ─────────────────────────────────
// 판매↔진행 연결 판정에 쓰이는 항목(거래처·상품·금액·날짜)이 바뀌면 연결 재검토 대상.
const LINK_SENSITIVE = new Set(["companyName", "productName", "totalAmount", "supplyAmount", "recordDate"]);

export interface MasterLinkInfo { status: "mapped" | "unmapped" | "no_name"; masterIds: number[] }
export interface RowImpact {
  links: number;                      // 기존 행에 걸린 확정 판매·진행 연결 수
  linkReview: boolean;                // 연결 판정 항목 변경 → 재검토
  master?: { before: MasterLinkInfo | null; after: MasterLinkInfo; change: "same" | "lost" | "moved" | "gained" | "none" };
}

async function loadLinkCounts(dbx: any, ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let i = 0; i < ids.length; i += 5000) {
    const chunk = ids.slice(i, i + 5000);
    if (!chunk.length) continue;
    const rows = await dbx.select({ s: L.saleRowId, p: L.progressRowId }).from(L)
      .where(and(eq(L.decision, "confirmed"), sql`(${inArray(L.saleRowId, chunk)} OR ${inArray(L.progressRowId, chunk)})`));
    const set = new Set(chunk);
    for (const r of rows) {
      if (set.has(r.s)) out.set(r.s, (out.get(r.s) ?? 0) + 1);
      if (set.has(r.p)) out.set(r.p, (out.get(r.p) ?? 0) + 1);
    }
  }
  return out;
}

// 과거 CRM 통번역사명 → Master 매핑(legacy_master_mappings, 미롤백). 수행이력 화면과 동일 기준(btrim 이름 일치).
async function loadMasterMap(dbx: any): Promise<Map<string, number[]>> {
  const rows = (await dbx.execute(sql`
    SELECT btrim(legacy_id) AS name, entity_id AS id FROM legacy_master_mappings
    WHERE entity_type = 'translator' AND status <> 'rolled_back' AND btrim(legacy_id) <> ''`)).rows as any[];
  const m = new Map<string, number[]>();
  for (const r of rows) { const a = m.get(r.name); if (a) { if (!a.includes(r.id)) a.push(r.id); } else m.set(r.name, [r.id]); }
  return m;
}
function masterInfo(map: Map<string, number[]>, name: string | null): MasterLinkInfo {
  const n = (name ?? "").trim();
  if (!n) return { status: "no_name", masterIds: [] };
  const ids = map.get(n) ?? [];
  return ids.length ? { status: "mapped", masterIds: ids } : { status: "unmapped", masterIds: [] };
}

export interface SyncPreview {
  sourceType: ArchiveSourceType; fileHash: string; scope: SyncScope; planToken: string;
  total: number; alreadyStored: number; conflicts: number; safeToExecute: boolean;
  plan: SyncPlan;
  incoming: SyncRow[];
  baselineById: Map<string, SyncRow>;
  impact: Map<number, RowImpact>;     // incoming index → 영향
  impactSummary: { updatedWithLinks: number; linksToCarry: number; linkReview: number; masterLost: number; masterMoved: number; newUnmappedNames: number; deletionSuspectWithLinks: number;
    newSaleLink?: { link: number; linkRows: number; hold: number; none: number } };
  newSaleLinks: Map<number, NewSaleLink>;
  storedKeys: Set<string>;            // 같은 파일로 이미 보존된 위치(실행 시 건너뜀)
  allRows: ArchivePreviewRow[];
  headers: string[];                  // 최다행 시트 원본 header 순서(배치 headers_json)
  rawChanges: Map<number, RawChange[]>;   // decision index → 원본 열 변경
  comparedWith: { sourceType: ArchiveSourceType; label: string; effectiveRows: number; detectedFileType: ArchiveSourceType | null };
  changeSummary: { columns: Record<string, number>; columnOnlyToSame: number; headerDiff: { added: string[]; removed: string[] } };
  blockers: { code: string; message: string }[];      // 치명적 오류 — 실행 차단
  amountImpact: AmountImpact;
}

// 지급(진행관리표)·매출(판매목록) 영향 — 변경 전후 금액. 진행: 지급액(세전) · 판매: 총액.
export interface AmountImpact {
  basis: "payout_pretax" | "total_amount";
  added: { count: number; amount: number };
  changed: { count: number; before: number; after: number };
  excluded: { count: number; amount: number };
  conflicts: { count: number; amount: number };
  netDelta: number;
}

// ─── 삭제 충돌 판정(DB 조회, 읽기 전용) ──────────────────────────────────────────
//   · activated: 플랫폼 운영 판매건으로 전환된 자료(판매번호 활성 매핑 · 전환 계보) → 운영 자료 보호, 자동 삭제 금지.
//   · linked_progress(판매목록): 이 판매건에 연결된 진행관리표 수행행이 계속 유효 → 원인 확인 필요, 자동 삭제 금지.
//     통합 동기화에서는 같은 실행에서 삭제되는 수행행(progressDeletionIds)은 '남은 행'으로 보지 않는다.
const ACT_MODULE = "legacy_sale_activation";
async function classifyDeletions(dbx: any, sourceType: ArchiveSourceType, suspects: SyncRow[], progressDeletionIds?: Set<number>): Promise<{ toDelete: SyncRow[]; conflicts: DeletionConflict[] }> {
  if (!suspects.length) return { toDelete: [], conflicts: [] };
  const ids = suspects.map(s => Number(s.id));
  const arr = sql.raw(`ARRAY[${ids.join(",")}]::int[]`);
  const conflict = new Map<number, DeletionConflict>();
  const byId = new Map(suspects.map(s => [Number(s.id), s]));
  if (sourceType === "sales_list") {
    const act = (await dbx.execute(sql`
      SELECT r.id FROM legacy_archive_rows r
      WHERE r.id = ANY(${arr}) AND EXISTS (SELECT 1 FROM legacy_master_mappings m JOIN projects p ON p.id = m.entity_id AND p.status <> 'cancelled'
        WHERE m.source_system = 'old_crm' AND m.entity_type = 'sale' AND m.status = 'active' AND m.legacy_id = nullif(btrim(r.source_raw->>'판매번호'),''))`)).rows as any[];
    for (const a of act) conflict.set(Number(a.id), { row: byId.get(Number(a.id))!, code: "activated", reason: "플랫폼 운영 판매건으로 전환된 자료 — 운영 자료 보호(자동 삭제 안 함)" });
    const lk = (await dbx.execute(sql`
      SELECT l.sale_row_id AS s, array_agg(DISTINCT l.progress_row_id) AS p FROM legacy_sales_progress_links l
      JOIN legacy_archive_rows pr ON pr.id = l.progress_row_id AND pr.is_effective
      WHERE l.decision = 'confirmed' AND l.sale_row_id = ANY(${arr}) GROUP BY l.sale_row_id`)).rows as any[];
    for (const x of lk) {
      const sid = Number(x.s); if (conflict.has(sid)) continue;
      const remain = (x.p as any[]).map(Number).filter(pid => !progressDeletionIds?.has(pid));
      if (remain.length) conflict.set(sid, { row: byId.get(sid)!, code: "linked_progress", reason: `최신 기준에서도 유지되는 진행관리표 수행행 ${remain.length}건이 연결됨 — 원인 확인 필요(자동 삭제 안 함)` });
    }
  } else if (sourceType === "progress") {
    const act = (await dbx.execute(sql`
      SELECT DISTINCT r.id FROM legacy_archive_rows r
      WHERE r.id = ANY(${arr}) AND (
        EXISTS (SELECT 1 FROM import_row_sources s WHERE s.module = ${ACT_MODULE} AND s.row_key = 'progress:' || r.id)
        OR EXISTS (SELECT 1 FROM legacy_sales_progress_links l JOIN legacy_archive_rows sr ON sr.id = l.sale_row_id
          JOIN legacy_master_mappings m ON m.source_system = 'old_crm' AND m.entity_type = 'sale' AND m.status = 'active' AND m.legacy_id = nullif(btrim(sr.source_raw->>'판매번호'),'')
          JOIN projects p ON p.id = m.entity_id AND p.status <> 'cancelled'
          WHERE l.progress_row_id = r.id AND l.decision = 'confirmed'))`)).rows as any[];
    for (const a of act) conflict.set(Number(a.id), { row: byId.get(Number(a.id))!, code: "activated", reason: "플랫폼 운영 판매건(수행정보·지급)으로 전환된 수행행 — 확정 기록 보호(자동 삭제 안 함)" });
  }
  return { toDelete: suspects.filter(s => !conflict.has(Number(s.id))), conflicts: [...conflict.values()] };
}

// 삭제 범위 이상 감지 — 부분 파일(일부 거래처·일부 행)을 전체 비교에 쓰는 사고 방지.
const DELETE_RATIO_MAX = 0.1, DELETE_ABS_FREE = 50;
function deletionBlockers(plan: SyncPlan): { code: string; message: string }[] {
  const n = plan.deletionSuspects.length, base = plan.deletionScope.inScope;
  if (n > DELETE_ABS_FREE && base > 0 && n / base > DELETE_RATIO_MAX) {
    return [{ code: "DELETION_SCOPE_SUSPECT", message: `삭제 대상 ${n.toLocaleString()}건 = 비교 범위 기존 ${base.toLocaleString()}건의 ${(n / base * 100).toFixed(1)}% — 부분 자료로 보입니다. 전체 자료 파일인지, 동기화 범위가 맞는지 확인하세요(실행 차단).` }];
  }
  return [];
}

function computeAmountImpact(sourceType: ArchiveSourceType, plan: SyncPlan, incoming: SyncRow[], baselineById: Map<string, SyncRow>): AmountImpact {
  const basis = sourceType === "sales_list" ? "total_amount" : "payout_pretax";
  const amt = (r: SyncRow | undefined | null) => numOr0(basis === "total_amount" ? r?.totalAmount : r?.payoutPretax);
  const out: AmountImpact = { basis, added: { count: 0, amount: 0 }, changed: { count: 0, before: 0, after: 0 }, excluded: { count: 0, amount: 0 }, conflicts: { count: 0, amount: 0 }, netDelta: 0 };
  plan.decisions.forEach((d, i) => {
    const r = incoming[i];
    if (d.classification === "NEW") { out.added.count++; out.added.amount += amt(r); }
    else if (d.classification === "UPDATED") {
      const b = baselineById.get(String(d.matchedExistingId));
      if (amt(b) !== amt(r) || (basis === "payout_pretax" && (b?.payoutDate ?? null) !== (r.payoutDate ?? null))) { out.changed.count++; out.changed.before += amt(b); out.changed.after += amt(r); }
    }
  });
  for (const e of plan.deletionSuspects) { out.excluded.count++; out.excluded.amount += amt(e); }
  for (const c of plan.deletionConflicts) { out.conflicts.count++; out.conflicts.amount += amt(c.row); }
  out.netDelta = out.added.amount + (out.changed.after - out.changed.before) - out.excluded.amount;
  return out;
}

// ─── 신규 판매건 ↔ 진행관리표 연결(기존 연결 규칙 재사용) ─────────────────────────────
// 기존 29,797 연결과 같은 키: 판매 '거래처|상품|총액|판매일(판매번호 날짜)' = 진행 '거래처명|상품명|총액|체결일'.
//   상품 결측 → reduced_co_amt_date_v1, 거래처 결측 → reduced_prod_amt_date_v1(∅ 표기). 확실한 경우만 연결:
//   · 같은 키의 판매건이 2건 이상이면 보류 · 해당 진행 행이 이미 다른 판매건에 연결돼 있으면 보류 · 진행 행 없으면 미연결.
export interface NewSaleLink { status: "link" | "hold" | "none"; method?: string; key?: string; progressIds?: number[]; reason?: string }
const amtKey = (v: unknown) => { const t = String(v ?? "").replace(/[,\s원]/g, ""); if (!t) return ""; const n = Number(t); return Number.isFinite(n) ? String(Math.round(n)) : ""; };
export function saleLinkKey(company: string | null, product: string | null, total: unknown, date: string | null): { key: string; method: string } | null {
  const c = (company ?? "").trim(), pr = (product ?? "").trim(), a = amtKey(total), d = (date ?? "").slice(0, 10);
  if (!a || !d || (!c && !pr)) return null;
  return { key: `${c || "∅"}|${pr || "∅"}|${a}|${d}`, method: c && pr ? "full_key_v1" : c ? "reduced_co_amt_date_v1" : "reduced_prod_amt_date_v1" };
}
export async function planNewSaleLinks(dbx: any, newSales: { i: number; company: string | null; product: string | null; total: unknown; date: string | null }[], baseline: SyncRow[]): Promise<Map<number, NewSaleLink>> {
  const out = new Map<number, NewSaleLink>();
  if (!newSales.length) return out;
  const prog = (await dbx.execute(sql`
    SELECT p.id, p.source_raw->>'거래처명' c, p.source_raw->>'상품명' pr, p.source_raw->>'총액' a, p.source_raw->>'체결일' d,
      EXISTS (SELECT 1 FROM legacy_sales_progress_links l JOIN legacy_archive_rows s ON s.id = l.sale_row_id WHERE l.progress_row_id = p.id AND l.decision = 'confirmed' AND s.is_effective) AS linked
    FROM legacy_archive_rows p WHERE p.source_type = 'progress' AND p.is_effective`)).rows as any[];
  const byKey = new Map<string, { id: number; linked: boolean }[]>();
  for (const r of prog) { const k = saleLinkKey(r.c, r.pr, r.a, r.d); if (!k) continue; const arr = byKey.get(k.key) ?? []; arr.push({ id: Number(r.id), linked: !!r.linked }); byKey.set(k.key, arr); }
  const saleKeyCount = new Map<string, number>();
  for (const b of baseline) { const k = saleLinkKey(b.companyName, b.productName, b.totalAmount, b.saleDate); if (k) saleKeyCount.set(k.key, (saleKeyCount.get(k.key) ?? 0) + 1); }
  for (const n of newSales) { const k = saleLinkKey(n.company, n.product, n.total, n.date); if (k) saleKeyCount.set(k.key, (saleKeyCount.get(k.key) ?? 0) + 1); }
  for (const n of newSales) {
    const k = saleLinkKey(n.company, n.product, n.total, n.date);
    if (!k) { out.set(n.i, { status: "none", reason: "연결키 부족(거래처·상품·총액·판매일)" }); continue; }
    const cands = byKey.get(k.key) ?? [];
    if (!cands.length) { out.set(n.i, { status: "none", method: k.method, key: k.key, reason: "일치하는 진행관리표 행 없음" }); continue; }
    if ((saleKeyCount.get(k.key) ?? 0) > 1) { out.set(n.i, { status: "hold", method: k.method, key: k.key, reason: "같은 연결키의 판매건 복수 — 자동 연결 보류" }); continue; }
    if (cands.some(c => c.linked)) { out.set(n.i, { status: "hold", method: k.method, key: k.key, reason: "진행 행이 이미 다른 판매건에 연결됨 — 자동 연결 보류" }); continue; }
    out.set(n.i, { status: "link", method: k.method, key: k.key, progressIds: cands.map(c => c.id) });
  }
  return out;
}

// ─── 파일 유형 자동 감지 ─────────────────────────────────────────────────────────
// 선택한 자료 유형과 업로드 파일의 실제 열 구성이 다르면 잘못된 기준(예: 진행관리표 ↔ 판매목록)과 비교되므로 차단한다.
const TYPE_MARKERS: Record<ArchiveSourceType, string[]> = {
  progress: ["통번역사명", "통번역사납품일", "통번역사지급일", "지급액(세전)", "통번역단가", "통번역수량", "요율(85%)"],
  sales_list: ["판매번호", "영업기회명", "영업담당자", "세금계산서발행(예정)일"],
  translator_list: ["성명", "이메일", "휴대폰", "주민등록번호", "가능언어", "학력"],
};
export const SOURCE_TYPE_LABEL: Record<ArchiveSourceType, string> = { progress: "진행관리표", sales_list: "판매목록", translator_list: "통번역사 목록" };
export function detectArchiveType(headers: string[]): { detected: ArchiveSourceType | null; scores: Record<string, number> } {
  const hs = new Set(headers.map(h => String(h ?? "").replace(/\s/g, "")));
  const scores: Record<string, number> = {};
  for (const [t, ms] of Object.entries(TYPE_MARKERS)) scores[t] = ms.filter(m => hs.has(m.replace(/\s/g, ""))).length;
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const detected = best[0][1] >= 2 && best[0][1] > (best[1]?.[1] ?? 0) ? (best[0][0] as ArchiveSourceType) : null;
  return { detected, scores };
}

// ─── 원본 열(source_raw) 단위 변경 항목 ───────────────────────────────────────────
// 정규화 필드에 없는 원본 열(통역료·요율·지급액(세후)·교통비 등) 변경도 '주요 변경 항목'으로 보여준다.
//   · 양쪽 파일에 모두 있는 열만 비교(열 추가·삭제 자체는 행 변경으로 보지 않음 → 열 구성 변경 시 대량 재버전 방지).
//   · 값 비교는 공백·천단위 쉼표를 정규화. 주민등록번호는 변경 여부만 표시(값 마스킹).
export interface RawChange { column: string; before: string | null; after: string | null }
const RRN_COLUMNS = new Set(["주민등록번호", "주민번호", "외국인등록번호"]);
function rawNorm(v: unknown): string {
  if (v == null) return "";
  const s = String(v).trim();
  const n = s.replace(/,/g, "");
  return /^-?\d+(\.\d+)?$/.test(n) ? String(Number(n)) : s;
}
export function diffRaw(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined): RawChange[] {
  const b = before ?? {}, a = after ?? {};
  const out: RawChange[] = [];
  for (const k of Object.keys(a)) {
    if (!(k in b)) continue;
    if (rawNorm(b[k]) === rawNorm(a[k])) continue;
    if (RRN_COLUMNS.has(k)) { out.push({ column: k, before: b[k] ? "●●●●●●-●●●●●●●" : null, after: a[k] ? "●●●●●●-●●●●●●● (변경)" : null }); continue; }
    out.push({ column: k, before: b[k] == null || b[k] === "" ? null : String(b[k]), after: a[k] == null || a[k] === "" ? null : String(a[k]) });
  }
  return out;
}

export async function buildSyncPreview(dbx: any, opts: { buffer: Buffer; sourceType: ArchiveSourceType; scope: SyncScope; progressDeletionIds?: Set<number> }): Promise<SyncPreview> {
  const fileHash = computeFileHash(opts.buffer);
  const sheets = buildArchivePreview(opts.buffer, opts.sourceType);
  const allRows = sheets.flatMap(s => s.rows);
  const headers = sheets.length ? sheets.reduce((a, b) => (b.rows.length > a.rows.length ? b : a), sheets[0]).headers : [];
  const typeCheck = detectArchiveType(headers);
  if (typeCheck.detected && typeCheck.detected !== opts.sourceType) {
    throw new SyncError("SOURCE_TYPE_MISMATCH", 400, `업로드 파일은 '${SOURCE_TYPE_LABEL[typeCheck.detected]}'로 보입니다(선택: '${SOURCE_TYPE_LABEL[opts.sourceType]}'). 자료 유형을 '${SOURCE_TYPE_LABEL[typeCheck.detected]}'로 선택한 뒤 다시 미리보기하세요.`);
  }
  const stored = await loadStoredIdentities(dbx, fileHash, opts.sourceType);
  const imp = planArchiveImport(allRows, stored);
  const storedKeys = new Set<string>();
  for (const r of allRows) if (stored.get(sourceIdentityKey(r.sourceSheet, r.sourceRow)) === r.rowHash) storedKeys.add(rowKey(r));

  const baseline = await loadSyncBaseline(dbx, opts.sourceType);
  const incoming = allRows.map(previewRowToSync);
  // 내용 비교 해시 — 양쪽에 모두 있는 원본 열의 정규화 값 기준. 최신 CRM 이 열을 추가·삭제해도
  //   공통 열 값이 같으면 '변경 없음', 여러 행 묶음(SAME-set)도 정상 대조된다. 저장되는 row_hash(원본 지문)는 그대로.
  const exRaw = new Map<number, Record<string, unknown>>();
  const baseRawRows = await dbx.select({ id: T.id, raw: T.sourceRaw }).from(T).where(and(eq(T.sourceType, opts.sourceType), eq(T.isEffective, true)));
  const baseKeys = new Set<string>();
  // 비교 열 = 업로드 파일 열 ∩ '모든' 기존 유효 행이 가진 열(교집합). 합집합을 쓰면 최신 CRM 이 열을 추가한 뒤
  //   (예: 2026-11-03 수익률·수익액·지급액(교통비포함)) 새 버전 행만 그 열을 가져 기존 행 전체가 '내용 변경'으로 보이고
  //   여러 행 묶음이 대량 중복 의심이 된다(재동기화 비멱등). 교집합이면 열 추가 전후 비교가 안정적이다.
  let baseAll: Set<string> | null = null;
  for (const r of baseRawRows) {
    const raw = (r.raw ?? {}) as Record<string, unknown>; exRaw.set(r.id as number, raw);
    const ks = Object.keys(raw); for (const k of ks) baseKeys.add(k);
    if (baseAll == null) baseAll = new Set(ks); else { const cur = new Set(ks); for (const k of [...baseAll]) if (!cur.has(k)) baseAll.delete(k); }
  }
  const incKeys = new Set<string>(); for (const r of allRows) for (const k of Object.keys(r.sourceRaw ?? {})) incKeys.add(k);
  const common = [...incKeys].filter(k => (baseAll ?? baseKeys).has(k)).sort();
  const compHash = (raw: Record<string, unknown> | null | undefined) =>
    crypto.createHash("sha256").update(JSON.stringify(common.map(k => [k, rawNorm((raw ?? {})[k])]))).digest("hex");
  if (baseKeys.size > 0) {
    for (const b of baseline) b.rowHash = compHash(exRaw.get(Number(b.id)));
    incoming.forEach((r, i) => { r.rowHash = compHash(allRows[i].sourceRaw); });
  }
  const plan = planSync(opts.sourceType, incoming, baseline, opts.scope);
  // 판매취소 확정으로 비활성화된 수행행(되돌리지 않은 배치) — CRM 파일에 남아 있어도 신규로 재등록하지 않는다.
  //   대응 = 거래처·상품·통번역사·납품일(재매칭 키) 1:1. 다른 신규 행은 그대로 신규.
  if (opts.sourceType === "progress") {
    const cx = (await dbx.execute(sql`
      SELECT DISTINCT r.id, r.company_name, r.product_name, r.translator_name, r.delivery_date::text AS delivery_date, r.source_raw
      FROM import_row_sources s JOIN import_batches b ON b.id = s.batch_id AND b.status = 'completed'
      JOIN legacy_archive_rows r ON r.id = s.entity_id AND NOT r.is_effective AND r.superseded_by_id IS NULL
      WHERE s.status = ${SYNC_LOG.deleted} AND s.source_raw->>'reason' = 'admin_cancel_confirmed' AND s.source_raw->>'kind' = 'progress_of_cancelled_sale'`)).rows as any[];
    if (cx.length) {
      // 1순위: 원본 내용 일치(비교 해시 — 같은 열 기준). 각 취소 행은 1회만 대응.
      //   (거래처·상품·통번역사·납품일 키로는 대응하지 않는다 — 취소 후 재계약된 새 판매의 수행행을 잘못 제외할 수 있음.
      //    실례: 2026-10-13-0004 취소 → 2026-10-29-0005 재계약, 같은 통번역사·납품일)
      const hashOf = (raw: any) => (baseKeys.size > 0 ? compHash(raw ?? {}) : null);
      const used = new Set<number>();
      const rowsByHash = new Map<string, any[]>();
      for (const r of cx) { const h = hashOf(r.source_raw); if (h) { const a = rowsByHash.get(h) ?? []; a.push(r); rowsByHash.set(h, a); } }
      const take = (arr: any[] | undefined) => { const x = arr?.find(r => !used.has(Number(r.id))); if (x) used.add(Number(x.id)); return !!x; };
      // 3순위: 판매취소 확정 '판매건'에 속한 행 — 판매↔진행 연결 규칙과 같은 키(거래처|상품|총액|판매일=체결일).
      //   CRM 이 취소 판매의 수행행을 고쳐 쓴 경우(금액 기입·행 분할)도 재등록하지 않는다.
      const cancelledSaleKeys = new Set<string>(((await dbx.execute(sql`
        SELECT DISTINCT r.company_name, r.product_name, r.total_amount, r.source_raw->>'판매번호' AS sale_no
        FROM import_row_sources s JOIN import_batches b ON b.id = s.batch_id AND b.status = 'completed'
        JOIN legacy_archive_rows r ON r.id = s.entity_id AND NOT r.is_effective
        WHERE s.status = ${SYNC_LOG.deleted} AND s.source_raw->>'reason' = 'admin_cancel_confirmed' AND s.source_raw->>'kind' = 'sale'`)).rows as any[])
        .map(r => saleLinkKey(r.company_name, r.product_name, r.total_amount, dateOnly(r.sale_no))?.key).filter((k): k is string => !!k));
      const inCancelledSale = (i: number) => { const raw = allRows[i].sourceRaw ?? {}; const k = saleLinkKey(raw["거래처명"] as any, raw["상품명"] as any, raw["총액"], dateOnly(raw["체결일"])); return !!k && cancelledSaleKeys.has(k.key); };
      let skipped = 0;
      plan.decisions.forEach((d, i) => {
        const held = d.classification === "AMBIGUOUS" && d.matchedExistingId == null;
        if (d.classification !== "NEW" && !held) return;
        const hit = d.classification === "NEW" && take(rowsByHash.get(incoming[i].rowHash));
        if (!hit && !inCancelledSale(i)) return;
        if (held) { plan.counts.AMBIGUOUS--; plan.counts.SAME++; } else { plan.counts.NEW--; plan.counts.SAME++; }
        skipped++;
        Object.assign(d, { classification: "SAME", confidence: "high", reason: "판매취소 확정 판매의 수행행 — 최신 CRM 파일에 남아 있어도 재등록하지 않음" });
      });
      plan.cancelledSkipped = skipped;
    }
  }
  // 삭제 대상 ↔ 충돌 분리(운영 전환·연결 보존). 충돌은 삭제하지 않고 보고.
  const dc = await classifyDeletions(dbx, opts.sourceType, plan.deletionSuspects, opts.progressDeletionIds);
  plan.deletionSuspects = dc.toDelete;
  plan.deletionConflicts.push(...dc.conflicts);
  plan.counts.DELETION_SUSPECT = plan.deletionSuspects.length;
  plan.counts.DELETION_CONFLICT = plan.deletionConflicts.length;

  // 원본 열 변경 항목 계산 + '열 구성 차이만' 있는 행은 변경 없음으로 재분류(새 버전 미생성).
  const rawChanges = new Map<number, RawChange[]>();
  const columnChangeCounts: Record<string, number> = {};
  let columnOnlyToSame = 0;
  const updIdx = plan.decisions.filter(d => (d.classification === "UPDATED" || d.classification === "AMBIGUOUS") && d.matchedExistingId != null);
  for (const d of updIdx) {
    const rc = diffRaw(exRaw.get(Number(d.matchedExistingId)), allRows[d.index].sourceRaw);
    if (d.classification === "UPDATED" && d.changedFields.length === 0 && rc.length === 0) {
      d.classification = "SAME"; d.reason = "열 구성 차이만 있음(공통 열 값 동일) — 변경 없음"; columnOnlyToSame++;
      plan.counts.UPDATED--; plan.counts.SAME++;
      continue;
    }
    rawChanges.set(d.index, rc);
    if (d.classification === "UPDATED") for (const c of rc) columnChangeCounts[c.column] = (columnChangeCounts[c.column] ?? 0) + 1;
  }
  for (const d of plan.decisions) if (d.classification === "UPDATED") for (const c of d.changedFields) {
    const k = `[정규화] ${String(c.field)}`; columnChangeCounts[k] = (columnChangeCounts[k] ?? 0) + 1;
  }
  // 열 구성 비교(기존 유효 원본 행의 열 vs 업로드 파일의 열)
  const headerDiff = baseKeys.size ? { added: [...incKeys].filter(k => !baseKeys.has(k)), removed: [...baseKeys].filter(k => !incKeys.has(k)) } : { added: [] as string[], removed: [] as string[] };
  const baselineById = new Map(baseline.map(b => [String(b.id), b]));
  const planToken = computePlanToken(opts.sourceType, fileHash, opts.scope, await baselineFingerprint(dbx, opts.sourceType));

  // 영향 분석
  const touchedIds = new Set<number>();
  for (const d of plan.decisions) if ((d.classification === "UPDATED" || d.classification === "AMBIGUOUS") && d.matchedExistingId != null) touchedIds.add(Number(d.matchedExistingId));
  for (const s of plan.deletionSuspects) touchedIds.add(Number(s.id));
  const linkCounts = await loadLinkCounts(dbx, [...touchedIds]);
  const masterMap = opts.sourceType === "progress" ? await loadMasterMap(dbx) : null;
  const impact = new Map<number, RowImpact>();
  const sum = { updatedWithLinks: 0, linksToCarry: 0, linkReview: 0, masterLost: 0, masterMoved: 0, newUnmappedNames: 0, deletionSuspectWithLinks: 0 };
  const unmappedNames = new Set<string>();
  plan.decisions.forEach((d, i) => {
    if (d.classification === "SAME") return;
    const exId = d.matchedExistingId != null ? Number(d.matchedExistingId) : null;
    const links = exId != null ? (linkCounts.get(exId) ?? 0) : 0;
    const linkReview = links > 0 && d.changedFields.some(c => LINK_SENSITIVE.has(String(c.field)));
    const ri: RowImpact = { links, linkReview };
    if (d.classification === "UPDATED" && links > 0) { sum.updatedWithLinks++; sum.linksToCarry += links; if (linkReview) sum.linkReview++; }
    if (masterMap) {
      const before = exId != null ? masterInfo(masterMap, baselineById.get(String(exId))?.translatorName ?? null) : null;
      const after = masterInfo(masterMap, incoming[i].translatorName);
      let change: NonNullable<RowImpact["master"]>["change"] = "none";
      if (before) {
        if (before.status === "mapped" && after.status !== "mapped") change = "lost";
        else if (before.status === "mapped" && after.status === "mapped") change = before.masterIds.join(",") === after.masterIds.join(",") ? "same" : "moved";
        else if (before.status !== "mapped" && after.status === "mapped") change = "gained";
      }
      if (change === "lost") sum.masterLost++;
      if (change === "moved") sum.masterMoved++;
      if (after.status === "unmapped" && incoming[i].translatorName) unmappedNames.add(incoming[i].translatorName!.trim());
      ri.master = { before, after, change };
    }
    impact.set(i, ri);
  });
  sum.newUnmappedNames = unmappedNames.size;
  // 신규 판매건 진행관리표 연결 계획(중복 의심 승인 신규도 대상 — 실행 시 같은 계획 사용)
  let newSaleLinks = new Map<number, NewSaleLink>();
  if (opts.sourceType === "sales_list") {
    const ns = plan.decisions.filter(d => d.classification === "NEW" || (d.classification === "AMBIGUOUS" && d.matchedExistingId == null))
      .map(d => ({ i: d.index, company: incoming[d.index].companyName, product: incoming[d.index].productName, total: incoming[d.index].totalAmount, date: incoming[d.index].saleDate }));
    newSaleLinks = await planNewSaleLinks(dbx, ns, baseline);
    const nl = { link: 0, linkRows: 0, hold: 0, none: 0 };
    for (const d of plan.decisions) if (d.classification === "NEW") { const x = newSaleLinks.get(d.index); if (!x) continue; nl[x.status]++; if (x.status === "link") nl.linkRows += x.progressIds!.length; }
    (sum as any).newSaleLink = nl;
  }
  for (const s of plan.deletionSuspects) if ((linkCounts.get(Number(s.id)) ?? 0) > 0) sum.deletionSuspectWithLinks++;
  // 같은 실행에서 삭제되는 진행 행으로는 신규 판매 연결을 만들지 않는다(잘못된 참조 방지).
  if (opts.progressDeletionIds?.size) for (const [k, v] of newSaleLinks) if (v.status === "link") {
    const keep = v.progressIds!.filter(id => !opts.progressDeletionIds!.has(id));
    newSaleLinks.set(k, keep.length ? { ...v, progressIds: keep } : { status: "none", method: v.method, key: v.key, reason: "연결 대상 진행 행이 이번 동기화에서 삭제됨" });
  }
  const blockers: { code: string; message: string }[] = [...deletionBlockers(plan)];
  if (!imp.safeToExecute) blockers.push({ code: "ARCHIVE_IDENTITY_CONFLICT", message: `source identity 충돌 ${imp.conflicts.length}건 — 동일 파일의 동일 위치에 다른 내용이 이미 보존됨` });
  if (allRows.length === 0) blockers.push({ code: "EMPTY_FILE", message: "업로드 파일에 자료 행이 없습니다." });
  const amountImpact = computeAmountImpact(opts.sourceType, plan, incoming, baselineById);

  return {
    sourceType: opts.sourceType, fileHash, scope: opts.scope, planToken,
    total: allRows.length, alreadyStored: imp.alreadyStoredCount, conflicts: imp.conflicts.length, safeToExecute: imp.safeToExecute,
    plan, incoming, baselineById, impact, impactSummary: sum, storedKeys, allRows, headers, newSaleLinks,
    rawChanges, changeSummary: { columns: columnChangeCounts, columnOnlyToSame, headerDiff },
    comparedWith: { sourceType: opts.sourceType, label: SOURCE_TYPE_LABEL[opts.sourceType], effectiveRows: baseline.length, detectedFileType: typeCheck.detected },
    blockers, amountImpact,
  };
}

// 미리보기 응답(분류별 페이지). 개인정보: 진행관리 주민번호는 source_raw 를 내보내지 않으므로 노출 없음.
export function summarizePreview(p: SyncPreview) {
  return {
    sourceType: p.sourceType, scope: p.scope, planToken: p.planToken, algorithm: SYNC_ALGO_VERSION, comparedWith: p.comparedWith,
    total: p.total, alreadyStored: p.alreadyStored, conflicts: p.conflicts, safeToExecute: p.safeToExecute,
    counts: p.plan.counts, sameSetGroups: p.plan.sameSetGroups,
    saleNoValidation: p.plan.saleNo, deletionScope: p.plan.deletionScope, impact: p.impactSummary,
    changeSummary: { ...p.changeSummary, topColumns: Object.entries(p.changeSummary.columns).sort((a, b) => b[1] - a[1]).slice(0, 15) },
    willApply: { insertEffective: p.plan.counts.NEW + p.plan.counts.UPDATED, supersede: p.plan.counts.UPDATED, heldUnlessApproved: p.plan.counts.AMBIGUOUS, deactivate: p.plan.counts.DELETION_SUSPECT },
    relaxedMatches: p.plan.relaxedMatches, cancelledSkipped: p.plan.cancelledSkipped ?? 0, blockers: p.blockers, amountImpact: p.amountImpact,
    conflictsByCode: p.plan.deletionConflicts.reduce((m, c) => { m[c.code] = (m[c.code] ?? 0) + 1; return m; }, {} as Record<string, number>),
  };
}

function pickView(r: SyncRow) {
  return {
    sourceSheet: r.sourceSheet, sourceRow: r.sourceRow, saleNo: r.saleNo, saleDate: r.saleDate,
    companyName: r.companyName, contactName: r.contactName, productName: r.productName, translatorName: r.translatorName, language: r.language,
    totalAmount: r.totalAmount, payoutPretax: r.payoutPretax, deliveryDate: r.deliveryDate, payoutDate: r.payoutDate, collectionStatus: r.collectionStatus,
  };
}

export function previewPage(p: SyncPreview, cls: SyncClass | "DELETION_SUSPECT" | "DELETION_CONFLICT" | "CHANGES", page: number, pageSize: number) {
  const size = Math.min(200, Math.max(10, pageSize || 50));
  if (cls === "DELETION_CONFLICT") {
    const all = p.plan.deletionConflicts;
    const start = (Math.max(1, page) - 1) * size;
    return { cls, page: Math.max(1, page), pageSize: size, total: all.length,
      rows: all.slice(start, start + size).map(c => ({ existingId: c.row.id, conflictCode: c.code, reason: c.reason, ...pickView(c.row) })) };
  }
  if (cls === "DELETION_SUSPECT") {
    const all = p.plan.deletionSuspects;
    const start = (Math.max(1, page) - 1) * size;
    return { cls, page: Math.max(1, page), pageSize: size, total: all.length,
      rows: all.slice(start, start + size).map(e => ({ existingId: e.id, ...pickView(e) })) };
  }
  const idx = p.plan.decisions.filter(d => cls === "CHANGES" ? d.classification !== "SAME" : d.classification === cls).map(d => d.index);
  const start = (Math.max(1, page) - 1) * size;
  return {
    cls, page: Math.max(1, page), pageSize: size, total: idx.length,
    rows: idx.slice(start, start + size).map(i => {
      const d = p.plan.decisions[i];
      const before = d.matchedExistingId != null ? p.baselineById.get(String(d.matchedExistingId)) ?? null : null;
      return {
        key: d.key, classification: d.classification, matchBasis: d.matchBasis, reason: d.reason, confidence: d.confidence,
        candidateCount: d.candidateCount, matchedExistingId: d.matchedExistingId, alreadyStored: p.storedKeys.has(d.key),
        incoming: pickView(p.incoming[i]), before: before ? pickView(before) : null,
        changedFields: d.changedFields, rawChanges: p.rawChanges.get(i) ?? [], impact: p.impact.get(i) ?? null, newSaleLink: p.newSaleLinks.get(i) ?? null,
      };
    }),
  };
}

// ─── 실행(대표 승인 후) ─────────────────────────────────────────────────────────
export class SyncError extends Error {
  code: string; status: number; detail?: unknown;
  constructor(code: string, status: number, message: string, detail?: unknown) { super(message); this.code = code; this.status = status; this.detail = detail; }
}

// ─── 미리보기 캐시(서버 메모리) ───────────────────────────────────────────────────
// 3만 행 Excel 파싱(약 3~5초)을 페이지 이동·반영 때마다 반복하지 않도록 파싱·판정 결과를 잠시 보관한다.
//   · 승인 토큰(기준선 지문 포함)이 같을 때만 재사용 → 기준이 바뀌면 자동으로 다시 계산.
//   · DB 저장 없음. 서버 재시작 시 사라지며 그 경우 미리보기를 다시 실행하면 된다.
const PREVIEW_TTL_MS = 20 * 60 * 1000;
const PREVIEW_CACHE_MAX = 3;
const previewCache = new Map<string, { preview: SyncPreview; userId: number | null; at: number }>();
function prunePreviewCache() {
  const now = Date.now();
  for (const [k, v] of previewCache) if (now - v.at > PREVIEW_TTL_MS) previewCache.delete(k);
  while (previewCache.size > PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value as string);
}
export function cachePreview(p: SyncPreview, userId: number | null): string {
  prunePreviewCache();
  for (const r of p.allRows) (r as any).rawRow = undefined;   // 원본 셀 배열은 판정 후 불필요 → 메모리 절감
  const id = crypto.randomUUID();
  previewCache.set(id, { preview: p, userId, at: Date.now() });
  return id;
}
export function getCachedPreview(id: string, userId: number | null): SyncPreview | null {
  prunePreviewCache();
  const c = previewCache.get(id);
  if (!c || (c.userId != null && userId != null && c.userId !== userId)) return null;
  return c.preview;
}
function findCachedPreview(fileHash: string, sourceType: ArchiveSourceType, scope: SyncScope): SyncPreview | null {
  prunePreviewCache();
  for (const v of previewCache.values()) {
    const p = v.preview;
    if (p.fileHash === fileHash && p.sourceType === sourceType && p.scope === scope) return p;
  }
  return null;
}

export interface SyncExecuteResult {
  mode: "applied" | "no_change";
  batchId: number | null; snapshotId: number | null;
  total: number; alreadyStored: number;
  applied: { created: number; approvedNew: number; approvedUpdate: number; updated: number; evidenceSame: number };
  unchangedSkipped: number;          // 변경 없음(SAME) — DB INSERT/UPDATE 없이 건너뜀
  held: number; deletionSuspects: number;
  deleted: number; deletionConflicts: number;   // 최신 파일 기준 삭제(비활성) 반영 · 충돌(삭제 보류)
  linksCarried: number; linkReview: number; newLinks?: number;
  supersededSnapshotIds: number[];
  matching: { NEW: number; SAME: number; UPDATED: number; AMBIGUOUS: number };
  effective: { before: number; after: number };
  reusedPreview: boolean;
  // 기존 contract 호환(ExecuteResult)
  created: number; skippedDuplicate: number; warnings: number; sheetNames: string[];
}

async function effectiveCount(dbx: any, sourceType: ArchiveSourceType): Promise<number> {
  return Number((await dbx.select({ n: count() }).from(T).where(and(eq(T.sourceType, sourceType), eq(T.isEffective, true))))[0].n);
}

async function insertLogs(dbx: any, rows: any[]) {
  for (let i = 0; i < rows.length; i += 1000) await dbx.insert(importRowSourcesTable).values(rows.slice(i, i + 1000));
}

export async function executeArchiveSync(dbx: any, opts: {
  buffer: Buffer; sourceType: ArchiveSourceType; fileName: string; performerId: number | null;
  scope: SyncScope; planToken: string; approvedAmbiguous: Set<string>;
  // 통합 동기화: 호출자가 트랜잭션 시작 시 승인 토큰을 이미 검증한 미리보기(파일 재파싱·토큰 재검사 생략).
  preview?: SyncPreview; asOfDate?: string | null; runId?: string | null;
  recordMarkerIfNoChange?: boolean;   // 통합 동기화: 이 파일은 변경 0이어도 기준일 기록용 배치(0행)를 남긴다
}): Promise<SyncExecuteResult> {
  let p: SyncPreview; let reusedPreview: boolean;
  if (opts.preview) { p = opts.preview; reusedPreview = true; }
  else {
    // 같은 파일·같은 기준선의 미리보기가 캐시에 있으면 재사용(파싱 생략). 기준선이 바뀌었으면 다시 계산 → 토큰 불일치로 거부.
    const fileHash = computeFileHash(opts.buffer);
    const cached = findCachedPreview(fileHash, opts.sourceType, opts.scope);
    const nowToken = computePlanToken(opts.sourceType, fileHash, opts.scope, await baselineFingerprint(dbx, opts.sourceType));
    reusedPreview = !!cached && cached.planToken === nowToken;
    p = reusedPreview ? cached! : await buildSyncPreview(dbx, { buffer: opts.buffer, sourceType: opts.sourceType, scope: opts.scope });
    if (!opts.planToken || opts.planToken !== p.planToken) {
      throw new SyncError("SYNC_PLAN_CHANGED", 409, "미리보기 이후 기준 자료가 바뀌었거나 승인 토큰이 일치하지 않습니다. 미리보기를 다시 실행해 확인한 뒤 승인하세요.");
    }
  }
  if (!p.safeToExecute) throw new SyncError("ARCHIVE_IDENTITY_CONFLICT", 409, `source identity 충돌 ${p.conflicts}건 — 동일 파일의 동일 위치에 다른 내용이 이미 보존되어 있습니다(원본 무결성 위험).`);
  if (p.blockers.length) throw new SyncError("SYNC_BLOCKED", 409, p.blockers.map(b => b.message).join(" / "), p.blockers);
  const sheetNames = [...new Set(p.allRows.map(r => r.sourceSheet))];
  const warnings = p.allRows.reduce((n, r) => n + r.warnings.length, 0);
  const effBefore = await effectiveCount(dbx, opts.sourceType);

  // 적용 대상: 신규·수정·승인된 중복 의심만. 변경 없음(SAME)은 저장하지 않는다(INSERT/UPDATE 없음).
  // 중복 의심 승인: 1:1 대응 기존행이 있는 판매번호 판정(번호 재사용 의심)은 '수정'으로, 그 외는 '신규'로 반영한다
  //   → 승인으로 같은 판매번호 유효행이 2건 생기지 않게 한다.
  type Act = { i: number; kind: "new" | "approved_new" | "approved_update" | "update" };
  const acts: Act[] = [];
  const heldIdx: number[] = [];
  let unchangedSkipped = 0;
  p.plan.decisions.forEach((d, i) => {
    if (p.storedKeys.has(d.key)) return;
    if (d.classification === "NEW") acts.push({ i, kind: "new" });
    else if (d.classification === "UPDATED") acts.push({ i, kind: "update" });
    else if (d.classification === "SAME") unchangedSkipped++;
    else if (opts.approvedAmbiguous.has(d.key)) acts.push({ i, kind: d.matchBasis === "sale_no" && d.matchedExistingId != null ? "approved_update" : "approved_new" });
    else heldIdx.push(i);
  });
  const matching = { NEW: p.plan.counts.NEW, SAME: p.plan.counts.SAME, UPDATED: p.plan.counts.UPDATED, AMBIGUOUS: p.plan.counts.AMBIGUOUS };
  const toDelete = p.plan.deletionSuspects.map(e => Number(e.id));
  const base = { total: p.total, alreadyStored: p.alreadyStored, matching, deletionSuspects: p.plan.counts.DELETION_SUSPECT, deletionConflicts: p.plan.counts.DELETION_CONFLICT,
    warnings, sheetNames, skippedDuplicate: p.alreadyStored, unchangedSkipped, reusedPreview };
  if (acts.length === 0 && toDelete.length === 0 && !opts.recordMarkerIfNoChange) {
    // 반영할 변경 없음 → 배치·행·로그를 만들지 않는다(같은 파일 반복 업로드 시 건수·버전 불변).
    return { ...base, mode: "no_change", batchId: null, snapshotId: null, applied: { created: 0, approvedNew: 0, approvedUpdate: 0, updated: 0, evidenceSame: 0 },
      deleted: 0, held: heldIdx.length, linksCarried: 0, linkReview: 0, supersededSnapshotIds: [], effective: { before: effBefore, after: effBefore }, created: 0 };
  }

  // 변경분 배치. 최초 원본 스냅샷의 '현재(is_current)' 지위는 바꾸지 않는다(변경분만 담긴 배치이므로).
  const [batch] = await dbx.insert(importBatchesTable).values({
    module: "legacy_archive", importType: "legacy_archive", originalFilename: opts.fileName, sheetName: sheetNames.join(", ") || null,
    totalRows: p.total, successRows: 0, warningRows: warnings, errorRows: 0, skippedRows: p.alreadyStored + unchangedSkipped,
    status: "analyzed", createdBy: opts.performerId, sourceSystem: SOURCE_SYSTEM, fileHash: p.fileHash, sourceType: opts.sourceType, isCurrent: false,
    headersJson: p.headers,
  }).returning({ id: importBatchesTable.id });

  // 행 저장 — 원본 append(신규·수정 버전만, 전부 effective).
  const insertedId = new Map<number, number>();   // decision index → 새 row id
  // 되돌린 배치가 남긴 같은 원본 위치(file_hash·유형·시트·행)의 비유효 행 — UNIQUE(source identity) 때문에 재삽입이 막히므로
  //   같은 원본 행을 재활성화하고 이번 배치로 소속을 옮긴다(내용은 같은 파일 bytes 그대로, 이후 되돌리기도 정상 동작).
  const revivable = new Map<string, number>();
  for (const r of (await dbx.execute(sql`
    SELECT r.id, r.source_sheet, r.source_row FROM legacy_archive_rows r JOIN import_batches b ON b.id = r.import_batch_id
    WHERE r.file_hash = ${p.fileHash} AND r.source_type = ${opts.sourceType} AND b.status = 'rolled_back' AND NOT r.is_effective`)).rows as any[]) {
    revivable.set(`${r.source_sheet}:${r.source_row}`, Number(r.id));
  }
  for (let c = 0; c < acts.length; c += 500) {
    const chunk = acts.slice(c, c + 500);
    const values = chunk.map(a => {
      const r = p.allRows[a.i]; const d = p.plan.decisions[a.i];
      const isUpd = a.kind === "update" || a.kind === "approved_update";
      const groupKey = isUpd ? (d.matchedLogicalGroupKey ?? crypto.randomUUID()) : crypto.randomUUID();
      const ver = isUpd ? (d.matchedEffectiveVersion ?? 1) + 1 : 1;
      return {
        sourceType: opts.sourceType, sourceSystem: SOURCE_SYSTEM, importBatchId: batch.id, sourceFile: opts.fileName, fileHash: p.fileHash,
        sourceSheet: r.sourceSheet, sourceRow: r.sourceRow, recordDate: r.recordDate, companyName: r.companyName, contactName: r.contactName,
        translatorName: r.translatorName, productName: r.productName, language: r.language,
        supplyAmount: r.supplyAmount != null ? String(r.supplyAmount) : null, vatAmount: r.vatAmount != null ? String(r.vatAmount) : null,
        totalAmount: r.totalAmount != null ? String(r.totalAmount) : null, payoutPretax: r.payoutPretax != null ? String(r.payoutPretax) : null,
        deliveryDate: r.deliveryDate, payoutDate: r.payoutDate, collectionDate: r.collectionDate, collectionStatus: r.collectionStatus,
        sourceRaw: r.sourceRaw, rowHash: r.rowHash, isCurrent: false,
        matchStatus: a.kind === "approved_new" ? "new" : a.kind === "approved_update" ? "updated" : d.classification.toLowerCase(), isEffective: true, logicalGroupKey: groupKey, effectiveVersion: ver,
      };
    });
    const fresh: any[] = [];
    for (let j = 0; j < chunk.length; j++) {
      const a = chunk[j], v = values[j]; const rid = revivable.get(p.plan.decisions[a.i].key);
      if (rid == null) { fresh.push(v); continue; }
      const { sourceType: _t, fileHash: _h, sourceSheet: _s, sourceRow: _r, ...upd } = v;
      const back = await dbx.update(T).set({ ...upd, supersededById: null }).where(and(eq(T.id, rid), eq(T.isEffective, false))).returning({ id: T.id });
      if (back.length === 1) insertedId.set(a.i, rid); else fresh.push(v);
    }
    const ins = fresh.length ? await dbx.insert(T).values(fresh)
      .onConflictDoNothing({ target: [T.fileHash, T.sourceType, T.sourceSheet, T.sourceRow] })
      .returning({ id: T.id, sheet: T.sourceSheet, row: T.sourceRow }) : [];
    const byKey = new Map<string, number>(ins.map((x: any) => [`${x.sheet}:${x.row}`, x.id as number] as [string, number]));
    for (const a of chunk) { if (insertedId.has(a.i)) continue; const id = byKey.get(p.plan.decisions[a.i].key); if (id != null) insertedId.set(a.i, id); }
  }
  if (insertedId.size !== acts.length) throw new Error(`저장 행수 불일치: 대상 ${acts.length} ≠ 저장 ${insertedId.size}. 롤백합니다.`);

  // 수정: 이전 버전 강등(삭제·overwrite 아님)
  const supersedePairs: { oldId: number; newId: number; i: number }[] = [];
  for (const a of acts) if (a.kind === "update" || a.kind === "approved_update") {
    const d = p.plan.decisions[a.i];
    if (d.matchedExistingId == null) continue;
    supersedePairs.push({ oldId: Number(d.matchedExistingId), newId: insertedId.get(a.i)!, i: a.i });
  }
  for (const s of supersedePairs) {
    const upd = await dbx.update(T).set({ isEffective: false, supersededById: s.newId })
      .where(and(eq(T.id, s.oldId), eq(T.isEffective, true))).returning({ id: T.id });
    if (upd.length !== 1) throw new Error(`이전 버전 #${s.oldId} 이 이미 변경되었습니다. 롤백합니다.`);
  }

  // 최신 파일에서 사라진 행 → 삭제(비활성) 처리. 물리 삭제 없음(원본·연결 보존) → 배치 되돌리기로 복구.
  //   대상 = 미리보기에서 충돌(운영 전환·연결 보존·식별 불가)을 제외한 행. 기준선이 바뀌어 대상이 이미 비유효면 전체 롤백.
  let deleted = 0;
  for (let c = 0; c < toDelete.length; c += 5000) {
    const chunk = toDelete.slice(c, c + 5000);
    const upd = await dbx.update(T).set({ isEffective: false })
      .where(and(inArray(T.id, chunk), eq(T.isEffective, true), sql`${T.supersededById} IS NULL`)).returning({ id: T.id });
    deleted += upd.length;
  }
  if (deleted !== toDelete.length) throw new Error(`삭제 대상 불일치: 대상 ${toDelete.length} ≠ 처리 ${deleted}. 롤백합니다.`);

  // 판매·진행 연결 이관(append) — 기존 확정 연결을 새 버전으로 복제. 원 연결은 이전 버전에 그대로 보존.
  const oldToNew = new Map(supersedePairs.map(s => [s.oldId, s.newId]));
  const pairByOld = new Map(supersedePairs.map(s => [s.oldId, s]));
  const oldIds = [...oldToNew.keys()];
  const carryLogs: any[] = [];
  let linksCarried = 0, linkReview = 0;
  for (let c = 0; c < oldIds.length; c += 5000) {
    const chunk = oldIds.slice(c, c + 5000);
    const links = await dbx.select().from(L).where(and(eq(L.decision, "confirmed"), sql`(${inArray(L.saleRowId, chunk)} OR ${inArray(L.progressRowId, chunk)})`));
    for (const lk of links) {
      const newSale = oldToNew.get(lk.saleRowId) ?? lk.saleRowId;
      const newProg = oldToNew.get(lk.progressRowId) ?? lk.progressRowId;
      const movedOld = oldToNew.has(lk.saleRowId) ? lk.saleRowId : lk.progressRowId;
      const pair = pairByOld.get(movedOld)!;
      const review = p.plan.decisions[pair.i].changedFields.some(cf => LINK_SENSITIVE.has(String(cf.field)));
      const saleNo = opts.sourceType === "sales_list" ? (p.incoming[pair.i].saleNo ?? lk.saleNo) : lk.saleNo;
      const ins = await upsertConfirmedLink(dbx, { saleRowId: newSale, progressRowId: newProg, saleNo, matchKey: `batch:${batch.id}|from_link:${lk.id}`, matchMethod: LINK_CARRY_METHOD });
      if (ins.length) {
        linksCarried++;
        if (review) linkReview++;
        carryLogs.push({ batchId: batch.id, module: "legacy_archive", entityId: ins[0].id, sourceFile: opts.fileName, sourceSheet: p.allRows[pair.i].sourceSheet, sourceRow: p.allRows[pair.i].sourceRow,
          rowKey: `link:${lk.id}`, status: review ? SYNC_LOG.linkReview : SYNC_LOG.linkCarry, sourceSystem: SOURCE_SYSTEM, legacyId: String(lk.id),
          sourceRaw: { fromLinkId: lk.id, oldRowId: movedOld, newRowId: oldToNew.get(movedOld), review, changedFields: review ? p.plan.decisions[pair.i].changedFields.map(cf => cf.field) : [] } });
      }
    }
  }

  // 변경 로그(import_row_sources) — 되돌리기·감사 근거. 주민번호 등 원본 PII 는 넣지 않는다(정규화 변경 항목만).
  const logs: any[] = [{ batchId: batch.id, module: "legacy_archive", entityId: null, sourceFile: opts.fileName, rowKey: "batch", status: SYNC_LOG.batch, sourceSystem: SOURCE_SYSTEM,
    sourceRaw: { algorithm: SYNC_ALGO_VERSION, scope: opts.scope, planToken: p.planToken, counts: p.plan.counts, unchangedSkipped, saleNoUsable: p.plan.saleNo.usable, approvedAmbiguous: [...opts.approvedAmbiguous].length,
      asOfDate: opts.asOfDate ?? null, runId: opts.runId ?? null, deleted, deletionConflicts: p.plan.counts.DELETION_CONFLICT, relaxedMatches: p.plan.relaxedMatches,
      deletionScope: p.plan.deletionScope, amountImpact: p.amountImpact, performerId: opts.performerId, executedAt: new Date().toISOString() } }];
  for (const a of acts) {
    const d = p.plan.decisions[a.i]; const r = p.allRows[a.i];
    logs.push({ batchId: batch.id, module: "legacy_archive", entityId: insertedId.get(a.i), sourceFile: opts.fileName, sourceSheet: r.sourceSheet, sourceRow: r.sourceRow,
      rowKey: d.key, status: a.kind === "update" ? SYNC_LOG.updated : a.kind === "approved_update" ? SYNC_LOG.approvedUpdate : a.kind === "approved_new" ? SYNC_LOG.approvedNew : SYNC_LOG.created, sourceSystem: SOURCE_SYSTEM,
      legacyId: d.matchedExistingId != null ? String(d.matchedExistingId) : (p.incoming[a.i].saleNo ?? null),
      sourceRaw: { basis: d.matchBasis, reason: d.reason, supersededId: a.kind === "update" || a.kind === "approved_update" ? d.matchedExistingId : null, changedFields: d.changedFields } });
  }
  for (const i of heldIdx) {
    const d = p.plan.decisions[i]; const r = p.allRows[i];
    logs.push({ batchId: batch.id, module: "legacy_archive", entityId: null, sourceFile: opts.fileName, sourceSheet: r.sourceSheet, sourceRow: r.sourceRow,
      rowKey: d.key, status: SYNC_LOG.held, sourceSystem: SOURCE_SYSTEM, legacyId: p.incoming[i].saleNo ?? null,
      sourceRaw: { reason: d.reason, candidateCount: d.candidateCount } });
  }
  // 삭제(비활성) 로그 = 복구 근거. 주민번호 등 원본 PII 는 넣지 않는다.
  for (const s of p.plan.deletionSuspects) {
    logs.push({ batchId: batch.id, module: "legacy_archive", entityId: Number(s.id), sourceFile: opts.fileName, rowKey: `existing:${s.id}`, status: SYNC_LOG.deleted,
      sourceSystem: SOURCE_SYSTEM, legacyId: s.saleNo ?? null, sourceRaw: { scope: opts.scope, saleDate: s.saleDate, company: s.companyName, product: s.productName,
        translator: s.translatorName, deliveryDate: s.deliveryDate, payoutDate: s.payoutDate, payoutPretax: s.payoutPretax, totalAmount: s.totalAmount } });
  }
  for (const c of p.plan.deletionConflicts) {
    logs.push({ batchId: batch.id, module: "legacy_archive", entityId: Number(c.row.id), sourceFile: opts.fileName, rowKey: `existing:${c.row.id}`, status: SYNC_LOG.deletionConflict,
      sourceSystem: SOURCE_SYSTEM, legacyId: c.row.saleNo ?? null, sourceRaw: { code: c.code, reason: c.reason, saleDate: c.row.saleDate } });
  }
  // 신규 판매건 ↔ 진행관리표 연결(미리보기 계획 그대로, 확실한 건만)
  let newLinks = 0;
  if (opts.sourceType === "sales_list") {
    for (const a of acts) {
      if (a.kind !== "new" && a.kind !== "approved_new") continue;
      const nl = p.newSaleLinks.get(a.i); if (nl?.status !== "link") continue;
      const saleId = insertedId.get(a.i)!;
      for (const pid of nl.progressIds!) {
        const ins = await upsertConfirmedLink(dbx, { saleRowId: saleId, progressRowId: pid, saleNo: p.incoming[a.i].saleNo, matchKey: nl.key!, matchMethod: nl.method! });
        if (ins.length) {
          newLinks++;
          carryLogs.push({ batchId: batch.id, module: "legacy_archive", entityId: ins[0].id, sourceFile: opts.fileName, sourceSheet: p.allRows[a.i].sourceSheet, sourceRow: p.allRows[a.i].sourceRow,
            rowKey: `newlink:${ins[0].id}`, status: SYNC_LOG.linkNew, sourceSystem: SOURCE_SYSTEM, legacyId: String(saleId), sourceRaw: { saleRowId: saleId, progressRowId: pid, method: nl.method } });
        }
      }
    }
  }
  // 진행관리표 신규 행 ↔ 기존 판매건 연결(판매보다 늦게 올라온 진행행). 같은 연결키·같은 조건(키의 판매 1건, 다른 판매에 미연결)일 때만.
  //   되돌리기는 link_new 기록으로 함께 정리된다.
  if (opts.sourceType === "progress" && insertedId.size) {
    const { links: late } = await planLateLinks(dbx, { progressIds: [...insertedId.values()] });
    for (const l of late) {
      const ins = await upsertConfirmedLink(dbx, { saleRowId: l.saleRowId, progressRowId: l.progressRowId, saleNo: l.saleNo, matchKey: l.key, matchMethod: LATE_LINK_METHOD });
      if (ins.length) {
        newLinks++;
        carryLogs.push({ batchId: batch.id, module: "legacy_archive", entityId: ins[0].id, sourceFile: opts.fileName, rowKey: `newlink:${ins[0].id}`, status: SYNC_LOG.linkNew,
          sourceSystem: SOURCE_SYSTEM, legacyId: String(l.saleRowId), sourceRaw: { saleRowId: l.saleRowId, progressRowId: l.progressRowId, method: LATE_LINK_METHOD, key: l.key } });
      }
    }
  }
  await insertLogs(dbx, [...logs, ...carryLogs]);
  await dbx.update(importBatchesTable).set({ successRows: insertedId.size, status: "completed" }).where(eq(importBatchesTable.id, batch.id));

  // invariant: effective 수 = 이전 + 신규 + 승인신규(수정은 1:1 교체), logical_group 당 effective 1건.
  const created = acts.filter(a => a.kind === "new").length, approvedNew = acts.filter(a => a.kind === "approved_new").length;
  const approvedUpdate = acts.filter(a => a.kind === "approved_update").length, updated = supersedePairs.length;
  const effAfter = await effectiveCount(dbx, opts.sourceType);
  const expected = effBefore + created + approvedNew - deleted;
  if (effAfter !== expected) throw new Error(`effective invariant 위반: expected ${expected} ≠ ${effAfter}. 롤백합니다.`);
  const dup = await dbx.select({ k: T.logicalGroupKey, n: count() }).from(T)
    .where(and(eq(T.sourceType, opts.sourceType), eq(T.isEffective, true), isNotNull(T.logicalGroupKey)))
    .groupBy(T.logicalGroupKey).having(sql`count(*) > 1`);
  if (dup.length) throw new Error(`logical_group effective 유일성 위반: ${dup.length}건. 롤백합니다.`);

  return {
    ...base, mode: "applied", batchId: batch.id, snapshotId: batch.id,
    applied: { created, approvedNew, approvedUpdate, updated: updated - approvedUpdate, evidenceSame: 0 },
    deleted, held: heldIdx.length, linksCarried, linkReview, newLinks, supersededSnapshotIds: [],
    effective: { before: effBefore, after: effAfter }, created: insertedId.size,
  };
}

// ─── 배치 되돌리기 ──────────────────────────────────────────────────────────────
// 해당 업로드가 실제로 바꾼 행만 되돌린다(삭제 없음, 플래그 복원).
//   · 이 배치가 추가한 행 중 지금도 유효한 행 → 비유효 처리 + 이 배치가 대체했던 이전 버전 복원.
//   · 이 배치의 행이 이후 다른 업로드로 다시 수정된 경우 → 그 이후 수정본을 보존(이 행은 건드리지 않음).
//   · 이전 버전이 이미 되돌린 배치의 것이면 그보다 앞선 유효 버전까지 거슬러 복원(되돌린 내용이 부활하지 않게).
//   · 판매·진행 연결: 복원된 이전 버전에도 현재 유효한 상대 행과의 연결이 유지되도록 보완(append).
//   · 통번역사 Master 매핑·원본 최초 배치는 손대지 않는다(원본 배치는 되돌리기 대상 아님).
export interface RollbackPlan {
  ok: boolean; reason: string;
  batchId: number; sourceType: string | null; fileName: string | null; createdAt: unknown;
  rowsInBatch: number; effectiveInBatch: number; restoreSuperseded: number; preservedLater: number; carriedLinks: number; linksToReattach: number;
  undelete: number;   // 이 배치가 삭제(비활성)한 행 중 복구할 행
  effective: { before: number; afterExpected: number };
}
interface RollbackTargets { deactivate: number[]; restore: Map<number, number>; preserved: number[]; carriedLinkIds: number[]; reattach: { linkId: number; sale: number; prog: number }[]; undelete: number[] }

async function computeRollbackTargets(dbx: any, batchId: number, sourceType: string): Promise<RollbackTargets> {
  const rows = (await dbx.execute(sql`SELECT id, is_effective AS e, superseded_by_id AS s FROM legacy_archive_rows WHERE import_batch_id = ${batchId}`)).rows as any[];
  const deactivate = rows.filter(r => r.e).map(r => Number(r.id));
  const preserved = rows.filter(r => !r.e && r.s != null).map(r => Number(r.id));
  // 대체 체인(이전 버전 → 다음 버전) + 배치 상태
  const chain = (await dbx.execute(sql`
    SELECT r.id, r.superseded_by_id AS s, b.status FROM legacy_archive_rows r LEFT JOIN import_batches b ON b.id = r.import_batch_id
    WHERE r.source_type = ${sourceType} AND r.superseded_by_id IS NOT NULL`)).rows as any[];
  const predOf = new Map<number, { id: number; status: string | null }>();
  for (const c of chain) predOf.set(Number(c.s), { id: Number(c.id), status: c.status ?? null });
  const restore = new Map<number, number>();   // 비유효 처리할 행 → 복원할 이전 버전
  for (const d of deactivate) {
    let pred = predOf.get(d);
    for (let guard = 0; pred && pred.status === "rolled_back" && guard < 100; guard++) pred = predOf.get(pred.id);
    if (pred) restore.set(d, pred.id);
  }
  const carried = deactivate.length ? (await dbx.execute(sql`
    SELECT id FROM legacy_sales_progress_links WHERE decision = 'confirmed'
      AND ((match_method = ${LINK_CARRY_METHOD} AND match_key LIKE ${`batch:${batchId}|%`})
        OR id IN (SELECT entity_id FROM import_row_sources WHERE batch_id = ${batchId} AND status = 'link_new'))
      AND (sale_row_id = ANY(${sql.raw(`ARRAY[${deactivate.join(",")}]::int[]`)}) OR progress_row_id = ANY(${sql.raw(`ARRAY[${deactivate.join(",")}]::int[]`)}))`)).rows as any[] : [];
  // 복원되는 이전 버전에 '현재 유효한 상대 행' 연결 보완 — 이후 다른 업로드가 상대 행을 수정했어도 연결 유지.
  const reattach: RollbackTargets["reattach"] = [];
  const restoreFrom = [...restore.keys()];
  if (restoreFrom.length) {
    const arr = sql.raw(`ARRAY[${restoreFrom.join(",")}]::int[]`);
    const touching = (await dbx.execute(sql`
      SELECT l.id, l.sale_row_id AS sale, l.progress_row_id AS prog, s.is_effective AS se, p.is_effective AS pe
      FROM legacy_sales_progress_links l JOIN legacy_archive_rows s ON s.id = l.sale_row_id JOIN legacy_archive_rows p ON p.id = l.progress_row_id
      WHERE l.decision = 'confirmed' AND (l.sale_row_id = ANY(${arr}) OR l.progress_row_id = ANY(${arr}))`)).rows as any[];
    for (const t of touching) {
      const saleSide = restore.has(Number(t.sale)), progSide = restore.has(Number(t.prog));
      const sale = saleSide ? restore.get(Number(t.sale))! : Number(t.sale);
      const prog = progSide ? restore.get(Number(t.prog))! : Number(t.prog);
      const otherEffective = saleSide ? t.pe : t.se;
      if (otherEffective || (saleSide && progSide)) reattach.push({ linkId: Number(t.id), sale, prog });
    }
  }
  // 이 배치의 '최신 파일 기준 삭제' 복구 대상 — 지금도 비유효·미대체인 행만(이후 버전이 생긴 행은 건드리지 않음).
  const undel = (await dbx.execute(sql`
    SELECT DISTINCT r.id FROM import_row_sources s JOIN legacy_archive_rows r ON r.id = s.entity_id
    WHERE s.batch_id = ${batchId} AND s.status = ${SYNC_LOG.deleted} AND NOT r.is_effective AND r.superseded_by_id IS NULL`)).rows as any[];
  return { deactivate, restore, preserved, carriedLinkIds: carried.map(r => Number(r.id)), reattach, undelete: undel.map(r => Number(r.id)) };
}

export async function planBatchRollback(dbx: any, batchId: number): Promise<RollbackPlan> {
  const [b] = await dbx.select().from(importBatchesTable).where(eq(importBatchesTable.id, batchId)).limit(1);
  const empty: RollbackPlan = { ok: false, reason: "", batchId, sourceType: b?.sourceType ?? null, fileName: b?.originalFilename ?? null, createdAt: b?.createdAt ?? null,
    rowsInBatch: 0, effectiveInBatch: 0, restoreSuperseded: 0, preservedLater: 0, carriedLinks: 0, linksToReattach: 0, undelete: 0, effective: { before: 0, afterExpected: 0 } };
  if (!b || b.module !== "legacy_archive") return { ...empty, reason: "과거 CRM 업로드 배치가 아닙니다." };
  if (b.status === "rolled_back") return { ...empty, reason: "이미 되돌린 배치입니다." };
  if (b.status !== "completed") return { ...empty, reason: `완료 상태가 아닌 배치(${b.status})입니다.` };
  const mark = await dbx.select({ n: count() }).from(importRowSourcesTable).where(and(eq(importRowSourcesTable.batchId, batchId), eq(importRowSourcesTable.status, SYNC_MARK_STATUS)));
  if (Number(mark[0].n) === 0) return { ...empty, reason: "반복 업로드 기능 이전에 등록된 원본 배치는 되돌릴 수 없습니다(전체 원본 보호)." };
  const t = await computeRollbackTargets(dbx, batchId, b.sourceType);
  // 삭제를 포함한 배치는 이후 동기화가 없을 때만 되돌린다(이후 업로드가 같은 업무를 다시 등록했을 수 있어 복구 시 중복 위험).
  if (t.undelete.length) {
    const later = (await dbx.execute(sql`SELECT count(*)::int AS n FROM import_batches b WHERE b.module = 'legacy_archive' AND b.source_type = ${b.sourceType}
      AND b.id > ${batchId} AND b.status = 'completed' AND EXISTS (SELECT 1 FROM import_row_sources s WHERE s.batch_id = b.id AND s.status = ${SYNC_MARK_STATUS})`)).rows[0] as any;
    if (Number(later.n) > 0) return { ...empty, undelete: t.undelete.length, reason: `이후 동기화 ${later.n}건이 있어 삭제 복구를 포함한 되돌리기는 최신 동기화부터 순서대로 진행해야 합니다.` };
  }
  const total = (await dbx.execute(sql`SELECT count(*)::int AS n FROM legacy_archive_rows WHERE import_batch_id = ${batchId}`)).rows[0] as any;
  const before = await effectiveCount(dbx, b.sourceType);
  return { ...empty, ok: true,
    reason: t.preserved.length ? `되돌리기 가능 — 이후 다른 업로드로 다시 수정된 ${t.preserved.length}건은 보존` : "되돌리기 가능",
    rowsInBatch: total.n, effectiveInBatch: t.deactivate.length, restoreSuperseded: t.restore.size, preservedLater: t.preserved.length,
    carriedLinks: t.carriedLinkIds.length, linksToReattach: t.reattach.length, undelete: t.undelete.length,
    effective: { before, afterExpected: before - t.deactivate.length + t.restore.size + t.undelete.length } };
}

export async function executeBatchRollback(dbx: any, batchId: number, performerId: number | null) {
  const plan = await planBatchRollback(dbx, batchId);
  if (!plan.ok) throw new SyncError("ROLLBACK_NOT_ALLOWED", 409, plan.reason);
  const st = plan.sourceType as ArchiveSourceType;
  const t = await computeRollbackTargets(dbx, batchId, st);
  const ids = (a: number[]) => sql.raw(`ARRAY[${a.length ? a.join(",") : "0"}]::int[]`);
  // ① 이 배치가 추가해 지금도 유효한 행만 비유효 처리(삭제 없음). 이후 수정된 행은 이미 비유효이므로 대상 아님.
  const deact = t.deactivate.length ? await dbx.execute(sql`UPDATE legacy_archive_rows SET is_effective = false WHERE id = ANY(${ids(t.deactivate)}) AND is_effective`) : { rowCount: 0 };
  // ② 이전 버전 복원
  const restoreIds = [...new Set(t.restore.values())];
  const restored = restoreIds.length ? await dbx.execute(sql`UPDATE legacy_archive_rows SET is_effective = true, superseded_by_id = NULL WHERE id = ANY(${ids(restoreIds)}) AND NOT is_effective`) : { rowCount: 0 };
  // ②-b 최신 파일 기준 삭제(비활성) 복구
  const undeleted = t.undelete.length ? await dbx.execute(sql`UPDATE legacy_archive_rows SET is_effective = true WHERE id = ANY(${ids(t.undelete)}) AND NOT is_effective AND superseded_by_id IS NULL`) : { rowCount: 0 };
  // ③ 이 배치가 이관한 연결은 삭제하지 않고 rolled_back 처리
  const lk = t.carriedLinkIds.length ? await dbx.execute(sql`UPDATE legacy_sales_progress_links SET decision = 'rolled_back' WHERE id = ANY(${ids(t.carriedLinkIds)})`) : { rowCount: 0 };
  // ④ 복원된 이전 버전 ↔ 현재 유효 상대 행 연결 보완(append, 중복 무시)
  let reattached = 0;
  for (const r of t.reattach) {
    const ins = await upsertConfirmedLink(dbx, { saleRowId: r.sale, progressRowId: r.prog, saleNo: null, matchKey: `rollback:${batchId}|from_link:${r.linkId}`, matchMethod: LINK_CARRY_METHOD });
    reattached += ins.length;
  }
  await dbx.update(importBatchesTable).set({ status: "rolled_back", isCurrent: false }).where(eq(importBatchesTable.id, batchId));
  await dbx.insert(importRowSourcesTable).values({ batchId, module: "legacy_archive", entityId: null, rowKey: "rollback", status: SYNC_LOG.rolledBack, sourceSystem: SOURCE_SYSTEM,
    sourceRaw: { performerId, deactivated: Number(deact.rowCount ?? 0), restored: Number(restored.rowCount ?? 0), undeleted: Number(undeleted.rowCount ?? 0), preservedLater: t.preserved, linksRolledBack: Number(lk.rowCount ?? 0), linksReattached: reattached, at: new Date().toISOString() } });

  const after = await effectiveCount(dbx, st);
  if (after !== plan.effective.afterExpected) throw new Error(`되돌리기 invariant 위반: expected ${plan.effective.afterExpected} ≠ ${after}. 롤백합니다.`);
  const dup = await dbx.select({ k: T.logicalGroupKey, n: count() }).from(T)
    .where(and(eq(T.sourceType, st), eq(T.isEffective, true), isNotNull(T.logicalGroupKey))).groupBy(T.logicalGroupKey).having(sql`count(*) > 1`);
  if (dup.length) throw new Error(`logical_group effective 유일성 위반: ${dup.length}건. 롤백합니다.`);
  return { ...plan, deactivated: Number(deact.rowCount ?? 0), restored: Number(restored.rowCount ?? 0), undeleted: Number(undeleted.rowCount ?? 0), linksRolledBack: Number(lk.rowCount ?? 0), linksReattached: reattached,
    effective: { before: plan.effective.before, afterExpected: plan.effective.afterExpected, after } };
}

// 배치 변경 로그 조회(감사용).
export async function listBatchChanges(dbx: any, batchId: number, status: string | null, page: number, pageSize: number) {
  const size = Math.min(200, Math.max(10, pageSize || 50));
  const where = status ? and(eq(importRowSourcesTable.batchId, batchId), eq(importRowSourcesTable.status, status)) : eq(importRowSourcesTable.batchId, batchId);
  const total = Number((await dbx.select({ n: count() }).from(importRowSourcesTable).where(where))[0].n);
  const byStatus = (await dbx.select({ s: importRowSourcesTable.status, n: count() }).from(importRowSourcesTable)
    .where(eq(importRowSourcesTable.batchId, batchId)).groupBy(importRowSourcesTable.status)) as { s: string; n: number }[];
  const rows = await dbx.select().from(importRowSourcesTable).where(where).orderBy(importRowSourcesTable.id).limit(size).offset((Math.max(1, page) - 1) * size);
  return { batchId, total, page: Math.max(1, page), pageSize: size, byStatus: Object.fromEntries(byStatus.map(x => [x.s, Number(x.n)])), rows };
}

// ═══ 판매목록·진행관리표 통합 동기화(같은 기준일 · 전부 반영 또는 전무) ═══════════════════════════
//   · 미리보기: 진행관리표 → 판매목록 순으로 판정(판매 삭제 충돌은 '같은 실행에서 삭제되는 수행행'을 제외하고 판정).
//   · 실행: 단일 DB 트랜잭션 + advisory lock(동시 실행 차단). 판매목록 → 진행관리표 순 반영, 어느 하나 실패 시 전체 롤백.
//   · 기준일(asOfDate)은 각 배치의 sync_batch 로그에 보존. 이전 기준일보다 오래된 파일은 차단.
//   · 되돌리기: runId 로 묶인 두 배치를 한 트랜잭션에서 되돌린다(진행 → 판매).
const FULL_SYNC_LOCK_KEY = 74123001;   // pg advisory lock — 과거 CRM 동기화 전용
const AS_OF_RE = /^\d{4}-\d{2}-\d{2}$/;
export interface FullSyncSet {
  id: string; userId: number | null; at: number; asOfDate: string; scope: SyncScope;
  salesName: string; progressName: string; sales: SyncPreview; progress: SyncPreview;
  lastAsOf: { sales_list: string | null; progress: string | null };
  blockers: { code: string; message: string; source?: ArchiveSourceType }[];
  links: { salesDeletedWithProgressDeleted: number; progressDeletedSaleKept: number };
  // 관리자 판매취소 확인 대상(선택 실행) — 삭제 충돌 중 '수행행 유지'(linked_progress) 판매건. 운영 전환(activated)은 제외(항상 보호).
  cancelCandidates: { saleIds: number[]; progressRows: number; progressPretax: number };
}

// 판매취소 확인 판매건에 연결된 유효 수행행 — 다른 유지 판매건에도 연결된 행·운영 전환 행은 제외(보호).
async function linkedProgressForCancel(dbx: any, saleIds: number[], excludeProgress: Set<number>): Promise<{ id: number; pretax: number }[]> {
  if (!saleIds.length) return [];
  const arr = sql.raw(`ARRAY[${saleIds.join(",")}]::int[]`);
  const rows = (await dbx.execute(sql`
    SELECT DISTINCT p.id, coalesce(p.payout_pretax, 0)::numeric AS pretax FROM legacy_sales_progress_links l
    JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective AND p.superseded_by_id IS NULL
    WHERE l.decision = 'confirmed' AND l.sale_row_id = ANY(${arr})
      AND NOT EXISTS (SELECT 1 FROM legacy_sales_progress_links l2 JOIN legacy_archive_rows s2 ON s2.id = l2.sale_row_id AND s2.is_effective
        WHERE l2.progress_row_id = p.id AND l2.decision = 'confirmed' AND NOT (l2.sale_row_id = ANY(${arr})))`)).rows as any[];
  const cand = rows.filter(r => !excludeProgress.has(Number(r.id)));
  if (!cand.length) return [];
  const asRows = cand.map(r => ({ id: Number(r.id) } as any));
  const { toDelete } = await classifyDeletions(dbx, "progress", asRows);   // 운영 전환 수행행은 제외
  const keep = new Set(toDelete.map(r => Number(r.id)));
  return cand.filter(r => keep.has(Number(r.id))).map(r => ({ id: Number(r.id), pretax: Number(r.pretax) }));
}
const fullSyncCache = new Map<string, FullSyncSet>();
function pruneFull() { const now = Date.now(); for (const [k, v] of fullSyncCache) if (now - v.at > PREVIEW_TTL_MS) fullSyncCache.delete(k); while (fullSyncCache.size > 2) fullSyncCache.delete(fullSyncCache.keys().next().value as string); }

export async function lastSyncAsOf(dbx: any): Promise<{ sales_list: string | null; progress: string | null }> {
  const rows = (await dbx.execute(sql`
    SELECT b.source_type AS t, max(s.source_raw->>'asOfDate') AS d FROM import_row_sources s JOIN import_batches b ON b.id = s.batch_id
    WHERE s.status = ${SYNC_MARK_STATUS} AND b.status = 'completed' AND b.module = 'legacy_archive' AND nullif(s.source_raw->>'asOfDate','') IS NOT NULL
    GROUP BY b.source_type`)).rows as any[];
  const m = new Map(rows.map(r => [r.t, r.d ?? null]));
  return { sales_list: m.get("sales_list") ?? null, progress: m.get("progress") ?? null };
}
function staleBlockers(asOfDate: string, last: { sales_list: string | null; progress: string | null }) {
  const out: { code: string; message: string }[] = [];
  if (!AS_OF_RE.test(asOfDate)) out.push({ code: "AS_OF_INVALID", message: "동기화 기준일(YYYY-MM-DD)을 입력하세요." });
  const maxLast = [last.sales_list, last.progress].filter(Boolean).sort().pop() ?? null;
  if (maxLast && AS_OF_RE.test(asOfDate) && asOfDate < maxLast) out.push({ code: "STALE_AS_OF", message: `기준일 ${asOfDate}이 최종 동기화 기준일 ${maxLast}보다 이전입니다 — 최신 자료를 오래된 파일로 덮어쓸 수 없습니다(실행 차단).` });
  return out;
}

export async function buildFullSyncPreview(dbx: any, o: { salesBuffer: Buffer; progressBuffer: Buffer; salesName: string; progressName: string; asOfDate: string; scope: SyncScope; userId: number | null }): Promise<FullSyncSet> {
  const progress = await buildSyncPreview(dbx, { buffer: o.progressBuffer, sourceType: "progress", scope: o.scope });
  const progDel = new Set(progress.plan.deletionSuspects.map(e => Number(e.id)));
  const sales = await buildSyncPreview(dbx, { buffer: o.salesBuffer, sourceType: "sales_list", scope: o.scope, progressDeletionIds: progDel });
  const lastAsOf = await lastSyncAsOf(dbx);
  const blockers = [
    ...staleBlockers(o.asOfDate, lastAsOf),
    ...sales.blockers.map(b => ({ ...b, source: "sales_list" as const, message: `[판매목록] ${b.message}` })),
    ...progress.blockers.map(b => ({ ...b, source: "progress" as const, message: `[진행관리표] ${b.message}` })),
  ];
  // 연결 검증(미리보기) — 판매 삭제 ↔ 수행행 삭제 동반 여부, 수행행만 삭제(판매 유지 = 일부 수행행 삭제 정상)
  const salesDel = sales.plan.deletionSuspects.map(e => Number(e.id));
  let salesDeletedWithProgressDeleted = 0, progressDeletedSaleKept = 0;
  if (salesDel.length || progDel.size) {
    const r = (await dbx.execute(sql`
      SELECT
        (SELECT count(DISTINCT l.sale_row_id) FROM legacy_sales_progress_links l WHERE l.decision = 'confirmed'
           AND l.sale_row_id = ANY(${sql.raw(`ARRAY[${salesDel.join(",") || "0"}]::int[]`)})
           AND l.progress_row_id = ANY(${sql.raw(`ARRAY[${[...progDel].join(",") || "0"}]::int[]`)}))::int AS a,
        (SELECT count(DISTINCT l.progress_row_id) FROM legacy_sales_progress_links l JOIN legacy_archive_rows s ON s.id = l.sale_row_id AND s.is_effective
           WHERE l.decision = 'confirmed' AND l.progress_row_id = ANY(${sql.raw(`ARRAY[${[...progDel].join(",") || "0"}]::int[]`)})
           AND NOT (l.sale_row_id = ANY(${sql.raw(`ARRAY[${salesDel.join(",") || "0"}]::int[]`)})))::int AS b`)).rows[0] as any;
    salesDeletedWithProgressDeleted = Number(r.a); progressDeletedSaleKept = Number(r.b);
  }
  const cancelSaleIds = sales.plan.deletionConflicts.filter(c => c.code === "linked_progress").map(c => Number(c.row.id));
  const cancelProg = await linkedProgressForCancel(dbx, cancelSaleIds, progDel);
  pruneFull();
  for (const p of [sales, progress]) for (const r of p.allRows) (r as any).rawRow = undefined;
  const set: FullSyncSet = { id: crypto.randomUUID(), userId: o.userId, at: Date.now(), asOfDate: o.asOfDate, scope: o.scope, salesName: o.salesName, progressName: o.progressName,
    sales, progress, lastAsOf, blockers, links: { salesDeletedWithProgressDeleted, progressDeletedSaleKept },
    cancelCandidates: { saleIds: cancelSaleIds, progressRows: cancelProg.length, progressPretax: cancelProg.reduce((a, r) => a + r.pretax, 0) } };
  fullSyncCache.set(set.id, set);
  return set;
}
export function getFullSyncSet(id: string, userId: number | null): FullSyncSet | null {
  pruneFull(); const s = fullSyncCache.get(id);
  return s && !(s.userId != null && userId != null && s.userId !== userId) ? s : null;
}
export function summarizeFullSync(s: FullSyncSet) {
  return { fullSyncId: s.id, asOfDate: s.asOfDate, scope: s.scope, salesName: s.salesName, progressName: s.progressName, lastAsOf: s.lastAsOf,
    blockers: s.blockers, executable: s.blockers.length === 0, links: s.links,
    cancelCandidates: { sales: s.cancelCandidates.saleIds.length, progressRows: s.cancelCandidates.progressRows, progressPretax: s.cancelCandidates.progressPretax },
    sales: summarizePreview(s.sales), progress: summarizePreview(s.progress) };
}

export async function executeFullSync(tx: any, o: { fullSyncId: string; salesToken: string; progressToken: string; userId: number | null; cancelConfirmedSales?: boolean; cancelLinkedProgress?: boolean }) {
  const lock = (await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${FULL_SYNC_LOCK_KEY}) AS ok`)).rows[0] as any;
  if (!lock?.ok) throw new SyncError("SYNC_RUNNING", 409, "다른 과거 CRM 동기화가 실행 중입니다. 완료 후 다시 시도하세요.");
  const set = getFullSyncSet(o.fullSyncId, o.userId);
  if (!set) throw new SyncError("PREVIEW_EXPIRED", 410, "미리보기 결과가 만료되었습니다. 두 파일로 미리보기를 다시 실행하세요.");
  if (set.blockers.length) throw new SyncError("SYNC_BLOCKED", 409, set.blockers.map(b => b.message).join(" / "), set.blockers);
  // 쓰기 전에 두 승인 토큰을 현재 기준선과 대조(판매 반영 후에는 연결 지문이 바뀌므로 반드시 선검증).
  for (const [p, tok] of [[set.sales, o.salesToken], [set.progress, o.progressToken]] as [SyncPreview, string][]) {
    const now = computePlanToken(p.sourceType, p.fileHash, p.scope, await baselineFingerprint(tx, p.sourceType));
    if (!tok || tok !== p.planToken || now !== p.planToken) throw new SyncError("SYNC_PLAN_CHANGED", 409, `미리보기 이후 ${SOURCE_TYPE_LABEL[p.sourceType]} 기준 자료가 바뀌었습니다. 미리보기를 다시 실행하세요.`);
  }
  const stale = staleBlockers(set.asOfDate, await lastSyncAsOf(tx));
  if (stale.length) throw new SyncError("STALE_AS_OF", 409, stale.map(b => b.message).join(" / "));
  const runId = crypto.randomUUID();
  const common = { performerId: o.userId, scope: set.scope, approvedAmbiguous: new Set<string>(), asOfDate: set.asOfDate, runId, buffer: Buffer.alloc(0) };
  // 두 파일 중 하나라도 반영할 변경이 있으면 양쪽 모두 같은 기준일 배치를 남긴다(기준일 불일치 방지). 둘 다 변경 0이면 아무것도 쓰지 않는다.
  const hasChange = (p: SyncPreview) => p.plan.deletionSuspects.length > 0 || p.plan.decisions.some(d => (d.classification === "NEW" || d.classification === "UPDATED") && !p.storedKeys.has(d.key));
  const marker = hasChange(set.sales) || hasChange(set.progress);
  const sales = await executeArchiveSync(tx, { ...common, preview: set.sales, sourceType: "sales_list", fileName: set.salesName, planToken: o.salesToken, recordMarkerIfNoChange: marker });
  const progress = await executeArchiveSync(tx, { ...common, preview: set.progress, sourceType: "progress", fileName: set.progressName, planToken: o.progressToken, recordMarkerIfNoChange: marker });
  // 관리자 판매취소 확인(선택): 삭제 충돌(수행행 유지) 판매건을 비활성화. 연결 수행행은 cancelLinkedProgress 일 때만
  //   (기본: 최신 파일에 남아 있는 수행행은 유지하고 결과에 보고).
  //   같은 실행의 배치에 sync_deleted 로 기록 → 통합 되돌리기로 함께 복구. 운영 전환 자료는 대상에서 제외.
  let cancelled = { sales: 0, progress: 0 };
  if (o.cancelConfirmedSales && set.cancelCandidates.saleIds.length) {
    const sIds = set.cancelCandidates.saleIds;
    const pRows = o.cancelLinkedProgress ? await linkedProgressForCancel(tx, sIds, new Set()) : [];
    const deact = async (ids: number[]) => ids.length ? (await tx.update(T).set({ isEffective: false })
      .where(and(inArray(T.id, ids), eq(T.isEffective, true), sql`${T.supersededById} IS NULL`)).returning({ id: T.id })).map((r: any) => Number(r.id)) : [];
    const ds = await deact(sIds), dp = await deact(pRows.map(r => r.id));
    if (ds.length !== sIds.length) throw new Error(`판매취소 대상 불일치: ${sIds.length} ≠ ${ds.length}. 롤백합니다.`);
    const log = (batchId: number | null, ids: number[], kind: string) => batchId == null || !ids.length ? [] : ids.map(id => ({ batchId, module: "legacy_archive", entityId: id,
      rowKey: `existing:${id}`, status: SYNC_LOG.deleted, sourceSystem: SOURCE_SYSTEM, sourceRaw: { reason: "admin_cancel_confirmed", kind, performerId: o.userId, asOfDate: set.asOfDate } }));
    if (sales.batchId == null || progress.batchId == null) throw new Error("판매취소 처리 기록 배치가 없습니다. 롤백합니다.");
    await insertLogs(tx, [...log(sales.batchId, ds, "sale"), ...log(progress.batchId, dp, "progress_of_cancelled_sale")]);
    cancelled = { sales: ds.length, progress: dp.length };
  }
  // 판매취소 판매에 연결된 채 유지되는 수행행(최신 파일에 존재) — 보고용
  const keptOfCancelled = o.cancelConfirmedSales && set.cancelCandidates.saleIds.length ? ((await tx.execute(sql`
    SELECT s.source_raw->>'판매번호' AS sale_no, p.id, p.translator_name, p.delivery_date::text AS delivery, p.payout_date::text AS payout, coalesce(p.payout_pretax,0)::numeric AS pretax
    FROM legacy_sales_progress_links l JOIN legacy_archive_rows s ON s.id = l.sale_row_id JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective
    WHERE l.decision = 'confirmed' AND l.sale_row_id = ANY(${sql.raw(`ARRAY[${set.cancelCandidates.saleIds.join(",")}]::int[]`)}) ORDER BY 1, p.id`)).rows as any[]) : [];
  const integrity = await syncIntegrity(tx, [sales.batchId, progress.batchId].filter((x): x is number => x != null));
  if (integrity.newLinksToInactive > 0) throw new Error(`연결 무결성 위반: 이번 동기화가 비유효 행과의 연결 ${integrity.newLinksToInactive}건을 만들었습니다. 롤백합니다.`);
  if (integrity.orphanedByRun > 0) throw new Error(`연결 무결성 위반: 이번 동기화로 판매건을 잃은 수행행 ${integrity.orphanedByRun}건. 롤백합니다.`);
  fullSyncCache.delete(set.id);
  return { runId: sales.batchId || progress.batchId ? runId : null, asOfDate: set.asOfDate, mode: sales.mode === "no_change" && progress.mode === "no_change" ? "no_change" : "applied", sales, progress, integrity, cancelled,
    keptProgressOfCancelledSales: keptOfCancelled.map(r => ({ saleNo: r.sale_no, progressRowId: Number(r.id), translator: r.translator_name, deliveryDate: r.delivery, payoutDate: r.payout, pretax: Number(r.pretax) })) };
}

// 동기화 후 연결 정합성(읽기 전용). 신규 연결(link_new)만 대상 — 수정 건의 연결 이관(link_carry)은 기존 관계 보존이므로
//   같은 실행에서 삭제된 상대 행을 가리켜도 정상(업무 조회는 양쪽 is_effective 로 필터).
export async function syncIntegrity(dbx: any, batchIds: number[]) {
  const arr = sql.raw(`ARRAY[${batchIds.join(",") || "0"}]::int[]`);
  const r = (await dbx.execute(sql`
    SELECT
      (SELECT count(*) FROM legacy_sales_progress_links l JOIN legacy_archive_rows s ON s.id = l.sale_row_id JOIN legacy_archive_rows p ON p.id = l.progress_row_id
        WHERE l.decision = 'confirmed' AND (NOT s.is_effective OR NOT p.is_effective)
          AND l.id IN (SELECT entity_id FROM import_row_sources WHERE batch_id = ANY(${arr}) AND status = 'link_new'))::int AS new_links_to_inactive,
      (SELECT count(DISTINCT p.id) FROM legacy_archive_rows p JOIN legacy_sales_progress_links l ON l.progress_row_id = p.id AND l.decision = 'confirmed'
        WHERE p.is_effective AND p.source_type = 'progress'
          AND l.sale_row_id IN (SELECT entity_id FROM import_row_sources WHERE batch_id = ANY(${arr}) AND status = ${SYNC_LOG.deleted}
            AND coalesce(source_raw->>'reason','') <> 'admin_cancel_confirmed')
          AND NOT EXISTS (SELECT 1 FROM legacy_sales_progress_links l2 JOIN legacy_archive_rows s2 ON s2.id = l2.sale_row_id AND s2.is_effective
            WHERE l2.progress_row_id = p.id AND l2.decision = 'confirmed'))::int AS orphaned_by_run,
      (SELECT count(*) FROM (SELECT logical_group_key FROM legacy_archive_rows WHERE is_effective AND logical_group_key IS NOT NULL GROUP BY source_type, logical_group_key HAVING count(*) > 1) x)::int AS dup_groups,
      (SELECT count(*) FROM legacy_archive_rows WHERE source_type = 'progress' AND is_effective)::int AS progress_effective,
      (SELECT count(*) FROM legacy_archive_rows WHERE source_type = 'sales_list' AND is_effective)::int AS sales_effective`)).rows[0] as any;
  return { newLinksToInactive: Number(r.new_links_to_inactive), orphanedByRun: Number(r.orphaned_by_run), duplicateGroups: Number(r.dup_groups),
    progressEffective: Number(r.progress_effective), salesEffective: Number(r.sales_effective) };
}

export async function listFullSyncRuns(dbx: any, limit = 20) {
  const rows = (await dbx.execute(sql`
    SELECT s.source_raw->>'runId' AS run_id, s.source_raw->>'asOfDate' AS as_of, b.id AS batch_id, b.source_type, b.original_filename, b.status, b.created_at,
      coalesce((s.source_raw->>'deleted')::int, 0) AS deleted, s.source_raw->'counts' AS counts, s.source_raw->>'performerId' AS performer
    FROM import_row_sources s JOIN import_batches b ON b.id = s.batch_id
    WHERE s.status = ${SYNC_MARK_STATUS} AND nullif(s.source_raw->>'runId','') IS NOT NULL
    ORDER BY b.id DESC LIMIT ${limit * 2}`)).rows as any[];
  const m = new Map<string, any>();
  for (const r of rows) {
    const g = m.get(r.run_id) ?? { runId: r.run_id, asOfDate: r.as_of, createdAt: r.created_at, performerId: r.performer ? Number(r.performer) : null, batches: [] as any[] };
    g.batches.push({ batchId: Number(r.batch_id), sourceType: r.source_type, fileName: r.original_filename, status: r.status, deleted: Number(r.deleted), counts: r.counts });
    m.set(r.run_id, g);
  }
  return [...m.values()].slice(0, limit).map(g => ({ ...g, rolledBack: g.batches.every((b: any) => b.status === "rolled_back") }));
}

export async function rollbackFullSync(tx: any, runId: string, performerId: number | null) {
  const lock = (await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${FULL_SYNC_LOCK_KEY}) AS ok`)).rows[0] as any;
  if (!lock?.ok) throw new SyncError("SYNC_RUNNING", 409, "다른 과거 CRM 동기화가 실행 중입니다.");
  const batches = (await tx.execute(sql`
    SELECT b.id, b.source_type, b.status FROM import_row_sources s JOIN import_batches b ON b.id = s.batch_id
    WHERE s.status = ${SYNC_MARK_STATUS} AND s.source_raw->>'runId' = ${runId} ORDER BY CASE b.source_type WHEN 'progress' THEN 0 ELSE 1 END`)).rows as any[];
  if (!batches.length) throw new SyncError("RUN_NOT_FOUND", 404, "동기화 실행 기록을 찾을 수 없습니다.");
  const out: any[] = [];
  for (const b of batches) { if (b.status === "rolled_back") continue; out.push(await executeBatchRollback(tx, Number(b.id), performerId)); }
  if (!out.length) throw new SyncError("ROLLBACK_NOT_ALLOWED", 409, "이미 되돌린 동기화입니다.");
  return { runId, rolledBack: out };
}
