// ─── 선입금 목록형 원장 — 공용 타입·라벨·요청 헬퍼 ─────────────────────────────────────
import { api } from "../../lib/constants";

export type OverviewRow = { companyId: number; companyName: string; totalDeposit: number; totalDeduction: number; balance: number; lastTxDate: string | null };
export type LedgerRow = {
  id: number; accountId: number; type: string; label: string; transactionDate: string | null;
  inflow: number; outflow: number; balance: number;
  description: string | null; memo: string | null; quoteId: number | null; projectId: number | null; linkedPaymentId: number | null;
};
export type CompanyLedger = {
  companyId: number; companyName: string; accounts: Array<{ id: number; status: string }>;
  openingBalance: number; ledger: LedgerRow[];
  totals: { totalDeposit: number; totalDeduction: number; balance: number };
};

export const won = (n: number | null | undefined) => (n == null ? "-" : Math.round(n).toLocaleString("ko-KR"));
export const TYPE_LABEL: Record<string, string> = { deposit: "선입금", carryover: "이월", adjustment: "조정", deduction: "차감", refund: "환불" };
export const isOutflowType = (t: string) => t === "deduction" || t === "refund";

/** 조회는 항상 서버 최신값(브라우저 캐시 미사용) */
export async function getJson<T>(path: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(api(path), { headers, cache: "no-store" });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((d as any)?.error ?? `조회 실패 (${res.status})`);
  return d as T;
}

// 차감 견적 선입/이월 행의 거래 내용 — 서버(syncQuoteReservations)와 같은 "라벨 · 원천: X · 비고" 형식.
//  견적 편집 화면이 이 형식을 분해해 선입/이월 입력란을 복원하므로 형식을 지켜 저장한다.
export function parseQuoteLineDesc(desc: string | null): { label: string; sourceRef: string; note: string } {
  const parts = String(desc ?? "").split(" · ");
  const rest = parts.slice(1);
  const src = rest.filter(p => p.startsWith("원천:")).map(p => p.slice(3).trim()).filter(v => v && v !== "-");
  return { label: parts[0] ?? "", sourceRef: src[0] ?? "", note: rest.filter(p => !p.startsWith("원천:")).join(" · ") };
}
export function composeQuoteLineDesc(type: string, prevLabel: string, sourceRef: string, note: string): string {
  void prevLabel;   // 견적 저장과 같은 라벨(선입금/이월) — 예정·확정 표기는 쓰지 않음
  const label = type === "carryover" ? "이월" : "선입금";
  const src = type === "carryover" ? `원천: ${sourceRef.trim() || "-"}` : sourceRef.trim() ? `원천: ${sourceRef.trim()}` : "";
  return [label, src, note.trim()].filter(Boolean).join(" · ");
}
