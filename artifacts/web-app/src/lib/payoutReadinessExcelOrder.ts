// 지급준비점검 Excel 행 순서 — 같은 판매건의 수행정보를 연속된 행으로 묶는다(출력 순서만, 행 병합·삭제 없음).
//   · 판매건 키: 판매 ID(projectId) 우선. 판매 ID 가 없는 CRM 원본 행은 판매번호로, 같은 판매번호를 가진 판매 ID 가 있으면 그 판매건에 붙인다.
//     판매 ID·판매번호가 모두 없으면 단독 행. 거래처명으로는 묶지 않는다(같은 거래처의 다른 판매건 분리 유지).
//   · 판매건 순서: 기존 정렬(후보 구분 → 점검 상태 → 수취인)에서 그 판매건이 처음 나오는 위치.
//   · 판매건 안: 개인 통번역사 먼저, 외주업체 아래. 그 밖의 순서는 기존 정렬 그대로(안정 정렬).
export interface ExcelOrderRow {
  projectId: number | null; saleNo: string | null; quoteNumber?: string | null; sourceKey: string; payeeType?: 'individual' | 'vendor';
}

export function saleGroupKey<R extends ExcelOrderRow>(rows: R[]): (r: R) => string {
  const projectBySaleNo = new Map<string, number>();
  for (const r of rows) {
    const no = (r.saleNo ?? '').trim();
    if (r.projectId != null && no && !projectBySaleNo.has(no)) projectBySaleNo.set(no, r.projectId);
  }
  return (r: R) => {
    if (r.projectId != null) return `p:${r.projectId}`;
    const no = (r.saleNo ?? r.quoteNumber ?? '').trim();
    if (no) { const pid = projectBySaleNo.get(no); return pid != null ? `p:${pid}` : `s:${no}`; }
    return `u:${r.sourceKey}`;
  };
}

export function orderBySale<R extends ExcelOrderRow>(rows: R[]): R[] {
  const key = saleGroupKey(rows);
  const firstPos = new Map<string, number>();
  rows.forEach((r, i) => { const k = key(r); if (!firstPos.has(k)) firstPos.set(k, i); });
  return rows.map((r, i) => ({ r, i, g: firstPos.get(key(r))!, v: r.payeeType === 'vendor' ? 1 : 0 }))
    .sort((a, b) => (a.g - b.g) || (a.v - b.v) || (a.i - b.i))
    .map(x => x.r);
}

/** 같은 판매건이 떨어져 있는(연속되지 않은) 판매건 수·해당 행 수 — 검증용 */
export function countSplitSales<R extends ExcelOrderRow>(rows: R[]): { sales: number; rows: number } {
  const key = saleGroupKey(rows);
  const seenEnded = new Set<string>(); const split = new Set<string>(); let prev: string | null = null;
  for (const r of rows) {
    const k = key(r);
    if (k !== prev) { if (seenEnded.has(k)) split.add(k); if (prev) seenEnded.add(prev); prev = k; }
  }
  return { sales: split.size, rows: rows.filter(r => split.has(key(r))).length };
}
