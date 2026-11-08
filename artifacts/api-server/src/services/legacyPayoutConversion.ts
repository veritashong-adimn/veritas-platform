// ─── 과거 CRM 미지급 수행건 → 운영 지급(은행이체) 전환 — 요청·승인·반려 ─────────────────────
// 대상(대표 결정 2026-11-08): 과거 CRM 진행관리표 수행행 중 '지급확인 필요(지급일 없음)' 건만.
//   · 지급일이 있는 과거 건은 지급일 경과 시 '별도 지급파일 처리분'으로 자동 지급완료되는 규칙이라 전환 대상이 아니다(이중 지급 방지).
//   · 납품일 ≤ 2026-09-15(대표 확인 지급완료)·지급액 0원·이미 요청/승인된 건은 제외.
// 승인 처리(관리자, 기존 기능 재사용 · 자동 지급확정/송금 없음):
//   ① 수행행이 연결된 과거 판매건을 기존 '운영 판매건 전환'(executeActivation)으로 전환(이미 전환됐으면 생략)
//   ② 그 수행행으로 만들어진 운영 수행정보(지급보류·과거 지급 확인 필요)를 기존 '과거 지급 확인 → 미지급'(resolvePayoutReview)으로 처리
//      → 이후 지급확정·은행이체는 기존 지급회차 절차(납품확인·세금처리 등 자격 조건 그대로)를 따른다.
//   같은 판매건의 다른 수행행은 전환 기능 규칙대로(지급완료/지급보류) 만들어지며 은행이체 대상이 되지 않는다.
// 원본 과거 CRM 행은 수정하지 않는다. 승인 당시 금액·상태는 legacy_payout_conversions 에 남긴다.
import { sql, eq, and } from "drizzle-orm";
import { legacyPayoutConversionsTable } from "@workspace/db";
import { buildActivationPlan, executeActivation, resolvePayoutReview, ACTIVATION_MODULE, ActivationError } from "./legacySaleActivation";
import { LEGACY_PAID_DELIVERY_CUTOFF } from "../lib/legacyPayoutRule";

export class ConversionError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const T = legacyPayoutConversionsTable;
const rows = async (dbx: any, q: any) => (await dbx.execute(q)).rows as any[];
const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? n : 0; };

// 수행행 전환 가능 여부(읽기 전용). 가능하면 스냅샷 값, 아니면 사유.
export async function checkEligibility(dbx: any, progressRowId: number) {
  const [r] = await rows(dbx, sql`
    SELECT r.id, r.is_effective, r.source_type, r.source_raw,
      (SELECT s.id FROM legacy_sales_progress_links l JOIN legacy_archive_rows s ON s.id = l.sale_row_id AND s.is_effective
        WHERE l.progress_row_id = r.id AND l.decision = 'confirmed' ORDER BY s.id DESC LIMIT 1) AS sale_row_id
    FROM legacy_archive_rows r WHERE r.id = ${progressRowId}`);
  if (!r || r.source_type !== "progress") return { ok: false as const, reason: "과거 CRM 수행건을 찾을 수 없습니다." };
  if (!r.is_effective) return { ok: false as const, reason: "최신 CRM 자료에서 제외되었거나 이전 버전인 수행건입니다." };
  const raw = r.source_raw ?? {};
  const payDate = String(raw["통번역사지급일"] ?? "").match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  const delivery = String(raw["통번역사납품일"] ?? "").match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  const pretax = num(raw["지급액(세전)"]), posttax = num(raw["지금액(세후)"]);
  if (payDate) return { ok: false as const, reason: "지급일이 있는 과거 건은 지급일 경과 시 별도 지급파일 처리분으로 지급완료됩니다(전환 대상 아님)." };
  if (delivery && delivery <= LEGACY_PAID_DELIVERY_CUTOFF) return { ok: false as const, reason: "지급완료로 확인된 과거 건입니다(전환 대상 아님)." };
  if (pretax <= 0) return { ok: false as const, reason: "지급액이 0원인 건은 전환할 수 없습니다." };
  if (!r.sale_row_id) return { ok: false as const, reason: "연결된 과거 판매건이 없어 운영 판매건으로 전환할 수 없습니다(판매목록 연결 확인 필요)." };
  const [sale] = await rows(dbx, sql`SELECT source_raw->>'판매번호' AS sale_no FROM legacy_archive_rows WHERE id = ${r.sale_row_id}`);
  const [act] = await rows(dbx, sql`SELECT s.status FROM import_row_sources s WHERE s.module = ${ACTIVATION_MODULE} AND s.row_key = ${"progress:" + progressRowId} ORDER BY s.id DESC LIMIT 1`);
  if (act && act.status !== "payout_review") return { ok: false as const, reason: "이미 운영 판매건으로 전환되어 처리된 수행건입니다." };
  return {
    ok: true as const,
    snapshot: { saleRowId: Number(r.sale_row_id), saleNo: sale?.sale_no ?? null, translatorName: String(raw["통번역사명"] ?? "").trim() || null,
      deliveryDate: delivery, amountPretax: pretax, amountPosttax: posttax, legacyStatus: "deposit_unconfirmed" },
  };
}

