// ─────────────────────────────────────────────────────────────────────────────
// 운영 판매건 → 과거 CRM 판매건 원복(건별, 관리자) — 전환(legacySaleActivation)의 역방향
//
// 원칙(데이터 삭제 없음 · 상태 복구만)
//   · 과거 CRM 원본(legacy_archive_rows)은 원래 변경되지 않았으므로 그대로 둔다.
//   · 원본↔운영 매핑(legacy_master_mappings)을 active → rolled_back 으로 전이(스키마 주석의 롤백 규칙).
//     → 판매관리 '과거 CRM'에 원본 판매건이 다시 표시되고(activatedSaleExists 가 active 매핑만 제외), 재전환도 가능.
//   · 전환으로 만든 운영 판매(project)는 삭제하지 않고 '취소(cancelled)'로 보관 → '현재' 목록·집계에서 제외.
//     전환 견적은 판매취소와 같이 승인 → 대기로 돌리고 휴지통(soft delete)에 보관 → 견적관리·매출 집계에서 제외.
//     전환 후 수정한 내용(견적·상품·수신자·수행정보 등)은 이 보관 레코드에 그대로 남는다(유실 없음).
//   · 운영 업무가 붙은 판매(추가 견적·입금·정산·지급회차·지급대상 수행·청구·작업·파일 등)는 원복하지 않는다.
//     판정은 실제 DB 관계(project_id·quote_id·assignment 연결) 기준. 검사·실행은 같은 함수로 트랜잭션 안에서 재검증.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { ACTIVATION_MODULE } from "./legacyActivationLineage";
import { ActivationError } from "./legacySaleActivation";

type Dbx = typeof db | any;
const rows = async (dbx: Dbx, q: any) => ((await dbx.execute(q)).rows as any[]);
const n = async (dbx: Dbx, q: any) => Number((await rows(dbx, q))[0]?.n ?? 0);

export const REVERT_BLOCKED_MESSAGE = "이 판매건은 운영 업무 데이터가 연결되어 있어 바로 원복할 수 없습니다. 연결된 업무 내역을 확인해 주세요.";
// 전환 직후 상태(approved) 또는 판매취소된 상태에서만 원복 — 배정·진행·완료·입금 단계는 운영 업무로 본다
const REVERTIBLE_PROJECT_STATUS = new Set(["approved", "cancelled"]);
const STATUS_KR: Record<string, string> = { created: "접수", quoted: "견적", approved: "견적승인", paid: "입금", matched: "통번역사 배정", in_progress: "진행중", completed: "완료", cancelled: "취소" };

export interface RevertCheck {
  canRevert: boolean;
  reasons: string[];
  saleNo: string;
  mappingId: number;
  projectStatus: string;
  quoteId: number | null;
  activationAssignmentIds: number[];
  // 전환 후 수정 여부(원본 기준 금액·상품명과 현재 운영 견적 비교) — 수정본은 보관 레코드에 남는다
  modified: { changed: boolean; fields: string[] };
}

