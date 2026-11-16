// ─── 선입금 목록형 원장 — 공용 타입·라벨·요청 헬퍼 ─────────────────────────────────────
import { api } from "../../lib/constants";

export type OverviewRow = {
  companyId: number; companyName: string; accountIds: number[]; accountCount: number; anyActive: boolean;
  totalDeposit: number; linkedDeposit: number; totalDeduction: number;
  confirmedBalance: number; pendingInflow: number; pendingDeduction: number; expectedBalance: number;
  openingBalance: number; lastTxDate: string | null; pendingQuoteCount: number; pendingConfirmableCount: number; rowCount: number;
  status: "closed" | "pending" | "balance" | "empty";
};
export type LinkedPayment = { paymentId: number; projectId: number | null; projectTitle: string | null; saleNo: string | null; sequence: number | null; amount: number | null; paidDate: string | null };
export type LedgerRow = {
  id: number; accountId: number; status: "confirmed" | "reserved"; type: string; amount: number; inflow: number; outflow: number;
  runningBalance: number; balanceKind: "confirmed" | "expected"; transactionDate: string; description: string | null; memo: string | null;
  supplyAmount: number | null; taxAmount: number | null; projectId: number | null; projectTitle: string | null; saleNo: string | null;
  quoteId: number | null; quoteNumber: string | null; quoteStatus: string | null; quoteTitle: string | null; quoteManaged: boolean;
  linkedPayment: LinkedPayment | null; createdAt: string; createdByName: string | null; confirmedAt: string | null;
  modifiedAt: string | null; modifiedByName: string | null; historyCount: number;
};
export type PendingQuote = {
  quoteId: number; quoteNumber: string | null; quoteStatus: string | null; quoteTitle: string | null;
  projectId: number | null; projectTitle: string | null;
  inflow: Array<{ id: number; type: string; amount: number; transactionDate: string | null }>;
  deduction: { id: number; amount: number; supplyAmount: number | null; taxAmount: number | null; transactionDate: string | null } | null;
  confirmable: boolean;
};
export type CompanyLedger = {
  companyId: number; companyName: string;
  accounts: Array<{ id: number; status: string; note: string | null; depositDate: string | null; initialAmount: number; currentBalance: number }>;
  openingBalance: number;
  totals: { totalDeposit: number; totalDeduction: number; confirmedBalance: number; pendingInflow: number; pendingDeduction: number; expectedBalance: number };
  ledger: LedgerRow[]; pending: PendingQuote[];
};

export const won = (n: number | null | undefined) => (n == null ? "-" : Math.round(n).toLocaleString("ko-KR"));
export const TYPE_LABEL: Record<string, string> = { deposit: "입금", carryover: "이월", adjustment: "조정", deduction: "차감", refund: "환불" };
export const typeLabelOf = (r: { type: string; linkedPayment?: unknown }) => (r.linkedPayment ? "기존 입금 연결" : TYPE_LABEL[r.type] ?? r.type);
export const isOutflowType = (t: string) => t === "deduction" || t === "refund";
export const STATUS_LABEL: Record<OverviewRow["status"], string> = { balance: "잔액 있음", pending: "확정 대기", empty: "소진", closed: "마감" };
export const STATUS_STYLE: Record<OverviewRow["status"], { bg: string; color: string }> = {
  balance: { bg: "#dcfce7", color: "#15803d" }, pending: { bg: "#fef3c7", color: "#92400e" },
  empty: { bg: "#f3f4f6", color: "#6b7280" }, closed: { bg: "#e5e7eb", color: "#374151" },
};

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
  const reservedSuffix = prevLabel.includes("(예약)") || !prevLabel ? "(예약)" : "";
  const label = `${type === "carryover" ? "이월" : "선입"}${reservedSuffix}`;
  const src = type === "carryover" ? `원천: ${sourceRef.trim() || "-"}` : sourceRef.trim() ? `원천: ${sourceRef.trim()}` : "";
  return [label, src, note.trim()].filter(Boolean).join(" · ");
}
