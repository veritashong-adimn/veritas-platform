// ─── 과거 CRM 견적 품목 상세정보(파일명·단어수·글자수·수량·단가·단위) 복원 ─────────────────────────
//
// 원인: 과거 CRM 판매를 운영 판매로 전환(legacySaleActivation)할 때 견적 품목을 '수량 1 × 단가 = 공급가액, 단위 건, 비고 없음'
//       1개로만 만들었다. 연결된 진행관리표 원본 행의 수량·단가·단위·파일명·글자수·단어수는 품목으로 옮기지 않았다.
//
// 원본 구조(운영 DB 확인): 진행관리표는 '견적 품목'이 아니라 '수행(통번역사 배정)' 단위 행이다.
//   · 공급가액·부가세·총액은 모든 행에 판매 합계가 반복된다.
//   · 판매에 행이 여러 개면 수량·단가·글자수·단어수도 대표값(첫 품목·합계 등)이 반복되어 품목별 값으로 쓸 수 없다.
//   · 파일명 칸은 수행 행마다 다른 정보(번역 파일명, 통역의 '교통비'·장비 설명 등)를 담는다.
//   · 견적서 품목 비고(예: '1440자(공백제외), 1장 700자 기준')와 파일형식은 업로드된 Excel 에 칸이 없다.
//     진행관리표 '비고'는 판매 단위 내부 메모(예: '선금 발행')라 고객용 견적서 품목 비고로 옮기지 않는다.
//
// 그래서 원본 값이 하나로 확인되는 경우만 복원한다(decideItemDetail):
//   · 연결 진행행의 (내용·수량·단가·단위·파일명·글자수·단어수) 조합이 정확히 1개
//     - 통역: 진행행 = 통번역사 배정 행이라 '파일명' 칸에 수행 메모(예: '원천세제외 대상자')가 행마다 다르게 들어간다.
//       통역은 파일·단어수·글자수가 품목 정보가 아니므로 비교·복원에서 제외하고 (내용·수량·단가)만 본다(2026-11-12 킨텍스 사례).
//   · 내용 = 번역(문서형) 또는 통역(판매 수량 = 원본 '수량', 예: 35명 × 3일 = 105) — 그 밖의 내용은 자동 복원하지 않는다
//   · 수량 × 단가 = 플랫폼 품목 공급가액(1원 이내) — 금액은 새로 계산하지 않고 일치 확인에만 쓴다(불일치면 보류)
// 플랫폼 저장 형식: 기존 견적 편집기와 같은 memo 규약 "파일: … | 단어수: … | 글자수: …"(스키마 변경 없음).
//   파일형식은 원본에 없으므로 만들지 않는다.
// 단위: 진행관리표 '단위'(단어·글자·장)는 거래 수량의 단위가 아니라 통번역사 분량(통번역수량)의 산정 기준이다
//   (운영 DB: '단어' 행에서 통번역수량 = 단어수 4,540건, 판매 수량 = 단어수 112건). 판매 수량의 실제 거래 단위(건·페이지 등)는
//   업로드된 Excel 에 없으므로 견적 품목 단위로 쓰지 않는다 → 품목 단위는 바꾸지 않고(전환 시 기본 '건'), 원본 값은 volumeBasis 로 근거에만 남긴다.
//   단어수가 있다는 이유로 단위를 '단어'로 정하지 않는다. 실제 거래 단위 확인은 직원 확인 대상(unitCheck)이다.
import { sql } from "drizzle-orm";

type Dbx = { execute: (q: any) => Promise<{ rows: unknown[]; rowCount?: number | null }> };
const rows = async (dbx: Dbx, q: any) => (await dbx.execute(q)).rows as any[];

export const ITEM_RESTORE_MODULE = "legacy_quote_item_restore";

const numOf = (v: unknown): number | null => {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
};
/** 글자수·단어수 — 숫자만(콤마 제거). 0·빈값·숫자가 아닌 값은 없음으로 본다(원본 그대로 확인되는 값만) */
const countOf = (v: unknown): string | null => { const n = numOf(v); return n != null && n > 0 && Number.isInteger(n) ? String(n) : null; };
const textOf = (v: unknown): string | null => { const s = String(v ?? "").trim(); return s ? s : null; };

