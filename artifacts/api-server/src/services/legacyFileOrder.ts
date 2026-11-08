// ─── 과거 CRM 최신 파일 행 순서(표시 전용) ─────────────────────────────────────────────
// 문제: 전체 교체는 바뀐 행만 새로 저장하고 바뀌지 않은 행은 이전 파일의 source_row 를 그대로 유지한다.
//   → 유효 행들의 source_row 가 서로 다른 파일 기준이라 source_row 정렬만으로는 최신 파일 순서를 재현할 수 없다.
// 해결(스키마 변경 없음): 판매목록·진행관리표 전체 교체 때마다 "최신 파일의 행 순서대로 유효 row id + 그 파일의 Excel 행 번호"를
//   순서표로 남긴다(import_batches module='legacy_file_order' + import_row_sources status='file_order').
//   · 데이터(legacy_archive_rows)·연결·금액은 건드리지 않는다. 순서표는 조회 정렬에만 쓰인다.
//   · 조회: 최신 순서표(되돌린 실행의 순서표 제외)의 위치로 정렬. 순서표에 없는 행(순서표 이전 자료·되돌리기로 복원된 행)은
//     뒤에 기존 기준(import_batch → source_row → id)으로 붙는다.
import { sql, type SQL } from "drizzle-orm";
import { importBatchesTable, importRowSourcesTable } from "@workspace/db";

export const FILE_ORDER_MODULE = "legacy_file_order";
const ORDER_STATUS = "file_order";

interface OrderPreview {
  sourceType: string; fileHash: string; allRows: { sourceSheet: string; sourceRow: number }[];
  plan: { decisions: { classification: string; matchedExistingId: unknown }[] };
}

// 전체 교체 실행(트랜잭션 안)에서 호출. 반영 후의 유효 행 기준으로 파일 행 → row id 를 확정한다.
export async function recordFileOrder(dbx: any, p: OrderPreview, o: { runId: string; userId: number | null; fileName: string }) {
  // 이번 파일에서 저장된 행(신규·수정 버전, 같은 파일 재업로드분) — file_hash + 시트 + 행으로 식별
  const stored = (await dbx.execute(sql`
    SELECT id, source_sheet, source_row FROM legacy_archive_rows
    WHERE source_type = ${p.sourceType} AND file_hash = ${p.fileHash} AND is_effective`)).rows as any[];
  const byKey = new Map(stored.map(r => [`${r.source_sheet}:${r.source_row}`, Number(r.id)]));
  // 변경 없음(SAME) 행 → 대응된 기존 유효 행
  const sameIds = p.plan.decisions.map(d => (d.classification === "SAME" && d.matchedExistingId != null ? Number(d.matchedExistingId) : null));
  const effective = new Set(((await dbx.execute(sql`
    SELECT id FROM legacy_archive_rows WHERE source_type = ${p.sourceType} AND is_effective`)).rows as any[]).map(r => Number(r.id)));
  const ids: number[] = [], rows: number[] = [];
  const used = new Set<number>();
  p.allRows.forEach((r, i) => {
    const id = byKey.get(`${r.sourceSheet}:${r.sourceRow}`) ?? sameIds[i];
    if (id == null || used.has(id) || !effective.has(id)) return;
    used.add(id); ids.push(id); rows.push(r.sourceRow);
  });
  const [b] = await dbx.insert(importBatchesTable).values({
    module: FILE_ORDER_MODULE, importType: "file_order", originalFilename: o.fileName || null, totalRows: p.allRows.length, successRows: ids.length,
    status: "completed", createdBy: o.userId, sourceSystem: "old_crm", fileHash: p.fileHash, sourceType: p.sourceType, isCurrent: false,
  }).returning({ id: importBatchesTable.id });
  await dbx.insert(importRowSourcesTable).values({
    batchId: b.id, module: FILE_ORDER_MODULE, rowKey: "order", status: ORDER_STATUS, sourceSystem: "old_crm", sourceFile: o.fileName || null,
    sourceRaw: { runId: o.runId, ids, rows, fileRows: p.allRows.length, effectiveRows: effective.size },
  });
  return { ordered: ids.length, effective: effective.size };
}

// 최신 유효 순서표(import_row_sources.id). 그 실행이 되돌려졌으면(sync 배치 rolled_back) 그 이전 순서표를 쓴다.
export async function latestFileOrderId(dbx: any, sourceType: string): Promise<number | null> {
  const r = (await dbx.execute(sql`
    SELECT s.id FROM import_row_sources s JOIN import_batches b ON b.id = s.batch_id
    WHERE b.module = ${FILE_ORDER_MODULE} AND b.source_type = ${sourceType} AND s.status = ${ORDER_STATUS}
      AND NOT EXISTS (SELECT 1 FROM import_row_sources m JOIN import_batches mb ON mb.id = m.batch_id
        WHERE m.status = 'sync_batch' AND m.source_raw->>'runId' = s.source_raw->>'runId' AND mb.status = 'rolled_back')
    ORDER BY s.id DESC LIMIT 1`)).rows[0] as any;
  return r ? Number(r.id) : null;
}

// 순서표 CTE(ord: rid, pos, file_row). 순서표가 없으면 빈 집합.
export function fileOrderCte(orderId: number | null): SQL {
  return orderId == null
    ? sql`ord AS (SELECT NULL::int AS rid, NULL::bigint AS pos, NULL::int AS file_row WHERE false)`
    // ids·rows 두 배열을 한 번에 펼친다(원소별 배열 인덱싱은 3만 행에서 O(n²) — 12초 → 50ms).
    : sql`ord AS (SELECT (x.rid)::int AS rid, x.pos, (x.frow)::int AS file_row
        FROM import_row_sources s CROSS JOIN LATERAL ROWS FROM (jsonb_array_elements_text(s.source_raw->'ids'), jsonb_array_elements_text(s.source_raw->'rows'))
          WITH ORDINALITY AS x(rid, frow, pos) WHERE s.id = ${orderId})`;
}