export async function requestConversion(db: any, o: { progressRowId: number; note: string | null; userId: number | null }) {
  const el = await checkEligibility(db, o.progressRowId);
  if (!el.ok) throw new ConversionError(409, "NOT_ELIGIBLE", el.reason);
  try {
    const [c] = await db.insert(T).values({
      progressRowId: o.progressRowId, ...el.snapshot, amountPretax: String(el.snapshot.amountPretax), amountPosttax: String(el.snapshot.amountPosttax),
      status: "requested", requestNote: o.note, requestedBy: o.userId,
    }).returning();
    return c;
  } catch (err: any) {
    if (String(err?.code ?? err?.cause?.code) === "23505") throw new ConversionError(409, "DUPLICATE", "이미 전환 승인 요청 중이거나 승인된 수행건입니다.");
    throw err;
  }
}

async function loadRequested(dbx: any, id: number) {
  const [c] = await dbx.select().from(T).where(eq(T.id, id));
  if (!c) throw new ConversionError(404, "NOT_FOUND", "전환 요청을 찾을 수 없습니다.");
  if (c.status !== "requested") throw new ConversionError(409, "ALREADY_DECIDED", `이미 ${c.status === "approved" ? "승인" : "반려"}된 요청입니다.`);
  return c;
}

export async function rejectConversion(db: any, o: { id: number; note: string; userId: number | null }) {
  await loadRequested(db, o.id);
  const [c] = await db.update(T).set({ status: "rejected", decisionNote: o.note, decidedBy: o.userId, decidedAt: new Date() })
    .where(and(eq(T.id, o.id), eq(T.status, "requested"))).returning();
  if (!c) throw new ConversionError(409, "ALREADY_DECIDED", "이미 처리된 요청입니다.");
  return c;
}

