// ─── 선입금관리 — 거래처별 선입금 현황(목록형) ─────────────────────────────────────────
//  거래처 행 클릭 → 그 아래에 상세 원장 펼침(PrepaidCompanyLedger). 다시 클릭하면 접힘.
//  값은 매번 서버에서 다시 받는다(캐시 미사용) — 수정 후 펼침/메뉴 이동/새로고침 어디서 봐도 같은 최신값.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { formatDisplayDate } from "../../lib/dateFormat";
import { GhostBtn } from "../ui";
import { DateField } from "./DatePickerShared";
import { PrepaidCompanyLedger } from "./PrepaidCompanyLedger";
import { exportPrepaidOverview } from "../../lib/prepaidExcel";
import { getJson, won, STATUS_LABEL, STATUS_STYLE, type OverviewRow } from "./prepaidLedgerShared";

type SortKey = "companyName" | "totalDeposit" | "totalDeduction" | "confirmedBalance" | "pendingInflow" | "pendingDeduction" | "expectedBalance" | "lastTxDate";
type StatusFilter = "all" | OverviewRow["status"] | "opening";

export function PrepaidLedgerTab({ authHeaders, canManage, canDelete, isAdmin, reloadKey, onOpenAccount, onChanged, onToast }: {
  authHeaders: Record<string, string>; canManage: boolean; canDelete: boolean; isAdmin: boolean;
  /** 외부(계정 등록 등)에서 목록 갱신 요청 */
  reloadKey: number;
  /** 기존 계정 원장 화면(PrepaidLedgerModal) 열기 */
  onOpenAccount: (accountId: number) => void;
  onChanged?: () => void;
  onToast?: (msg: string) => void;
}) {
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "companyName", dir: 1 });
  const [open, setOpen] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      setRows(await getJson<OverviewRow[]>(`/api/prepaid/overview${qs.toString() ? `?${qs}` : ""}`, authHeaders));
    } catch (e: any) { setError(e?.message ?? "조회 실패"); }
    finally { setLoading(false); }
  }, [authHeaders, from, to]);
  useEffect(() => { load(); }, [load, reloadKey]);

  const view = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const list = rows.filter(r => (!kw || r.companyName.toLowerCase().includes(kw))
      && (status === "all" || (status === "opening" ? r.openingBalance !== 0 : r.status === status)));
    return [...list].sort((a, b) => {
      const av = a[sort.key] ?? "", bv = b[sort.key] ?? "";
      return (typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), "ko")) * sort.dir;
    });
  }, [rows, q, status, sort]);
  const sum = useMemo(() => view.reduce((s, r) => ({
    dep: s.dep + r.totalDeposit, ded: s.ded + r.totalDeduction, bal: s.bal + r.confirmedBalance,
    pIn: s.pIn + r.pendingInflow, pDed: s.pDed + r.pendingDeduction, exp: s.exp + r.expectedBalance,
  }), { dep: 0, ded: 0, bal: 0, pIn: 0, pDed: 0, exp: 0 }), [view]);

  const toggle = (id: number) => setOpen(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const onLedgerChanged = async () => { await load(); onChanged?.(); };
  const sortBy = (key: SortKey) => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "companyName" || key === "lastTxDate" ? 1 : -1 }));

  const exportExcel = () => {
    if (view.length === 0) { onToast?.("다운로드할 거래처가 없습니다."); return; }
    exportPrepaidOverview(view.map(r => ({ ...r, statusLabel: STATUS_LABEL[r.status] })));
    onToast?.(`${view.length.toLocaleString()}개 거래처를 Excel로 내보냈습니다.`);
  };

  const th = (label: string, key?: SortKey, align: "left" | "right" | "center" = "left"): React.ReactNode => (
    <th key={label} onClick={key ? () => sortBy(key) : undefined} aria-sort={key && sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
      style={{ padding: "7px 10px", textAlign: align, fontSize: 11, fontWeight: 700, color: "#475569", borderBottom: "1px solid #e2e8f0", whiteSpace: "nowrap", cursor: key ? "pointer" : "default", userSelect: "none", background: "#f8fafc", position: "sticky", top: 0, zIndex: 1 }}>
      {label}{key && sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
    </th>
  );
  const inp: React.CSSProperties = { padding: "5px 9px", fontSize: 12, border: "1px solid #d1d5db", borderRadius: 6, background: "#fff" };
  const numTd = (v: number, color = "#111827", bold = false): React.ReactNode => (
    <td style={{ padding: "7px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", color: v === 0 ? "#cbd5e1" : color, fontWeight: bold ? 700 : 400 }}>{won(v)}</td>
  );

  return (
    <div data-testid="prepaid-ledger-tab">
      {/* 검색·필터 */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="거래처명 검색" data-testid="prepaid-search" aria-label="거래처명 검색" style={{ ...inp, width: 200 }} />
        <span style={{ fontSize: 12, color: "#64748b" }}>거래기간</span>
        <div style={{ width: 130 }}><DateField value={from} onChange={v => setFrom(v)} ariaLabel="거래기간 시작" testid="prepaid-from" style={{ ...inp, width: "100%" }} /></div>
        <span style={{ fontSize: 12, color: "#94a3b8" }}>~</span>
        <div style={{ width: 130 }}><DateField value={to} onChange={v => setTo(v)} ariaLabel="거래기간 끝" testid="prepaid-to" style={{ ...inp, width: "100%" }} /></div>
        <select value={status} onChange={e => setStatus(e.target.value as StatusFilter)} data-testid="prepaid-status-filter" aria-label="상태 필터" style={inp}>
          <option value="all">전체 상태</option>
          <option value="balance">잔액 있음</option>
          <option value="pending">확정 대기</option>
          <option value="empty">소진</option>
          <option value="closed">마감</option>
          <option value="opening">기초 잔액(원장 미기록) 있음</option>
        </select>
        <div style={{ flex: 1 }} />
        <GhostBtn onClick={exportExcel} data-testid="prepaid-overview-excel" aria-label="거래처별 선입금 현황 Excel 다운로드" style={{ fontSize: 12, padding: "5px 12px" }}>현황 Excel</GhostBtn>
      </div>
      <div style={{ fontSize: 12, color: "#475569", marginBottom: 6 }}>
        거래처 {view.length.toLocaleString()}곳 · 확정 잔액 합계 <b style={{ color: "#15803d" }}>{won(sum.bal)}원</b> · 예상 잔액 합계 <b style={{ color: "#92400e" }}>{won(sum.exp)}원</b>
        <span style={{ color: "#94a3b8" }}> · 확정 잔액 = 확정 입금 − 확정 차감, 예상 잔액 = 확정 잔액 + 예정 입금 − 예정 차감</span>
      </div>
      {error && <div role="alert" style={{ color: "#b91c1c", fontSize: 12, marginBottom: 8 }}>{error}</div>}

      <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, overflow: "auto", maxHeight: "calc(100vh - 260px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr>
              {th("", undefined, "center")}
              {th("거래처", "companyName")}
              {th("총 입금액", "totalDeposit", "right")}
              {th("총 차감액", "totalDeduction", "right")}
              {th("확정 잔액", "confirmedBalance", "right")}
              {th("예정 입금액", "pendingInflow", "right")}
              {th("예정 차감액", "pendingDeduction", "right")}
              {th("예상 잔액", "expectedBalance", "right")}
              {th("최근 거래일", "lastTxDate", "center")}
              {th("상태", undefined, "center")}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && <tr><td colSpan={10} style={{ padding: 24, textAlign: "center", color: "#94a3b8" }}>불러오는 중…</td></tr>}
            {!loading && view.length === 0 && <tr><td colSpan={10} style={{ padding: 24, textAlign: "center", color: "#94a3b8" }}>조건에 맞는 거래처가 없습니다.</td></tr>}
            {view.map((r, i) => {
              const isOpen = open.has(r.companyId);
              const st = STATUS_STYLE[r.status];
              return (
                <React.Fragment key={r.companyId}>
                  <tr onClick={() => toggle(r.companyId)} data-testid={`prepaid-row-${r.companyId}`} aria-expanded={isOpen}
                    style={{ cursor: "pointer", background: isOpen ? "#eff6ff" : i % 2 ? "#fbfdff" : "#fff", borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "7px 6px", textAlign: "center", color: "#64748b", width: 24 }}>
                      <button type="button" onClick={e => { e.stopPropagation(); toggle(r.companyId); }} data-testid={`prepaid-toggle-${r.companyId}`}
                        aria-label={`${r.companyName} 원장 ${isOpen ? "접기" : "펼치기"}`} style={{ border: "none", background: "none", cursor: "pointer", color: "#64748b", fontSize: 11 }}>{isOpen ? "▼" : "▶"}</button>
                    </td>
                    <td style={{ padding: "7px 10px", fontWeight: 600, color: "#1e3a8a", whiteSpace: "nowrap" }}>
                      {r.companyName}
                      {r.accountCount > 1 && <span style={{ fontSize: 10, color: "#64748b", fontWeight: 400 }}> · 계정 {r.accountCount}</span>}
                      {r.openingBalance !== 0 && <span title="계정 잔액과 원장 합계의 차이(원장에 없는 기초 잔액)" style={{ fontSize: 10, color: "#b45309", fontWeight: 400 }}> · 기초 {won(r.openingBalance)}</span>}
                    </td>
                    {numTd(r.totalDeposit, "#15803d")}
                    {numTd(r.totalDeduction, "#b91c1c")}
                    {numTd(r.confirmedBalance, r.confirmedBalance < 0 ? "#b91c1c" : "#0f172a", true)}
                    {numTd(r.pendingInflow, "#15803d")}
                    {numTd(r.pendingDeduction, "#b91c1c")}
                    {numTd(r.expectedBalance, r.expectedBalance < 0 ? "#b91c1c" : "#92400e", true)}
                    <td style={{ padding: "7px 10px", textAlign: "center", whiteSpace: "nowrap", color: "#475569" }}>{r.lastTxDate ? formatDisplayDate(r.lastTxDate) : "-"}</td>
                    <td style={{ padding: "7px 10px", textAlign: "center" }}>
                      <span style={{ background: st.bg, color: st.color, borderRadius: 4, padding: "1px 7px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
                        {STATUS_LABEL[r.status]}{r.pendingConfirmableCount > 0 ? ` · 확정 반영 ${r.pendingConfirmableCount}` : ""}
                      </span>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr data-testid={`prepaid-ledger-${r.companyId}`}>
                      <td colSpan={10} style={{ padding: "8px 10px 14px 34px", background: "#f8fafc", borderBottom: "2px solid #bfdbfe" }}>
                        <PrepaidCompanyLedger key={`${r.companyId}-${reloadKey}`} companyId={r.companyId} authHeaders={authHeaders}
                          canManage={canManage} canDelete={canDelete} isAdmin={isAdmin} onOpenAccount={onOpenAccount}
                          onChanged={onLedgerChanged} onToast={onToast} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
          {view.length > 0 && (
            <tfoot>
              <tr style={{ background: "#f1f5f9", fontWeight: 700, borderTop: "2px solid #cbd5e1" }}>
                <td />
                <td style={{ padding: "7px 10px" }}>합계</td>
                {numTd(sum.dep, "#15803d", true)}{numTd(sum.ded, "#b91c1c", true)}{numTd(sum.bal, "#0f172a", true)}
                {numTd(sum.pIn, "#15803d", true)}{numTd(sum.pDed, "#b91c1c", true)}{numTd(sum.exp, "#92400e", true)}
                <td /><td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
