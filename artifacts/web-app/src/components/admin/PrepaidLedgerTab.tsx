// ─── 선입금관리(조회 전용) — 거래처별 목록(거래처명 · 총 입금액 · 총 차감액 · 현재 잔액) ─────────────
//  거래처 행 클릭 → 그 아래에 원장 펼침, 다시 클릭하면 접힘. 잔액 = 누적 입금 − 누적 차감.
//  값은 매번 서버에서 다시 받는다(캐시 미사용) — 수정 후 펼침/메뉴 이동/새로고침 어디서 봐도 같은 최신값.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { GhostBtn, confirmDialog, alertDialog } from "../ui";
import { api } from "../../lib/constants";
import { DateField } from "./DatePickerShared";
import { PrepaidCompanyLedger } from "./PrepaidCompanyLedger";
import { exportPrepaidOverview } from "../../lib/prepaidExcel";
import { getJson, won, type OverviewRow } from "./prepaidLedgerShared";

type SortKey = "companyName" | "totalDeposit" | "totalDeduction" | "balance";

export function PrepaidLedgerTab({ authHeaders, reloadKey, onToast }: {
  authHeaders: Record<string, string>;
  /** 새로고침 요청 */
  reloadKey: number;
  onToast?: (msg: string) => void;
}) {
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
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
    return rows.filter(r => !kw || r.companyName.toLowerCase().includes(kw)).sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      return (typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), "ko")) * sort.dir;
    });
  }, [rows, q, sort]);

  // 선택 — 이 목록은 페이지 분할이 없으므로 "현재 페이지" = 현재 검색·기간 조건으로 보이는 행 전체.
  //  조건이 바뀌어 화면에서 빠진 거래처는 선택에서도 자동 제외(보이지 않는 행이 삭제 대상에 섞이지 않게).
  const [selected, setSelected] = useState<Set<number>>(new Set());
  useEffect(() => {
    setSelected(prev => {
      if (prev.size === 0) return prev;
      const ids = new Set(view.map(r => r.companyId));
      const n = new Set([...prev].filter(id => ids.has(id)));
      return n.size === prev.size ? prev : n;
    });
  }, [view]);
  const allChecked = view.length > 0 && view.every(r => selected.has(r.companyId));
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(view.map(r => r.companyId)));
  const toggleSel = (id: number) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // 거래처 원장 삭제(선택 일괄) — 기존 단건 흐름을 거래처마다 그대로 적용:
  //  delete-check(금융거래 없는 테스트 계정만 삭제 가능, 서버가 다시 검사) → 확인 → DELETE(권한 서버 검사).
  //  거래처 마스터·견적서는 삭제하지 않음.
  const [deleting, setDeleting] = useState(false);
  type DeleteCheck = { companyName: string; depositCount: number; deductionCount: number; quotes: Array<{ id: number; quoteNumber: string | null }>; deletable: boolean; reasons: string[] };
  const removeSelected = async () => {
    if (deleting || selected.size === 0) return;
    const targets = view.filter(r => selected.has(r.companyId));
    if (targets.length === 0) return;
    setDeleting(true);
    try {
      const checks: Array<{ r: OverviewRow; chk: DeleteCheck }> = [];
      for (const r of targets) {
        const chk = await getJson<DeleteCheck>(`/api/prepaid/companies/${r.companyId}/delete-check`, authHeaders);
        checks.push({ r, chk });
      }
      const ok = checks.filter(c => c.chk.deletable);
      const blocked = checks.filter(c => !c.chk.deletable);
      const line = (c: { chk: DeleteCheck }) => {
        const quotes = c.chk.quotes.length ? c.chk.quotes.map(q => q.quoteNumber ?? `#${q.id}`).join(", ") : "없음";
        return `· ${c.chk.companyName} — 선입금·이월 ${c.chk.depositCount}건 · 차감·환불 ${c.chk.deductionCount}건 · 연결 견적서: ${quotes}`;
      };
      const blockedText = blocked.length
        ? `삭제할 수 없는 거래처 ${blocked.length}건(금융거래가 있는 원장은 삭제하지 않습니다):\n${blocked.map(c => `${line(c)}\n   ${c.chk.reasons.join(" / ")}`).join("\n")}`
        : "";
      if (ok.length === 0) {
        await alertDialog({ title: "삭제할 수 없습니다", variant: "warning", message: blockedText });
        return;
      }
      const confirmed = await confirmDialog({ title: `선입금 원장 ${ok.length}건 삭제`, variant: "danger", confirmLabel: `${ok.length}건 삭제`, cancelLabel: "취소",
        message: `선택 ${targets.length}건 중 삭제 대상 ${ok.length}건:\n${ok.map(line).join("\n")}`
          + (blockedText ? `\n\n${blockedText}` : "")
          + `\n\n금융거래가 없는 선입금 원장(계정)만 삭제합니다. 거래처 마스터와 견적서는 삭제되지 않습니다.` });
      if (!confirmed) return;
      const done: OverviewRow[] = [];
      const failed: string[] = [];
      for (const c of ok) {
        const res = await fetch(api(`/api/prepaid/companies/${c.r.companyId}`), { method: "DELETE", headers: authHeaders });
        const d = await res.json().catch(() => ({}));
        if (res.ok) done.push(c.r); else failed.push(`· ${c.chk.companyName}: ${(d as any)?.error ?? `오류 (${res.status})`}`);
      }
      if (done.length) {
        const ids = new Set(done.map(r => r.companyId));
        setOpen(prev => new Set([...prev].filter(id => !ids.has(id))));
        setSelected(prev => new Set([...prev].filter(id => !ids.has(id))));
        onToast?.(`선입금 원장 ${done.length}건을 삭제했습니다.`);
        await load();
      }
      if (failed.length) await alertDialog({ title: `${failed.length}건을 삭제하지 못했습니다`, variant: "warning", message: failed.join("\n") });
    } catch (e: any) { onToast?.(e?.message ?? "삭제 확인 실패"); }
    finally { setDeleting(false); }
  };

  const toggle = (id: number) => setOpen(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const sortBy = (key: SortKey) => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "companyName" ? 1 : -1 }));
  const exportExcel = () => {
    if (view.length === 0) { onToast?.("다운로드할 거래처가 없습니다."); return; }
    exportPrepaidOverview(view);
    onToast?.(`${view.length.toLocaleString()}개 거래처를 Excel로 내보냈습니다.`);
  };

  const th = (label: string, key: SortKey, align: "left" | "right"): React.ReactNode => (
    <th key={label} onClick={() => sortBy(key)} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
      style={{ padding: "7px 10px", textAlign: align, fontSize: 12, fontWeight: 700, color: "#475569", borderBottom: "1px solid #e2e8f0", whiteSpace: "nowrap", cursor: "pointer", userSelect: "none", background: "#f8fafc", position: "sticky", top: 0, zIndex: 1 }}>
      {label}{sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
    </th>
  );
  const inp: React.CSSProperties = { padding: "5px 9px", fontSize: 12, border: "1px solid #d1d5db", borderRadius: 6, background: "#fff" };
  const num: React.CSSProperties = { padding: "7px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

  return (
    <div data-testid="prepaid-ledger-tab">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="거래처명 검색" data-testid="prepaid-search" aria-label="거래처명 검색" style={{ ...inp, width: 200 }} />
        <span style={{ fontSize: 12, color: "#64748b" }}>거래기간</span>
        <div style={{ width: 130 }}><DateField value={from} onChange={v => setFrom(v)} ariaLabel="거래기간 시작" testid="prepaid-from" style={{ ...inp, width: "100%" }} /></div>
        <span style={{ fontSize: 12, color: "#94a3b8" }}>~</span>
        <div style={{ width: 130 }}><DateField value={to} onChange={v => setTo(v)} ariaLabel="거래기간 끝" testid="prepaid-to" style={{ ...inp, width: "100%" }} /></div>
        <div style={{ flex: 1 }} />
        <GhostBtn onClick={exportExcel} data-testid="prepaid-overview-excel" aria-label="거래처별 선입금 Excel 다운로드" style={{ fontSize: 12, padding: "5px 12px" }}>Excel</GhostBtn>
        <button type="button" onClick={() => void removeSelected()} disabled={selected.size === 0 || deleting}
          data-testid="prepaid-bulk-delete" aria-label={`선택한 거래처 선입금 원장 삭제 (${selected.size}건)`}
          style={{ fontSize: 12, padding: "5px 12px", fontWeight: 700, borderRadius: 6, whiteSpace: "nowrap",
            border: `1px solid ${selected.size ? "#dc2626" : "#e5e7eb"}`, background: selected.size ? "#dc2626" : "#f9fafb",
            color: selected.size ? "#fff" : "#9ca3af", cursor: selected.size && !deleting ? "pointer" : "not-allowed" }}>
          {deleting ? "확인 중…" : "삭제"}
        </button>
      </div>
      {/* 현재 페이지 전체선택 + 선택 n건 — 다른 목록과 같은 형태 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8, padding: "7px 12px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#374151", cursor: "pointer", fontWeight: 600 }}>
          <input type="checkbox" checked={allChecked} onChange={toggleAll} disabled={view.length === 0}
            aria-label="현재 페이지 전체 선택" data-testid="prepaid-select-page" style={{ width: 15, height: 15, cursor: "pointer" }} />
          현재 페이지 전체선택
        </label>
        <span data-testid="prepaid-selected-count" style={{ fontSize: 13, fontWeight: 700, color: selected.size > 0 ? "#2563eb" : "#9ca3af" }}>선택 {selected.size}건</span>
      </div>
      {error && <div role="alert" style={{ color: "#b91c1c", fontSize: 12, marginBottom: 8 }}>{error}</div>}

      <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, overflow: "auto", maxHeight: "calc(100vh - 230px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ width: 36, textAlign: "center", padding: "7px 4px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", position: "sticky", top: 0, zIndex: 1 }}>
                <input type="checkbox" checked={allChecked} onChange={toggleAll} disabled={view.length === 0}
                  aria-label="현재 페이지 전체 선택" data-testid="prepaid-select-all" style={{ width: 15, height: 15, cursor: "pointer" }} />
              </th>
              <th style={{ width: 28, background: "#f8fafc", borderBottom: "1px solid #e2e8f0", position: "sticky", top: 0, zIndex: 1 }} />
              {th("거래처명", "companyName", "left")}
              {th("총 입금액", "totalDeposit", "right")}
              {th("총 차감액", "totalDeduction", "right")}
              {th("현재 잔액", "balance", "right")}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && <tr><td colSpan={6} style={{ padding: 20, textAlign: "center", color: "#94a3b8" }}>불러오는 중…</td></tr>}
            {!loading && view.length === 0 && <tr><td colSpan={6} style={{ padding: 20, textAlign: "center", color: "#94a3b8" }}>조건에 맞는 거래처가 없습니다.</td></tr>}
            {view.map(r => {
              const isOpen = open.has(r.companyId);
              return (
                <React.Fragment key={r.companyId}>
                  <tr onClick={() => toggle(r.companyId)} data-testid={`prepaid-row-${r.companyId}`} aria-expanded={isOpen}
                    style={{ cursor: "pointer", background: isOpen ? "#f1f5f9" : "#fff", borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "7px 4px", textAlign: "center" }} onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(r.companyId)} onChange={() => toggleSel(r.companyId)}
                        data-testid={`prepaid-select-${r.companyId}`} aria-label={`${r.companyName} 선택`} style={{ width: 15, height: 15, cursor: "pointer" }} />
                    </td>
                    <td style={{ padding: "7px 4px", textAlign: "center" }}>
                      <button type="button" onClick={e => { e.stopPropagation(); toggle(r.companyId); }} data-testid={`prepaid-toggle-${r.companyId}`}
                        aria-label={`${r.companyName} 원장 ${isOpen ? "접기" : "펼치기"}`} style={{ border: "none", background: "none", cursor: "pointer", color: "#64748b", fontSize: 10 }}>{isOpen ? "▼" : "▶"}</button>
                    </td>
                    <td style={{ padding: "7px 10px", fontWeight: 600, color: "#0f172a", whiteSpace: "nowrap" }}>{r.companyName}</td>
                    <td style={num}>{won(r.totalDeposit)}</td>
                    <td style={num}>{won(r.totalDeduction)}</td>
                    <td style={{ ...num, fontWeight: 700, color: r.balance < 0 ? "#b91c1c" : "#0f172a" }}>{won(r.balance)}</td>
                  </tr>
                  {isOpen && (
                    <tr data-testid={`prepaid-ledger-${r.companyId}`}>
                      <td colSpan={6} style={{ padding: "6px 10px 12px 74px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                        <PrepaidCompanyLedger key={`${r.companyId}-${reloadKey}`} companyId={r.companyId} authHeaders={authHeaders} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
