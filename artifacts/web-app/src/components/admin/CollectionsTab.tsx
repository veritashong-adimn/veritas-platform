// ─────────────────────────────────────────────────────────────────────────────
// 수금 현황 (통합 수금 조회) — 재무·정산 > 수금관리 > 수금 현황.
//  · READ-ONLY 조회 화면. 데이터 SSOT = project_payments + payment_transactions (GET /api/admin/collections).
//  · 입력/수정은 하지 않는다. 행 클릭 시 해당 판매상세(청구정보)로 이동한다.
//  · 조회 단위 = 청구행(project_payment) 1건. 분할청구면 판매 1건이 여러 행으로 표시된다.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { formatWon } from "@/lib/utils";
import { api } from '../../lib/constants';
import { Card, FilterPill } from '../ui';

type CollectionRow = {
  id: number;
  projectId: number;
  sequence: number;
  quoteNumber: string | null;
  projectTitle: string | null;
  billingCompanyId: number | null;
  billingCompanyName: string | null;
  paymentMethod: string | null;
  issueDate: string | null;
  expectedDate: string | null;
  lastPaidDate: string | null;
  amount: number;
  paidAmount: number;
  receivable: number;
  status: "scheduled" | "partial" | "completed";
  overdue: boolean;
  depositStatus: string | null;
  isLegacyFallback: boolean;
  bankAccount: string | null;
  foreign: { currency: string; foreignAmount: number }[];
  pmName: string | null;
  note: string | null;
};
type Summary = {
  count: number;
  totalBilled: number;
  totalPaid: number;
  totalReceivable: number;
  completedCount: number;
  partialCount: number;
  scheduledCount: number;
  receivableCount: number;
  overdueCount: number;
};

// 파생 필터(값을 DB에 저장하지 않고 조회 시 계산). 'receivable'/'overdue'는 status 와 별개 축.
type CollectionFilter = "all" | "scheduled" | "partial" | "completed" | "receivable" | "overdue";
const FILTERS: { key: CollectionFilter; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "scheduled", label: "입금예정" },
  { key: "partial", label: "부분입금" },
  { key: "completed", label: "입금완료" },
  { key: "receivable", label: "미수금 있음" },
  { key: "overdue", label: "기한경과" },
];

const STATUS_META: Record<CollectionRow["status"], { label: string; bg: string; color: string }> = {
  scheduled: { label: "입금예정", bg: "#f3f4f6", color: "#6b7280" },
  partial: { label: "부분입금", bg: "#fef3c7", color: "#b45309" },
  completed: { label: "입금완료", bg: "#dcfce7", color: "#15803d" },
};

const th: React.CSSProperties = {
  padding: "10px 12px", textAlign: "left", fontSize: 12,
  fontWeight: 600, color: "#6b7280", background: "#f9fafb",
  borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "9px 12px", fontSize: 13, color: "#374151",
  borderBottom: "1px solid #edf0f3", verticalAlign: "middle",
};
const tdNum: React.CSSProperties = { ...td, textAlign: "right", whiteSpace: "nowrap" };

function fmtDate(s: string | null): string {
  return s ? s.slice(0, 10) : "-";
}

interface Props {
  token: string;
  onToast?: (msg: string) => void;
  onOpenSalesDetail?: (projectId: number) => void;
}

