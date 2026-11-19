// 해외 외주업체 송금내역 요약(2026-11) — 수행정보·지급회차가 같은 송금기록(performance_remittances)을 조회한다(중복 저장 없음).
import { and, inArray, isNull } from "drizzle-orm";
import { performanceRemittancesTable, summarizeRemittances, type RemittanceSummary } from "@workspace/db";

type Assign = { id: number; vendorSettlementType?: string | null; contractCurrency?: string | null; contractAmountForeign?: string | number | null };

/** 해외 외주(정산유형 overseas) 행만 요약을 만든다. 그 외 행은 결과에 없음. */
export async function loadRemittanceSummaries(dbx: any, rows: Assign[]): Promise<Map<number, RemittanceSummary>> {
  const targets = rows.filter((r) => r.vendorSettlementType === "overseas");
  const out = new Map<number, RemittanceSummary>();
  if (!targets.length) return out;
  const recs = await dbx.select().from(performanceRemittancesTable)
    .where(and(inArray(performanceRemittancesTable.assignmentId, targets.map((t) => t.id)), isNull(performanceRemittancesTable.deletedAt)));
  for (const t of targets) {
    out.set(t.id, summarizeRemittances(t.contractCurrency, t.contractAmountForeign, recs.filter((r: any) => r.assignmentId === t.id)));
  }
  return out;
}