export async function checkLegacySaleRevert(dbx: Dbx, projectId: number, opts: { lock?: boolean } = {}): Promise<RevertCheck> {
  const [m] = await rows(dbx, sql`SELECT id, legacy_id, import_batch_id, status FROM legacy_master_mappings
    WHERE source_system = 'old_crm' AND entity_type = 'sale' AND entity_id = ${projectId} AND status = 'active'
    ORDER BY id DESC LIMIT 1 ${opts.lock ? sql`FOR UPDATE` : sql``}`);
  if (!m) {
    // 이 판매건이 원복으로 보관된 운영 판매인지 — 매핑이 rolled_back 이거나(원복 직후) 재전환으로 다른 판매를 가리키게 된 경우(원복 로그)
    const [rb] = await rows(dbx, sql`SELECT 1 FROM legacy_master_mappings WHERE source_system = 'old_crm' AND entity_type = 'sale' AND entity_id = ${projectId} AND status = 'rolled_back'
      UNION ALL SELECT 1 FROM logs WHERE entity_type = 'project' AND entity_id = ${projectId} AND action = 'legacy_sale_reverted' LIMIT 1`);
    throw new ActivationError(rb ? 409 : 404, rb ? "이미 과거 CRM 으로 원복된 판매건입니다." : "과거 CRM 에서 전환된 운영 판매건이 아닙니다.", rb ? "ALREADY_REVERTED" : "NOT_ACTIVATED");
  }
  const [p] = await rows(dbx, sql`SELECT id, status FROM projects WHERE id = ${projectId} ${opts.lock ? sql`FOR UPDATE` : sql``}`);
  if (!p) throw new ActivationError(404, "판매건을 찾을 수 없습니다.");

  const lin = await rows(dbx, sql`SELECT row_key, entity_id, status, source_raw FROM import_row_sources WHERE module = ${ACTIVATION_MODULE} AND batch_id = ${m.import_batch_id}`);
  const saleLin = lin.find(l => String(l.row_key).startsWith("sale:"));
  const quoteId: number | null = saleLin?.source_raw?.quoteId != null ? Number(saleLin.source_raw.quoteId) : null;
  const actAssign = lin.filter(l => String(l.row_key).startsWith("progress:")).map(l => Number(l.entity_id));
  const idList = (ids: number[]) => sql.join((ids.length ? ids : [0]).map(i => sql`${i}`), sql`, `);

  const reasons: string[] = [];
  const add = (cnt: number, label: string) => { if (cnt > 0) reasons.push(`${label} ${cnt}건`); };
  if (!REVERTIBLE_PROJECT_STATUS.has(String(p.status))) reasons.push(`판매 진행 단계가 '${STATUS_KR[p.status] ?? p.status}'입니다`);

  // 견적 — 전환 견적 외 다른 견적(추가·변경견적 등)이 있으면 운영 업무로 본다
  add(await n(dbx, sql`SELECT count(*) n FROM quotes WHERE project_id = ${projectId} AND deleted_at IS NULL AND id <> ${quoteId ?? 0}`), "추가 견적서");
  if (quoteId) add(await n(dbx, sql`SELECT count(*) n FROM inquiries WHERE quote_id = ${quoteId}`), "연결된 의뢰건");
  // 입금·수금 — 전환 시 만든 과거 수금기록 포함(수금 현황 집계에 남으므로 자동 원복하지 않음)
  const actPayIds = lin.filter(l => String(l.row_key).startsWith("collection:") && l.status === "legacy_collected").map(l => Number(l.entity_id));
  add(await n(dbx, sql`SELECT count(*) n FROM project_payments WHERE project_id = ${projectId} AND id IN (${idList(actPayIds)})`), "과거 CRM 수금완료 기록(전환 시 생성, 수금 현황 반영)");
  add(await n(dbx, sql`SELECT count(*) n FROM project_payments WHERE project_id = ${projectId} AND id NOT IN (${idList(actPayIds)})`), "입금(수금) 처리 내역");
  add(await n(dbx, sql`SELECT count(*) n FROM payment_transactions WHERE project_id = ${projectId}`), "입금 거래 내역");
  add(await n(dbx, sql`SELECT count(*) n FROM payments WHERE project_id = ${projectId}`), "결제 내역");
  add(await n(dbx, sql`SELECT count(*) n FROM prepaid_ledger WHERE project_id = ${projectId} OR quote_id = ${quoteId ?? 0}`), "선입금 차감 내역");
  add(await n(dbx, sql`SELECT count(*) n FROM billing_batch_items WHERE project_id = ${projectId} OR quote_id = ${quoteId ?? 0}`)
    + await n(dbx, sql`SELECT count(*) n FROM billing_batches WHERE quote_id = ${quoteId ?? 0}`), "청구(세금계산서) 내역");
  // 정산·지급
  add(await n(dbx, sql`SELECT count(*) n FROM settlements WHERE project_id = ${projectId}`), "통번역사 정산 내역");
  add(await n(dbx, sql`SELECT count(*) n FROM payout_round_items WHERE project_id = ${projectId} OR performance_assignment_id IN (${idList(actAssign)})`), "지급회차 편입 내역");
  add(await n(dbx, sql`SELECT count(*) n FROM performance_assignments WHERE project_id = ${projectId} AND deleted_at IS NULL AND id NOT IN (${idList(actAssign)})`), "전환 후 추가된 수행정보");
  add(await n(dbx, sql`SELECT count(*) n FROM performance_assignments WHERE id IN (${idList(actAssign)}) AND deleted_at IS NULL AND payout_round_id IS NOT NULL`), "지급회차 배정 수행정보");
  // 미지급 + 지급액 > 0 = 지급회차 자동수집 대상 — 취소 판매에 남기면 지급될 수 있으므로 원복 전 정리 필요
  add(await n(dbx, sql`SELECT count(*) n FROM performance_assignments WHERE id IN (${idList(actAssign)}) AND deleted_at IS NULL AND payment_status = 'unpaid' AND cost_total > 0`), "지급 대상(미지급) 수행정보");
  // 기타 운영 업무
  add(await n(dbx, sql`SELECT count(*) n FROM tasks WHERE project_id = ${projectId}`), "작업(배정) 내역");
  add(await n(dbx, sql`SELECT count(*) n FROM project_files WHERE project_id = ${projectId}`), "프로젝트 파일");
  add(await n(dbx, sql`SELECT count(*) n FROM communications WHERE project_id = ${projectId}`), "커뮤니케이션 기록");
  add(await n(dbx, sql`SELECT count(*) n FROM invitations WHERE project_id = ${projectId}`), "통번역사 초대");
  add(await n(dbx, sql`SELECT count(*) n FROM translation_units WHERE project_id = ${projectId}`), "번역 데이터");

  // 전환 후 수정 여부(차단 사유 아님) — 원본 총액·상품명 대비
  const fields: string[] = [];
  if (quoteId) {
    const [q] = await rows(dbx, sql`SELECT price FROM quotes WHERE id = ${quoteId}`);
    const items = await rows(dbx, sql`SELECT product_name, total_amount FROM quote_items WHERE quote_id = ${quoteId}`);
    const origTotal = Number(saleLin?.source_raw?.originalTotal ?? NaN);
    if (q && Number.isFinite(origTotal) && Number(q.price) !== origTotal) fields.push("견적 금액");
    if (items.length !== 1 || (saleLin?.source_raw?.originalProductName && items[0]?.product_name !== saleLin.source_raw.originalProductName)) fields.push("견적 상품");
  }

  return {
    canRevert: reasons.length === 0, reasons, saleNo: String(m.legacy_id), mappingId: Number(m.id),
    projectStatus: String(p.status), quoteId, activationAssignmentIds: actAssign, modified: { changed: fields.length > 0, fields },
  };
}

