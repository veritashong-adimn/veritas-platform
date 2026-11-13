// ─── 과거 CRM 전환 수행정보 — 지급상태 표시 판정 · 끊어진 판매상품 연결 추천 (SSOT) ─────────────────
//
// [지급상태 — 2026-11-13 대표 결정: '확인 필요'로 통일]
//   과거 CRM 판매를 운영 판매로 전환해 만든 수행정보(import_row_sources: module=legacy_sale_activation, row_key=progress:*)는
//   다음 기준으로만 지급상태를 표시한다(판매관리·지급회차 통합조회·지급명세서 공통).
//     · 지급완료 = 실제 지급확정 기록이 있는 건만: payment_status='paid'
//         (전환 시 대표 확인 cutoff[납품일 ≤ 2026-09-15]로 지급완료된 건, 또는 담당자가 [지급완료 확인]으로
//          실제 지급일·지급금액·근거를 기록한 건). 기존 지급완료 기록은 그대로 유지한다.
//     · 지급예정 = 확인 전이며 지급예정일이 오늘(KST) 당일 또는 이후
//     · 확인 필요 = 확인 전이며 지급예정일이 지났거나 없음 — 지급예정일 경과만으로 지급완료로 보지 않는다.
//   ※ 전환되지 않은 과거 CRM 원본 조회 판매(legacy_archive_rows 만 있는 건)는 기존 규칙(2026-11-08) 유지.
//   ※ 표시 판정일 뿐 DB 의 payment_status 를 바꾸지 않는다. 지급보류(payment_hold)는 지급회차·대량이체 제외 상태로 유지.
//
// [판매상품 연결 추천]
//   수행정보(sale_item_id)가 현재 판매정보에 없는 품목을 가리킬 때(견적 저장으로 품목이 재삽입되며 id 가 바뀐 경우),
//   견적 저장 감사로그(quote_items_updated)의 저장 전 품목 id·상품명 → 저장 후 상품명을 따라가
//   "같은 상품명이 저장 전·후 각각 1개뿐"인 경우에만 현재 품목을 추천한다(근거가 없거나 모호하면 추천하지 않음).
// ─────────────────────────────────────────────────────────────────────────────
import { db, calcPayoutWithholding } from "@workspace/db";
import { sql } from "drizzle-orm";
import { todayKst, isLegacyConfirmedPaid } from "../lib/legacyPayoutRule";

type Dbx = typeof db | any;
const rows = async (dbx: Dbx, q: any) => (await dbx.execute(q)).rows as any[];
const ACTIVATION_MODULE = "legacy_sale_activation";

export type LegacyPayoutDisplay = "paid" | "scheduled" | "review";
export const LEGACY_PAYOUT_DISPLAY_LABEL: Record<LegacyPayoutDisplay, string> = { paid: "지급완료", scheduled: "지급예정", review: "확인 필요" };

