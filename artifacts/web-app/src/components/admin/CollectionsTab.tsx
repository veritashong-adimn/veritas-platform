// ─────────────────────────────────────────────────────────────────────────────
// 수금 현황 (통합 수금 조회) — 재무·정산 > 수금관리 > 수금 현황.
//  · READ-ONLY 조회 화면. 데이터 SSOT = project_payments + payment_transactions (GET /api/admin/collections?include=legacy).
//  · 과거 CRM 판매목록(판매번호 1건=1행)도 함께 조회한다. 입금 판정이 불명확한 과거 건은 '확인 필요'로 표시하고
//    상단 4개 집계(청구·입금·미수·완료율)에서 제외한다(서버 판정 그대로 — 화면 보정 없음).
//  · 입력/수정은 하지 않는다. 행 클릭 시 해당 판매상세(청구정보)로 이동한다.
//  · 조회 단위 = 청구행(project_payment) 1건. 분할청구면 판매 1건이 여러 행으로 표시된다.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { formatWon } from "@/lib/utils";
import { api } from '../../lib/constants';
import { Card, FilterPill, GhostBtn } from '../ui';
import { Pagination } from '../ui/Paginator';
import './readTableView.css';
import { formatDisplayDate } from '../../lib/dateFormat';
import { exportCollections } from '../../lib/collectionsExcel';
import { displayPaymentMethod } from '../../lib/paymentMethodDisplay';

type CollectionRow = {
  id: number;
  rowKey?: string;                 // 'current:<id>' | 'legacy:<legacy_archive_rows.id>'
  source?: "current" | "legacy";
  legacyRowId?: number | null;     // 과거 CRM 원본 행 id(과거 판매 상세 연결)
  reviewReason?: string | null;    // 확인 필요 사유(과거 CRM)
  parsedDepositAmount?: number | null;  // 원본 입금내역에서 읽힌 금액 합계(참고 — 집계 미반영)
  saleDate?: string | null;
  projectId: number | null;
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
  paidAmount: number | null;       // 과거 CRM '확인 필요' → null(미확정)
  receivable: number | null;
  status: "scheduled" | "partial" | "completed" | "review";
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
  review?: { count: number; totalAmount: number };
  sources?: { current: number; legacy: number; legacyLinkedExcluded: number };
};

// 파생 필터(값을 DB에 저장하지 않고 조회 시 계산). 'receivable'/'overdue'는 status 와 별개 축.
type CollectionFilter = "all" | "scheduled" | "partial" | "completed" | "receivable" | "overdue" | "review";
type SourceFilter = "all" | "current" | "legacy";
const FILTERS: { key: CollectionFilter; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "scheduled", label: "입금예정" },
  { key: "partial", label: "부분입금" },
  { key: "completed", label: "입금완료" },
  { key: "receivable", label: "미수금 있음" },
  { key: "overdue", label: "기한경과" },
  { key: "review", label: "확인 필요" },
];

const STATUS_META: Record<CollectionRow["status"], { label: string; bg: string; color: string }> = {
  scheduled: { label: "입금예정", bg: "#f3f4f6", color: "#6b7280" },
  partial: { label: "부분입금", bg: "#fef3c7", color: "#b45309" },
  completed: { label: "입금완료", bg: "#dcfce7", color: "#15803d" },
  review: { label: "확인 필요", bg: "#ede9fe", color: "#6d28d9" },
};
const wonOrDash = (n: number | null) => (n == null ? "-" : formatWon(n));
const sortDateOf = (r: CollectionRow) => (r.source === "legacy" ? r.saleDate : (r.issueDate ?? r.expectedDate ?? r.lastPaidDate)) ?? "";

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
  return s ? formatDisplayDate(s.slice(0, 10)) : "-";
}

interface Props {
  token: string;
  onToast?: (msg: string) => void;
  onOpenSalesDetail?: (projectId: number) => void;
  onOpenLegacyDetail?: (legacyRowId: number) => void;   // 과거 CRM 판매 상세(/legacy-archive/:id)
}