export interface SourceDetail {
  kind: string | null; quantity: number | null; unitPrice: number | null;
  volumeBasis: string | null;          // 원본 '단위' — 분량(통번역수량) 산정 기준(단어·글자·장). 거래 단위 아님
  translatorQuantity: string | null;   // 원본 '통번역수량' — volumeBasis 기준 분량(근거 기록용)
  fileName: string | null; charCount: string | null; wordCount: string | null; memo: string | null;
}
export function sourceDetailOf(raw: Record<string, unknown>): SourceDetail {
  return {
    kind: textOf(raw["내용"]), quantity: numOf(raw["수량"]), unitPrice: numOf(raw["단가"]), volumeBasis: textOf(raw["단위"]), translatorQuantity: countOf(raw["통번역수량"]),
    fileName: textOf(raw["파일명"]), charCount: countOf(raw["글자수"]), wordCount: countOf(raw["단어수"]), memo: textOf(raw["비고"]),
  };
}

export type DetailDecision =
  | { status: "restorable"; detail: SourceDetail; progressRows: number }
  | { status: "no_progress" | "multiple_values" | "not_document" | "amount_mismatch" | "no_quantity"; reason: string; detail?: SourceDetail; progressRows: number };

const RESTORABLE_KINDS = new Set(["번역", "통역"]);
/** 원본 '내용'과 플랫폼 품목 유형이 같은 종류인지(번역 ↔ translation, 통역 ↔ interpretation) — 다르면 복원하지 않는다 */
export function kindMatchesItemType(kind: string | null | undefined, itemType: string | null | undefined): boolean {
  return (kind === "번역" && itemType === "translation") || (kind === "통역" && itemType === "interpretation");
}

/** 원본 진행행들에서 품목 1개의 상세정보를 확정할 수 있는지 판정(값 생성·추정 없음) */
export function decideItemDetail(rawRows: Array<Record<string, unknown>>, supplyAmount: number): DetailDecision {
  const n = rawRows.length;
  if (!n) return { status: "no_progress", reason: "연결된 진행관리표 원본 행 없음", progressRows: 0 };
  // 통역 행은 파일명·단어수·글자수·단위(번역 서식 잔여값)를 품목 정보로 쓰지 않는다 — 비교·복원 모두에서 제외
  const ds = rawRows.map(sourceDetailOf).map(d => d.kind === "통역" ? { ...d, volumeBasis: null, translatorQuantity: null, fileName: null, charCount: null, wordCount: null } : d);
  const key = (d: SourceDetail) => JSON.stringify([d.kind, d.quantity, d.unitPrice, d.volumeBasis, d.fileName, d.charCount, d.wordCount]);
  const keys = new Set(ds.map(key));
  if (keys.size > 1) return { status: "multiple_values", reason: `진행관리표 행 ${n}개의 수량·단가·파일명 등이 서로 다름 — 수행(통번역사) 단위 행이라 견적 품목 값으로 확정 불가`, progressRows: n };
  const d = ds[0];
  if (!RESTORABLE_KINDS.has(d.kind ?? "")) return { status: "not_document", reason: `원본 내용 '${d.kind ?? "-"}' — 번역·통역 품목만 자동 복원`, detail: d, progressRows: n };
  if (d.quantity == null || d.unitPrice == null || d.quantity <= 0) return { status: "no_quantity", reason: "원본 수량·단가 없음", detail: d, progressRows: n };
  if (Math.abs(d.quantity * d.unitPrice - supplyAmount) > 1)
    return { status: "amount_mismatch", reason: `원본 수량×단가 ${(d.quantity * d.unitPrice).toLocaleString()}원 ≠ 공급가액 ${supplyAmount.toLocaleString()}원`, detail: d, progressRows: n };
  return { status: "restorable", detail: d, progressRows: n };
}