/** 과거 CRM 전환 수행정보의 표시 지급상태 — 확인 대기(payout_review) 건만 판정, 그 외(null)는 기존 표시 유지 */
export function legacyPayoutDisplay(lineageStatus: string | null | undefined, paymentStatus: string | null | undefined,
  expectedPaymentDate: string | null | undefined, today: string = todayKst(), deliveryDate?: string | null): LegacyPayoutDisplay | null {
  if (paymentStatus === "paid") return "paid";
  if (lineageStatus !== "payout_review" || paymentStatus !== "payment_hold") return null;
  if (isLegacyConfirmedPaid(deliveryDate)) return "paid";   // 대표 확인 cutoff(납품일 ≤ 2026-09-15) — 기존 지급완료 근거 유지
  const d = String(expectedPaymentDate ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today ? "scheduled" : "review";
}

/** 판매 상세 수행정보 표시용 부가정보(추가 필드) — 과거 CRM 지급확인 상태 · 판매수량 복사 수량 여부 */
export async function loadPerformanceAnnotations(dbx: Dbx, projectId: number) {
  const r = await rows(dbx, sql`
    SELECT pa.id, pa.payment_status, to_char(pa.expected_payment_date, 'YYYY-MM-DD') AS expected,
      to_char(coalesce(pa.delivery_date, pa.delivery_date_auto), 'YYYY-MM-DD') AS delivery,
      to_char(pa.actual_payment_date, 'YYYY-MM-DD') AS actual, pa.actual_payment_amount,
      s.status AS lineage_status,
      -- 과거 CRM 진행행에 '수행 수량'이 없어 판매수량이 복사된 직접금액 행(지급액 계산에는 쓰이지 않는 값)
      (s.id IS NOT NULL AND pa.is_direct_amount AND pa.quantity IS NOT NULL AND pa.quantity > 1
        AND EXISTS (SELECT 1 FROM quote_items qi WHERE qi.quote_id = pa.quote_id AND qi.quantity = pa.quantity)) AS qty_from_sale
    FROM performance_assignments pa
    LEFT JOIN import_row_sources s ON s.module = ${ACTIVATION_MODULE} AND s.entity_id = pa.id AND s.row_key LIKE 'progress:%'
    WHERE pa.project_id = ${projectId} AND pa.deleted_at IS NULL`);
  const today = todayKst();
  const map = new Map<number, { legacyPayout: { lineageStatus: string; display: LegacyPayoutDisplay | null; label: string | null } | null; quantityFromSale: boolean }>();
  for (const x of r) {
    const display = x.lineage_status ? legacyPayoutDisplay(x.lineage_status, x.payment_status, x.expected, today, x.delivery) : null;
    map.set(Number(x.id), {
      legacyPayout: x.lineage_status ? { lineageStatus: x.lineage_status, display, label: display ? LEGACY_PAYOUT_DISPLAY_LABEL[display] : null } : null,
      quantityFromSale: x.qty_from_sale === true,
    });
  }
  return map;
}

/** 확인 시 기본 지급금액 제안 — CRM 원본 세후 지급액 → 저장된 세후 → (원가 − 원천세). 제안값일 뿐 담당자가 확인·수정한다. */
//   저장된 세금처리(withholding_treatment)는 바꾸지 않고 그 기준으로 세후 예상액만 계산한다(제안값 — 저장 안 함).
export function suggestedPaidAmount(a: { originalPostTax?: number | null; netPayment?: unknown; costTotal?: unknown; withholdingTax?: unknown; withholdingTreatment?: string | null }): number | null {
  const n = (v: unknown) => (v == null || v === "" ? null : Number(v));
  if (a.originalPostTax != null && a.originalPostTax > 0) return Math.round(a.originalPostTax);
  const net = n(a.netPayment); if (net != null && net > 0) return Math.round(net);
  const cost = n(a.costTotal), wt = n(a.withholdingTax) ?? 0;
  if (cost == null || cost <= 0) return null;
  if (wt > 0) return Math.round(cost - wt);
  if (a.withholdingTreatment) { try { return Math.round(calcPayoutWithholding(cost, "individual", a.withholdingTreatment as any, null).net); } catch { /* 계산 불가 — 제안 없음 */ } }
  return null;
}

// ─── 끊어진 판매상품 연결 추천 ──────────────────────────────────────────────────
export type StaleLinkSuggestion = { performanceId: number; staleItemId: number; quoteId: number | null; suggestedItemId: number | null; basis: string | null };

export async function suggestStaleSaleLinks(dbx: Dbx, projectId: number): Promise<StaleLinkSuggestion[]> {
  const stale = await rows(dbx, sql`SELECT pa.id, pa.sale_item_id, pa.quote_id FROM performance_assignments pa
    WHERE pa.project_id = ${projectId} AND pa.deleted_at IS NULL AND pa.sale_item_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM quote_items qi WHERE qi.id = pa.sale_item_id) ORDER BY pa.id`);
  if (!stale.length) return [];
  const quoteIds = [...new Set(stale.map(s => Number(s.quote_id)).filter(Boolean))];
  const out: StaleLinkSuggestion[] = [];
  const cache = new Map<string, { id: number | null; basis: string | null }>();
  for (const s of stale) {
    const qid = s.quote_id != null ? Number(s.quote_id) : null;
    const key = `${qid}:${s.sale_item_id}`;
    if (!cache.has(key)) cache.set(key, qid && quoteIds.includes(qid) ? await traceItem(dbx, qid, Number(s.sale_item_id)) : { id: null, basis: null });
    const t = cache.get(key)!;
    out.push({ performanceId: Number(s.id), staleItemId: Number(s.sale_item_id), quoteId: qid, suggestedItemId: t.id, basis: t.basis });
  }
  return out;
}

/** 견적 저장 감사로그를 시간순으로 따라 기존 품목 id → 현재 품목 id 추적(상품명 1:1 일치일 때만) */
async function traceItem(dbx: Dbx, quoteId: number, staleId: number): Promise<{ id: number | null; basis: string | null }> {
  const logs = await rows(dbx, sql`SELECT metadata, created_at FROM logs WHERE entity_type = 'quote' AND entity_id = ${quoteId} AND action = 'quote_items_updated' ORDER BY id`);
  type It = { id?: number; productName?: string };
  const parse = (m: string | null) => { try { return JSON.parse(m ?? "{}"); } catch { return {}; } };
  const name1 = (arr: It[], name: string) => arr.filter(i => (i.productName ?? "") === name);
  let curId: number | null = staleId, curName: string | null = null, hops = 0, firstAt: string | null = null;
  for (const l of logs) {
    const m = parse(l.metadata);
    const before: It[] = m?.before?.items ?? [], after: It[] = m?.after?.items ?? [];
    if (curId == null) break;
    const b = before.find(i => i.id === curId);
    if (!b) continue;                                   // 이 저장에 해당 품목이 없었음 — 다음 기록
    const name = b.productName ?? "";
    if (name1(before, name).length !== 1 || name1(after, name).length !== 1) return { id: null, basis: null };   // 모호
    const a = name1(after, name)[0];
    curName = name; hops++; firstAt ??= String(l.created_at);
    curId = a.id ?? null;                                // 저장 후 id 기록이 있으면 그대로, 없으면 다음 저장 전 목록/현재 품목에서 찾음
    if (curId == null) {
      // 다음 저장 기록의 저장 전 목록 또는 현재 품목에서 같은 상품명 1건을 찾는다(저장 직후 상태)
      const next = logs[logs.indexOf(l) + 1];
      const pool: It[] = next ? (parse(next.metadata)?.before?.items ?? [])
        : (await rows(dbx, sql`SELECT id, product_name AS "productName" FROM quote_items WHERE quote_id = ${quoteId} ORDER BY id`)).map((r: any) => ({ id: Number(r.id), productName: r.productName }));
      const hit = name1(pool, name);
      if (hit.length !== 1 || hit[0].id == null) return { id: null, basis: null };
      curId = Number(hit[0].id);
    }
  }
  if (!hops || curId == null || curId === staleId) return { id: null, basis: null };
  const [exists] = await rows(dbx, sql`SELECT id, product_name FROM quote_items WHERE id = ${curId} AND quote_id = ${quoteId}`);
  if (!exists) return { id: null, basis: null };
  const at = firstAt ? new Date(firstAt).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16) : "";
  return { id: curId, basis: `견적 저장(${at}${hops > 1 ? ` 외 ${hops - 1}회` : ""})으로 품목이 재생성됨: #${staleId} → #${curId} · 상품명 '${curName}' 동일(저장 전·후 1건)` };
}