// 승인 — 전환 기능(①)과 미지급 확인(②)은 각각 기존 함수의 트랜잭션으로 실행한다.
//   ①만 성공하고 ②가 실패하면 운영 판매건은 만들어졌지만 수행정보는 지급보류(송금 대상 아님)로 남고, 요청은 '요청' 상태로 유지되어 재승인 가능.
export async function approveConversion(db: any, o: { id: number; note: string | null; userId: number | null }) {
  const c = await loadRequested(db, o.id);
  const el = await checkEligibility(db, c.progressRowId);
  if (!el.ok) throw new ConversionError(409, "NOT_ELIGIBLE", `승인할 수 없습니다 — ${el.reason}`);
  let projectId: number | null = null;
  const findPa = async () => (await rows(db, sql`
    SELECT s.entity_id AS pa_id, s.status, pa.project_id, pa.payment_status, pa.cost_total FROM import_row_sources s
    JOIN performance_assignments pa ON pa.id = s.entity_id AND pa.deleted_at IS NULL
    WHERE s.module = ${ACTIVATION_MODULE} AND s.row_key = ${"progress:" + c.progressRowId} ORDER BY s.id DESC LIMIT 1`))[0];
  let pa = await findPa();
  if (!pa) {
    try {
      const plan = await buildActivationPlan(db, el.snapshot.saleRowId);
      if (!plan.existing) { const r = await executeActivation(el.snapshot.saleRowId, plan.planToken, { id: o.userId }); projectId = r.projectId; }
    } catch (err) {
      if (err instanceof ActivationError) throw new ConversionError(err.status, "ACTIVATION_FAILED", `운영 판매건 전환 실패 — ${err.message}`);
      throw err;
    }
    pa = await findPa();
  }
  if (!pa) throw new ConversionError(409, "NO_ASSIGNMENT", "운영 판매건은 있지만 이 수행건의 운영 수행정보를 찾지 못했습니다(판매건 전환 이력 확인 필요).");
  if (pa.status !== "payout_review") throw new ConversionError(409, "NOT_REVIEW", "이 수행건의 운영 수행정보가 '과거 지급 확인 필요' 상태가 아닙니다.");
  try {
    await resolvePayoutReview(Number(pa.pa_id), "unpaid", `과거 CRM 지급 전환 승인 #${c.id}${o.note ? ` · ${o.note}` : ""}`, { id: o.userId });
  } catch (err) {
    if (err instanceof ActivationError) throw new ConversionError(err.status, "REVIEW_FAILED", `미지급 확인 처리 실패 — ${err.message}`);
    throw err;
  }
  const [done] = await db.update(T).set({
    status: "approved", decisionNote: o.note, decidedBy: o.userId, decidedAt: new Date(),
    projectId: projectId ?? Number(pa.project_id), assignmentId: Number(pa.pa_id),
    amountPretax: String(el.snapshot.amountPretax), amountPosttax: String(el.snapshot.amountPosttax),   // 승인 당시 금액
  }).where(and(eq(T.id, o.id), eq(T.status, "requested"))).returning();
  return done;
}

export async function listConversions(db: any, status: string | null) {
  return rows(db, sql`
    SELECT c.*, ru.name AS requested_by_name, du.name AS decided_by_name
    FROM legacy_payout_conversions c LEFT JOIN users ru ON ru.id = c.requested_by LEFT JOIN users du ON du.id = c.decided_by
    ${status ? sql`WHERE c.status = ${status}` : sql``}
    ORDER BY c.id DESC LIMIT 300`);
}

// 지급자료 조회 화면용 — 수행행별 최근 전환 기록(요청·승인·반려).
export async function conversionsByRow(db: any, rowIds: number[]): Promise<Map<number, { id: number; status: string; decisionNote: string | null }>> {
  const m = new Map<number, { id: number; status: string; decisionNote: string | null }>();
  if (!rowIds.length) return m;
  let rs: any[] = [];
  try {
    rs = await rows(db, sql`SELECT DISTINCT ON (progress_row_id) id, progress_row_id, status, decision_note FROM legacy_payout_conversions
      WHERE progress_row_id = ANY(${sql.raw(`ARRAY[${rowIds.map(Number).join(",")}]::int[]`)}) ORDER BY progress_row_id, id DESC`);
  } catch (err: any) {
    // 전환 이력 테이블 미적용 환경(배포 순서 어긋남)에서도 지급자료 조회는 유지 — 전환 상태만 비움.
    if (String(err?.code ?? err?.cause?.code) === "42P01") return m;
    throw err;
  }
  for (const r of rs) m.set(Number(r.progress_row_id), { id: Number(r.id), status: r.status, decisionNote: r.decision_note ?? null });
  return m;
}