/** 원복 실행 — 한 트랜잭션(오류 시 전체 롤백). 매핑 행 잠금으로 같은 판매건의 동시·중복 원복을 막는다. */
export async function executeLegacySaleRevert(projectId: number, performer: { id: number | null }) {
  return db.transaction(async (tx: any) => {
    const chk = await checkLegacySaleRevert(tx, projectId, { lock: true });
    if (!chk.canRevert) throw new ActivationError(409, REVERT_BLOCKED_MESSAGE, "REVERT_BLOCKED", { reasons: chk.reasons });

    const [q] = chk.quoteId ? await rows(tx, sql`SELECT status, deleted_at FROM quotes WHERE id = ${chk.quoteId} FOR UPDATE`) : [];
    const [cur] = await rows(tx, sql`SELECT id FROM legacy_archive_rows WHERE source_type = 'sales_list' AND is_effective AND source_raw->>'판매번호' = ${chk.saleNo} ORDER BY id DESC LIMIT 1`);

    const upd = await rows(tx, sql`UPDATE legacy_master_mappings SET status = 'rolled_back' WHERE id = ${chk.mappingId} AND status = 'active' RETURNING id`);
    if (!upd.length) throw new ActivationError(409, "이미 과거 CRM 으로 원복된 판매건입니다.", "ALREADY_REVERTED");
    await tx.execute(sql`UPDATE projects SET status = 'cancelled' WHERE id = ${projectId}`);
    if (chk.quoteId && q) {
      await tx.execute(sql`UPDATE quotes SET
          status = CASE WHEN status = 'approved' THEN 'pending' ELSE status END,
          deleted_at = COALESCE(deleted_at, now()), deleted_by = COALESCE(deleted_by, ${performer.id}),
          deletion_reason = COALESCE(deletion_reason, ${`과거 CRM 원복(판매번호 ${chk.saleNo}) — 운영 판매건 보관`})
        WHERE id = ${chk.quoteId}`);
    }
    return {
      saleNo: chk.saleNo, legacyRowId: cur ? Number(cur.id) : null, quoteId: chk.quoteId, modified: chk.modified,
      before: { mapping: "active", projectStatus: chk.projectStatus, quoteStatus: q?.status ?? null, quoteDeleted: !!q?.deleted_at },
      after: { mapping: "rolled_back", projectStatus: "cancelled", quoteStatus: q?.status === "approved" ? "pending" : (q?.status ?? null), quoteDeleted: !!chk.quoteId },
      preserved: { activationAssignments: chk.activationAssignmentIds.length },
    };
  });
}