/** 견적 편집기·PDF 와 같은 memo 규약(파일·형식·단어수·글자수)으로 문서정보를 붙인다. 기존 사용자 비고는 앞에 그대로 둔다. */
export function encodeDocMemo(userMemo: string | null, d: Pick<SourceDetail, "fileName" | "wordCount" | "charCount">): string | null {
  const ref = [d.fileName && `파일: ${d.fileName}`, d.wordCount && `단어수: ${d.wordCount}`, d.charCount && `글자수: ${d.charCount}`].filter(Boolean).join(" | ");
  return [userMemo?.trim() || null, ref || null].filter(Boolean).join(" / ") || null;
}

// ─── 운영 전환 판매의 품목 복원 계획(읽기 전용) ─────────────────────────────────────
export interface ItemRestoreRow {
  saleNo: string; projectId: number; quoteId: number; quoteNumber: string | null; itemId: number | null;
  status: "restorable" | "already_restored" | "edited_after_activation" | "multi_item" | DetailDecision["status"];
  reason: string | null;
  before: { quantity: number; unit: string; unitPrice: number; supplyAmount: number; taxAmount: number; totalAmount: number; memo: string | null } | null;
  after: { quantity: number; unit: string; unitPrice: number; memo: string | null } | null;
  source: SourceDetail | null; progressRows: number;
  sourceMemoNotCopied: string | null;   // 진행관리표 '비고'(판매 단위 내부 메모) — 고객용 품목 비고로 옮기지 않음
  unitCheck: string | null;             // 실제 거래 단위 확인 필요 사유(원본에 거래 단위 없음) — 단위는 자동 변경하지 않음
}

export async function planItemRestore(dbx: Dbx, opts: { saleNos?: string[] } = {}): Promise<ItemRestoreRow[]> {
  const only = opts.saleNos?.length ? sql`AND m.legacy_id IN (${sql.join(opts.saleNos.map(s => sql`${s}`), sql`, `)})` : sql``;
  const sales = await rows(dbx, sql`SELECT m.legacy_id sale_no, p.id project_id, q.id quote_id, q.quote_number,
      (SELECT s.id FROM legacy_archive_rows s WHERE s.source_type = 'sales_list' AND s.is_effective AND s.source_raw->>'판매번호' = m.legacy_id ORDER BY s.id DESC LIMIT 1) sale_row_id
    FROM legacy_master_mappings m JOIN projects p ON p.id = m.entity_id
    JOIN LATERAL (SELECT * FROM quotes qq WHERE qq.project_id = p.id AND qq.deleted_at IS NULL ORDER BY qq.is_current DESC, qq.id DESC LIMIT 1) q ON true
    WHERE m.source_system = 'old_crm' AND m.entity_type = 'sale' AND m.status = 'active' ${only} ORDER BY m.legacy_id`);
  const out: ItemRestoreRow[] = [];
  for (const s of sales) {
    const base = { saleNo: String(s.sale_no), projectId: Number(s.project_id), quoteId: Number(s.quote_id), quoteNumber: s.quote_number ?? null };
    const items = await rows(dbx, sql`SELECT id, quantity, unit, unit_price, supply_amount, tax_amount, total_amount, memo, item_type FROM quote_items WHERE quote_id = ${s.quote_id} ORDER BY id`);
    const prog = s.sale_row_id ? (await rows(dbx, sql`SELECT p.source_raw FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective
      WHERE l.sale_row_id = ${s.sale_row_id} AND l.decision = 'confirmed' ORDER BY p.source_row NULLS LAST, p.id`)).map(r => r.source_raw ?? {}) : [];
    const srcMemo = [...new Set(prog.map(r => textOf(r["비고"])).filter(Boolean))].join(" / ") || null;
    if (items.length !== 1) { out.push({ ...base, itemId: null, status: "multi_item", reason: `견적 품목 ${items.length}개 — 전환 후 직원이 품목을 바꾼 견적`, before: null, after: null, source: null, progressRows: prog.length, sourceMemoNotCopied: srcMemo, unitCheck: null }); continue; }
    const it = items[0];
    const before = { quantity: Number(it.quantity), unit: String(it.unit), unitPrice: Number(it.unit_price), supplyAmount: Number(it.supply_amount),
      taxAmount: Number(it.tax_amount), totalAmount: Number(it.total_amount), memo: it.memo ?? null };
    const dec = decideItemDetail(prog, before.supplyAmount);
    const row: ItemRestoreRow = { ...base, itemId: Number(it.id), status: dec.status, reason: dec.status === "restorable" ? null : dec.reason, before, after: null,
      source: dec.detail ?? null, progressRows: dec.progressRows, sourceMemoNotCopied: srcMemo, unitCheck: null };
    if (dec.status === "restorable") {
      const d = dec.detail;
      // 단위는 바꾸지 않는다(원본에 거래 단위 없음). 원본 '단위'는 분량 기준으로 source.volumeBasis 에만 남긴다.
      const after = { quantity: d.quantity!, unit: before.unit, unitPrice: d.unitPrice!, memo: encodeDocMemo(before.memo, d) };
      row.unitCheck = d.kind === "통역"
        ? `원본 진행관리표에 통역 판매 수량의 단위 칸 값이 없음 — 실제 거래 단위(명·일 등)는 CRM 견적서로 확인 필요(현재 '${before.unit}' 유지, 임의 생성 안 함)`
        : `원본 '단위'(${d.volumeBasis ?? "없음"})는 분량 산정 기준 — 견적 수량의 실제 거래 단위는 CRM 견적서로 확인 필요(현재 '${before.unit}' 유지)`;
      // 이미 같은 값이면 복원 완료(재실행 안전) / 전환 기본값(1 × 공급가액, 건, 비고 없음)이 아니면 직원 수정 건 — 덮어쓰지 않음
      // 메모에 이미 같은 문서정보만 있으면(전환 시 원본대로 생성·이전 복원) 같은 값으로 본다 — 문서정보를 두 번 붙이지 않음
      const sameMemo = (before.memo ?? null) === after.memo || (before.memo ?? null) === encodeDocMemo(null, d);
      if (before.quantity === after.quantity && before.unitPrice === after.unitPrice && before.unit === after.unit && sameMemo) {
        row.status = "already_restored"; row.reason = "원본 상세정보와 이미 같음";
      } else if (!kindMatchesItemType(d.kind, it.item_type)) {
        row.status = "not_document"; row.reason = `원본 내용 '${d.kind}'과 플랫폼 품목 유형 '${it.item_type}'이 달라 복원하지 않음`;
      } else if (!(before.quantity === 1 && Math.abs(before.unitPrice - before.supplyAmount) <= 0.005 && !before.memo)) {
        row.status = "edited_after_activation"; row.reason = "전환 후 품목이 수정됨(수량·단위·단가·비고 중 기본값 아님) — 덮어쓰지 않음";
      } else row.after = after;
    }
    out.push(row);
  }
  return out;
}

