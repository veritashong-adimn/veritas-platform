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