export function CollectionsTab({ token, onToast, onOpenSalesDetail }: Props) {
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const [rows, setRows] = useState<CollectionRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<CollectionFilter>("all");
  const [search, setSearch] = useState("");

  const fetchCollections = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api("/api/admin/collections"), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) {
        setRows(Array.isArray(data?.rows) ? data.rows : []);
        setSummary(data?.summary ?? null);
      } else {
        onToast?.("오류: 수금 현황 조회 실패");
      }
    } catch {
      onToast?.("오류: 수금 현황 조회 실패");
    } finally {
      setLoading(false);
    }
  }, [authHeaders, onToast]);

  useEffect(() => { fetchCollections(); }, [fetchCollections]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      // 상태/파생 필터
      if (filter === "receivable") { if (r.receivable <= 0) return false; }
      else if (filter === "overdue") { if (!r.overdue) return false; }
      else if (filter !== "all") { if (r.status !== filter) return false; }
      // 검색: 판매번호/견적번호 · 프로젝트명 · 청구업체 · 담당PM
      if (q) {
        const hay = [r.quoteNumber, r.projectTitle, r.billingCompanyName, r.pmName]
          .filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, filter, search]);

  const rate = summary && summary.totalBilled > 0
    ? Math.round((summary.totalPaid / summary.totalBilled) * 1000) / 10
    : 0;

  return (
    <div style={{ marginBottom: 32 }} data-testid="collections-tab">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>수금 현황 ({filtered.length})</h2>
      </div>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#6b7280" }}>
        판매상세 &gt; 청구정보에서 입력된 청구/입금 데이터를 회사 전체 기준으로 조회합니다. (선입금·차감 견적 제외 · 조회 전용)
      </p>

      {/* ── 상단 요약 ── */}
      {summary && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 14 }}>
          <SummaryCard label="총 청구금액" value={formatWon(summary.totalBilled)} color="#111827" />
          <SummaryCard label="총 입금액" value={formatWon(summary.totalPaid)} color="#0891b2" />
          <SummaryCard label="총 미수금" value={formatWon(summary.totalReceivable)} color={summary.totalReceivable > 0 ? "#dc2626" : "#111827"} />
          <SummaryCard label="입금완료율" value={`${rate}%`} color="#15803d" sub={`완료 ${summary.completedCount} · 부분 ${summary.partialCount} · 예정 ${summary.scheduledCount}`} />
        </div>
      )}

      {/* ── 필터 + 검색 ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {FILTERS.map((f) => (
            <FilterPill key={f.key} label={f.label} active={filter === f.key} onClick={() => setFilter(f.key)} />
          ))}
        </div>
        <input
          data-testid="collections-search"
          aria-label="수금 현황 검색"
          placeholder="판매번호 · 프로젝트명 · 청구업체 · 담당PM"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: "7px 12px", fontSize: 13, border: "1px solid #e5e7eb", borderRadius: 8, minWidth: 260 }}
        />
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
      ) : filtered.length === 0 ? (
        <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>
          {rows.length === 0 ? "청구/수금 내역이 없습니다." : "조건에 맞는 내역이 없습니다."}
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["판매번호","프로젝트명","청구업체","결제방법","발행일","입금예정일","최근입금일","청구금액","누적입금액","미수금","입금상태","입금은행","외화","담당PM","비고"]
                    .map((h) => <th key={h} style={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const sm = STATUS_META[r.status];
                  return (
                    <tr
                      key={r.id}
                      data-testid={`collection-row-${r.id}`}
                      onClick={() => onOpenSalesDetail?.(r.projectId)}
                      style={{ cursor: onOpenSalesDetail ? "pointer" : "default" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <td style={{ ...td, fontWeight: 600, color: "#2563eb", whiteSpace: "nowrap" }}>
                        {r.quoteNumber ?? "-"}
                        {r.sequence > 1 || r.quoteNumber == null ? <span style={{ color: "#9ca3af", fontWeight: 400 }}> ·{r.sequence}회차</span> : null}
                      </td>
                      <td style={{ ...td, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.projectTitle ?? "(제목 없음)"}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{r.billingCompanyName ?? "-"}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{r.paymentMethod ?? "-"}</td>
                      <td style={{ ...td, whiteSpace: "nowrap", color: "#6b7280" }}>{fmtDate(r.issueDate)}</td>
                      <td style={{ ...td, whiteSpace: "nowrap", color: r.overdue ? "#dc2626" : "#6b7280", fontWeight: r.overdue ? 700 : 400 }}>
                        {fmtDate(r.expectedDate)}{r.overdue ? " ⚠" : ""}
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap", color: "#6b7280" }}>{fmtDate(r.lastPaidDate)}</td>
                      <td style={{ ...tdNum, fontWeight: 700, color: "#0891b2" }}>{formatWon(r.amount)}</td>
                      <td style={tdNum}>{formatWon(r.paidAmount)}</td>
                      <td style={{ ...tdNum, fontWeight: r.receivable > 0 ? 700 : 400, color: r.receivable > 0 ? "#dc2626" : "#9ca3af" }}>{formatWon(r.receivable)}</td>
                      <td style={td}>
                        <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 12, fontSize: 12, fontWeight: 600, background: sm.bg, color: sm.color, whiteSpace: "nowrap" }}>{sm.label}</span>
                        {r.overdue ? <span style={{ marginLeft: 4, display: "inline-block", padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: "#fee2e2", color: "#dc2626" }}>기한경과</span> : null}
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap", color: "#6b7280" }}>{r.bankAccount ?? "-"}</td>
                      <td style={{ ...td, whiteSpace: "nowrap", color: "#6b7280" }}>
                        {r.foreign.length
                          ? r.foreign.map((f) => `${f.currency} ${f.foreignAmount.toLocaleString()}`).join(", ")
                          : "-"}
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{r.pmName ?? "-"}</td>
                      <td style={{ ...td, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#9ca3af" }}>{r.note ?? "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function SummaryCard({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <Card style={{ padding: "12px 14px" }}>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
      {sub ? <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3 }}>{sub}</div> : null}
    </Card>
  );
}
