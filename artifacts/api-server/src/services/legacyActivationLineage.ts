// 과거 CRM 판매 전환 계보(import_row_sources) 조회 — 수행정보 저장 경로에서 쓰는 가벼운 판정만 둔다(라우트 순환 import 방지).
import { sql } from "drizzle-orm";

export const ACTIVATION_MODULE = "legacy_sale_activation";
const SRC = "old_crm";
const ENTITY = "sale";

// 활성(취소 안 된) 운영 판매로 전환된 판매번호 — 판매목록·수행이력 중복 제외 공용 조건(SQL 조각).
//   saleNoExpr: 판매번호 SQL 표현식(예: legacy_archive_rows.source_raw->>'판매번호').
export function activatedSaleExists(saleNoExpr: any) {
  return sql`EXISTS (SELECT 1 FROM legacy_master_mappings lsm JOIN projects lsp ON lsp.id = lsm.entity_id AND lsp.status <> 'cancelled'
    WHERE lsm.source_system = ${SRC} AND lsm.entity_type = ${ENTITY} AND lsm.status = 'active' AND lsm.legacy_id = ${saleNoExpr})`;
}


// '과거 지급 확인 필요'(관리자 확인 전) 수행정보인지 — 이 건의 지급보류는 일반 수정으로 해제할 수 없다.
export async function isPendingPayoutReview(dbx: any, assignmentId: number): Promise<boolean> {
  const r = (await dbx.execute(sql`SELECT 1 FROM import_row_sources WHERE module = ${ACTIVATION_MODULE} AND row_key LIKE 'progress:%'
    AND entity_id = ${assignmentId} AND status = 'payout_review' LIMIT 1`)).rows as any[];
  return r.length > 0;
}