export function CollectionsTab({ token, onToast, onOpenSalesDetail, onOpenLegacyDetail }: Props) {
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const [rows, setRows] = useState<CollectionRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<CollectionFilter>("all");
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pg, setPg] = useState({ page: 1, pageSize: 50 });

  const fetchCollections = useCallback(async () => {
    setLoading(true);
    try {
      setLoadError(null);
      const res = await fetch(api("/api/admin/collections?include=legacy"), { headers: authHeaders });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        // 최신 자료부터(신규: 발행·예정·입금일 / 과거: 판매일). 날짜 없는 자료는 뒤에 — 누락 없이 유지.
        const list: CollectionRow[] = Array.isArray(data?.rows) ? data.rows : [];
        list.sort((a, b) => (sortDateOf(b) || "").localeCompare(sortDateOf(a) || "") || (sortDateOf(a) ? 0 : 1) - (sortDateOf(b) ? 0 : 1));
        setRows(list);
        setSummary(data?.summary ?? null);
      } else {
        const m = res.status === 401 || res.status === 403 ? "수금 현황 조회 권한이 없습니다." : (data?.error ?? `수금 현황 API 오류 (HTTP ${res.status})`);
        setLoadError(m); onToast?.(`오류: ${m}`);
      }
    } catch {
      setLoadError("서버에 연결할 수 없습니다(데이터 연결 오류)."); onToast?.("오류: 수금 현황 조회 실패");
    } finally {
      setLoading(false);
    }
  }, [authHeaders, onToast]);

  useEffect(() => { fetchCollections(); }, [fetchCollections]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (source !== "all" && (r.source ?? "current") !== source) return false;
      // 상태/파생 필터
      if (filter === "receivable") { if (!(r.receivable != null && r.receivable > 0)) return false; }
      else if (filter === "overdue") { if (!r.overdue) return false; }
      else if (filter !== "all") { if (r.status !== filter) return false; }
      // 검색: 판매번호/견적번호 · 프로젝트명 · 청구업체(거래처) · 담당PM · 발행일·입금예정일·입금일 · 입금상태
      if (q) {
        const hay = [r.quoteNumber, r.projectTitle, r.billingCompanyName, r.pmName, r.issueDate, r.expectedDate, r.lastPaidDate,
          STATUS_META[r.status]?.label, r.overdue ? "기한경과" : null]
          .filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, filter, search, source]);
  useEffect(() => { setPg((v) => ({ ...v, page: 1 })); }, [filter, search, source]);
  const pageRows = filtered.slice((pg.page - 1) * pg.pageSize, pg.page * pg.pageSize);
  const reset = () => { setFilter("all"); setSearch(""); setSource("all"); };
  const openRow = (r: CollectionRow) => {
    if (r.source === "legacy") { if (r.legacyRowId != null) onOpenLegacyDetail?.(r.legacyRowId); }
    else if (r.projectId != null) onOpenSalesDetail?.(r.projectId);
  };

  const rate = summary && summary.totalBilled > 0
    ? Math.round((summary.totalPaid / summary.totalBilled) * 1000) / 10
    : 0;

  return (
    <div style={{ marginBottom: 32 }} data-testid="collections-tab">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>수금 현황 ({filtered.length})</h2>
        <GhostBtn
          onClick={() => {
            if (filtered.length === 0) { onToast?.("다운로드할 수금 내역이 없습니다."); return; }
            exportCollections(filtered);
            onToast?.(`${filtered.length.toLocaleString()}건을 Excel로 내보냈습니다.`);
          }}
          style={{ fontSize: 12, padding: "6px 14px" }}
          data-testid="collections-excel-export-btn"
          aria-label="수금 현황 Excel 다운로드"
        >
          Excel 다운로드
        </GhostBtn>
      </div>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#6b7280" }}>
        판매상세 &gt; 청구정보의 청구/입금과 과거 CRM 판매목록을 함께 조회합니다. (선입금·차감 견적 제외 · 조회 전용 · 입금 판정이 불명확한 과거 건은 '확인 필요'로 분리해 상단 집계에서 제외)
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
      {summary?.review && summary.review.count > 0 && (
        <div data-testid="collections-review-notice" style={{ margin: "-4px 0 12px", padding: "7px 12px", background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 8, fontSize: 12, color: "#5b21b6" }}>
          확인 필요(과거 CRM) <b>{summary.review.count.toLocaleString()}건</b> · 판매총액 <b>{formatWon(summary.review.totalAmount)}</b> — 입금내역 금액이 판매금액과 일치하지 않거나 확인할 수 없어 상단 집계에서 제외(입금완료·미수금으로 확정하지 않음).
          {summary.sources && <span style={{ color: "#7c3aed" }}> · 조회 대상: 신규 {summary.sources.current.toLocaleString()}건 · 과거 CRM {summary.sources.legacy.toLocaleString()}건{summary.sources.legacyLinkedExcluded ? ` (신규 판매로 전환된 ${summary.sources.legacyLinkedExcluded}건은 신규 기준으로만 집계)` : ""}</span>}
        </div>
      )}

      {/* ── 필터 + 검색 ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {FILTERS.map((f) => (
            <FilterPill key={f.key} label={f.label} active={filter === f.key} onClick={() => setFilter(f.key)} />
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <select value={source} onChange={(e) => setSource(e.target.value as SourceFilter)} data-testid="collections-source" aria-label="과거·신규 구분"
            style={{ padding: "7px 10px", fontSize: 13, border: "1px solid #e5e7eb", borderRadius: 8, background: "#fff" }}>
            <option value="all">과거+신규 전체</option><option value="current">신규 판매</option><option value="legacy">과거 CRM</option>
          </select>
          <input
            data-testid="collections-search"
            aria-label="수금 현황 검색"
            placeholder="판매번호 · 프로젝트명 · 청구업체 · 담당PM · 날짜 · 입금상태"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: "7px 12px", fontSize: 13, border: "1px solid #e5e7eb", borderRadius: 8, minWidth: 300 }}
          />
          <GhostBtn onClick={reset} style={{ fontSize: 12, padding: "6px 12px" }} data-testid="collections-reset" aria-label="검색 초기화">초기화</GhostBtn>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
      ) : loadError ? (
        <Card style={{ textAlign: "center", padding: "24px", color: "#dc2626", fontSize: 14 }} data-testid="collections-error">
          ⚠ {loadError} <GhostBtn onClick={fetchCollections} style={{ fontSize: 12, padding: "5px 12px", marginLeft: 8 }} data-testid="collections-retry" aria-label="다시 시도">다시 시도</GhostBtn>
        </Card>
      ) : filtered.length === 0 ? (
        <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>
          {rows.length === 0 ? "청구/수금 내역이 없습니다." : "조건에 맞는 내역이 없습니다."}
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 300px)" }}>
            <table className="veritas-read-table vz-sticky" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {/* 헤더 정렬 = 본문 정렬(금액 3열만 right, 나머지 left) */}
                  {([
                    { label: "판매번호", align: "left" as const },
                    { label: "프로젝트명", align: "left" as const },
                    { label: "청구업체", align: "left" as const },
                    { label: "결제방법", align: "left" as const },
                    { label: "발행일", align: "left" as const },
                    { label: "입금예정일", align: "left" as const },
                    { label: "최근입금일", align: "left" as const },
                    { label: "청구금액", align: "right" as const },
                    { label: "누적입금액", align: "right" as const },
                    { label: "미수금", align: "right" as const },
                    { label: "입금상태", align: "left" as const },
                    { label: "입금은행", align: "left" as const },
                    { label: "외화", align: "left" as const },
                    { label: "담당PM", align: "left" as const },
                    { label: "비고", align: "left" as const },
                  ]).map((h) => <th key={h.label} style={{ ...th, textAlign: h.align }}>{h.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => {
                  const sm = STATUS_META[r.status];
                  const isLegacy = r.source === "legacy";
                  return (
                    <tr
                      key={r.rowKey ?? r.id}
                      data-testid={`collection-row-${r.rowKey ?? r.id}`}
                      data-source={r.source ?? "current"}
                      onClick={() => openRow(r)}
                      style={{ cursor: (isLegacy ? onOpenLegacyDetail : onOpenSalesDetail) ? "pointer" : "default" }}
                    >
                      <td style={{ ...td, fontWeight: 600, color: "#2563eb", whiteSpace: "nowrap" }}>
                        {r.quoteNumber ?? "-"}
                        {!isLegacy && (r.sequence > 1 || r.quoteNumber == null) ? <span style={{ color: "#9ca3af", fontWeight: 400 }}> ·{r.sequence}회차</span> : null}
                        {isLegacy ? <span style={{ marginLeft: 4, fontSize: 10, fontWeight: 600, color: "#6d28d9", background: "#f5f3ff", padding: "1px 5px", borderRadius: 6 }}>과거 CRM</span> : null}
                      </td>
                      <td style={{ ...td, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.projectTitle ?? "(제목 없음)"}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{r.billingCompanyName ?? "-"}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{displayPaymentMethod(r.paymentMethod) || "-"}</td>
                      <td style={{ ...td, whiteSpace: "nowrap", color: "#6b7280" }}>{fmtDate(r.issueDate)}</td>
                      <td style={{ ...td, whiteSpace: "nowrap", color: r.overdue ? "#dc2626" : "#6b7280", fontWeight: r.overdue ? 700 : 400 }}>
                        {fmtDate(r.expectedDate)}{r.overdue ? " ⚠" : ""}
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap", color: "#6b7280" }}>{fmtDate(r.lastPaidDate)}</td>
                      <td style={{ ...tdNum, fontWeight: 700, color: "#0891b2" }}>{formatWon(r.amount)}</td>
                      <td style={tdNum} title={r.status === "review" && r.parsedDepositAmount != null ? `입금내역에서 읽힌 금액 ${formatWon(r.parsedDepositAmount)} (미확정 — 집계 제외)` : undefined}>{wonOrDash(r.paidAmount)}</td>
                      <td style={{ ...tdNum, fontWeight: (r.receivable ?? 0) > 0 ? 700 : 400, color: (r.receivable ?? 0) > 0 ? "#dc2626" : "#9ca3af" }}>{wonOrDash(r.receivable)}</td>
                      <td style={td}>
                        <span title={r.reviewReason ?? undefined} style={{ display: "inline-block", padding: "2px 10px", borderRadius: 12, fontSize: 12, fontWeight: 600, background: sm.bg, color: sm.color, whiteSpace: "nowrap", cursor: r.reviewReason ? "help" : undefined }}>{sm.label}</span>
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
          <div style={{ padding: "0 12px" }}>
            <Pagination idPrefix="collections" page={pg.page} pageSize={pg.pageSize} total={filtered.length} unit="건" pageSizeOptions={[50, 100, 200]}
              onPageChange={(p) => setPg((v) => ({ ...v, page: p }))} onPageSizeChange={(sz) => setPg({ page: 1, pageSize: sz })} />
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
