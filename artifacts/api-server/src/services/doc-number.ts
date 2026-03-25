/**
 * 문서 번호 생성 유틸리티
 *
 * 현재: 날짜 + ID 기반 결정적(deterministic) 번호 생성
 * 향후: DB 시퀀스 테이블(document_sequences) 로 교체 가능하도록 함수 인터페이스 분리 유지
 *
 * Format:
 *  견적서    Q-YYYYMMDD-{quoteId:05d}      예) Q-20260325-00010
 *  거래명세서 S-YYYYMMDD-{projectId:05d}   예) S-20260325-00014
 */

function yyyymmdd(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** 견적서 문서번호 */
export function quoteDocNumber(quoteId: number, issuedAt?: Date): string {
  return `Q-${yyyymmdd(issuedAt)}-${String(quoteId).padStart(5, "0")}`;
}

/** 거래명세서 문서번호 */
export function statementDocNumber(projectId: number, issuedAt?: Date): string {
  return `S-${yyyymmdd(issuedAt)}-${String(projectId).padStart(5, "0")}`;
}

/**
 * 향후 DB 시퀀스 기반으로 전환 시 아래 인터페이스로 교체:
 *
 * export async function nextDocNumber(type: "Q" | "S"): Promise<string> {
 *   const seq = await db.transaction(async tx => {
 *     const [row] = await tx
 *       .insert(documentSequencesTable)
 *       .values({ type })
 *       .returning({ seq: documentSequencesTable.seq });
 *     return row.seq;
 *   });
 *   return `${type}-${yyyymmdd()}-${String(seq).padStart(5, "0")}`;
 * }
 */