/**
 * 복원 실행(관리자 승인 후, 한 트랜잭션). 지정 판매번호 중 'restorable' 만, 기존 품목 id 를 유지한 채 수량·단가·단위·비고(memo)만 바꾼다.
 * 공급가액·부가세·총액·견적 금액·판매·수행·지급·청구·수금·정산은 바꾸지 않는다(변경 전후 금액 동일 검증).
 * 근거·전후 값은 import_row_sources(module=legacy_quote_item_restore)에 남기고, rollbackItemRestore 로 되돌릴 수 있다.
 */
//   basisNotes: 판매번호 → 수량 산출 근거(승인된 확정 정보, 예: '통역사 35명 × 3일 = 105'). 품목 비고 앞에 붙이고 근거 기록에 출처를 남긴다.
export async function applyItemRestore(tx: Dbx, opts: { userId: number | null; saleNos: string[]; reason?: string; executedVia?: string; basisNotes?: Record<string, string> }) {
  if (!opts.saleNos.length) throw new Error("복원할 판매번호를 지정하세요.");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ITEM_RESTORE_MODULE}))`);
  const plan = (await planItemRestore(tx, { saleNos: opts.saleNos })).filter(r => r.status === "restorable" && r.after && r.itemId);
  for (const r of plan) {
    const note = opts.basisNotes?.[r.saleNo]?.trim();
    if (note) r.after = { ...r.after!, memo: [note, r.after!.memo].filter(Boolean).join(" / ") };
  }
  const [batch] = await rows(tx, sql`INSERT INTO import_batches (module, import_type, original_filename, total_rows, success_rows, status, created_by, source_system, is_current)
    VALUES (${ITEM_RESTORE_MODULE}, 'item_detail_restore', ${opts.reason ? `${opts.reason} (판매 ${opts.saleNos.length}건 지정)` : `판매 ${opts.saleNos.length}건 지정`}, ${plan.length}, 0, 'running', ${opts.userId}, 'old_crm', false) RETURNING id`);
  let n = 0;
  for (const r of plan) {
    const [u] = await rows(tx, sql`UPDATE quote_items SET quantity = ${String(r.after!.quantity)}, unit_price = ${String(r.after!.unitPrice)}, unit = ${r.after!.unit}, memo = ${r.after!.memo}
      WHERE id = ${r.itemId} AND quote_id = ${r.quoteId} RETURNING supply_amount, tax_amount, total_amount`);
    if (!u || Number(u.supply_amount) !== r.before!.supplyAmount || Number(u.tax_amount) !== r.before!.taxAmount || Number(u.total_amount) !== r.before!.totalAmount)
      throw new Error(`금액 불변 검증 실패(판매 ${r.saleNo}) — 전체 취소`);
    await tx.execute(sql`INSERT INTO import_row_sources (batch_id, module, entity_id, row_key, status, source_system, legacy_id, source_raw)
      VALUES (${Number(batch.id)}, ${ITEM_RESTORE_MODULE}, ${r.itemId}, ${`quote_item:${r.itemId}`}, 'restored', 'old_crm', ${r.saleNo},
        ${JSON.stringify({ quoteId: r.quoteId, quoteNumber: r.quoteNumber, projectId: r.projectId, before: r.before, after: r.after, source: r.source, progressRows: r.progressRows,
          basisNote: opts.basisNotes?.[r.saleNo] ? { text: opts.basisNotes[r.saleNo], origin: "user_confirmed" } : null, unitCheck: r.unitCheck,
          reason: opts.reason ?? null, executedVia: opts.executedVia ?? null, at: new Date().toISOString() })}::jsonb)`);
    await tx.execute(sql`INSERT INTO logs (entity_type, entity_id, action, performed_by, metadata) VALUES ('quote', ${r.quoteId}, 'legacy_quote_item_restored', ${opts.userId},
      ${JSON.stringify({ saleNo: r.saleNo, quoteNumber: r.quoteNumber, itemId: r.itemId, batchId: Number(batch.id), reason: opts.reason ?? null, executedVia: opts.executedVia ?? null,
        before: r.before, after: r.after, source: r.source })})`);
    n++;
  }
  await tx.execute(sql`UPDATE import_batches SET success_rows = ${n}, status = 'completed' WHERE id = ${batch.id}`);
  return { batchId: Number(batch.id), restored: n, skipped: opts.saleNos.length - n };
}

/** 되돌리기 — 이 배치가 바꾼 품목 중 지금도 복원 값 그대로인 것만 이전 값으로(그 뒤 직원이 수정한 품목은 건드리지 않음) */
export async function rollbackItemRestore(tx: Dbx, batchId: number) {
  const recs = await rows(tx, sql`SELECT entity_id, source_raw FROM import_row_sources WHERE batch_id = ${batchId} AND module = ${ITEM_RESTORE_MODULE} AND status = 'restored'`);
  let reverted = 0; const kept: number[] = [];
  for (const r of recs) {
    const b = r.source_raw.before, a = r.source_raw.after;
    const res = await tx.execute(sql`UPDATE quote_items SET quantity = ${String(b.quantity)}, unit_price = ${String(b.unitPrice)}, unit = ${b.unit}, memo = ${b.memo}
      WHERE id = ${r.entity_id} AND quantity = ${String(a.quantity)} AND unit_price = ${String(a.unitPrice)} AND unit = ${a.unit} AND memo IS NOT DISTINCT FROM ${a.memo}`);
    if (res.rowCount) reverted++; else kept.push(Number(r.entity_id));
  }
  await tx.execute(sql`UPDATE import_batches SET status = 'rolled_back' WHERE id = ${batchId} AND module = ${ITEM_RESTORE_MODULE}`);
  return { batchId, reverted, kept };
}
