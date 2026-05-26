import React, { useState, useMemo } from 'react';
import {
  api, AdminSettlement, ALL_SETTLEMENT_STATUSES, STATUS_LABEL,
} from '../../lib/constants';
import { Card, GhostBtn, FilterPill, StatusBadge } from '../ui';

function Section({ title, sub, children, action }: {
  title: string; sub?: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: sub ? 4 : 14 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>{title}</h2>
        {action}
      </div>
      {sub && <p style={{ margin: "0 0 12px", fontSize: 12, color: "#6b7280" }}>{sub}</p>}
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const tableTh: React.CSSProperties = {
  padding: "10px 12px", textAlign: "left", fontSize: 12,
  fontWeight: 600, color: "#6b7280", background: "#f9fafb",
  borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap",
};
const tableTd: React.CSSProperties = {
  padding: "9px 12px", fontSize: 13, color: "#374151",
  borderBottom: "1px solid #edf0f3", verticalAlign: "middle",
};

const SETTLEMENT_LABEL: Record<string, string> = {
  pending_review: "검토 필요", ready: "지급 준비",
  pending: "대기", draft: "정보 부족", paid: "지급 완료",
};
const STYPE_KO: Record<string, string> = {
  WITHHOLDING_3_3: "원천세 3.3%", VAT_INVOICE: "세금계산서",
  OVERSEAS_REMITTANCE: "해외송금", OTHER_REVIEW: "기타",
};
const STYPE_KO_CSV: Record<string, string> = {
  WITHHOLDING_3_3: "원천세3.3%", VAT_INVOICE: "세금계산서",
  OVERSEAS_REMITTANCE: "해외송금", OTHER_REVIEW: "기타검토",
};
const SSTATUS_KO: Record<string, string> = {
  pending: "대기", ready: "지급 준비", paid: "지급 완료",
  draft: "정보 부족", pending_review: "검토 필요",
};

interface Props {
  settlements: AdminSettlement[];
  loading: boolean;
  token: string;
  onToast: (msg: string) => void;
  onRefresh: () => Promise<void>;
}

export function SettlementManagementTab({ settlements, loading, token, onToast, onRefresh }: Props) {
  const authHeaders = { Authorization: `Bearer ${token}` };

  const [settlementFilter, setSettlementFilter] = useState<string>("all");
  const [settlementMonthFilter, setSettlementMonthFilter] = useState<string>("all");
  const [paidDateFrom, setPaidDateFrom] = useState<string>("");
  const [paidDateTo, setPaidDateTo] = useState<string>("");
  const [selectedSettlements, setSelectedSettlements] = useState<Set<number>>(new Set());
  const [batchPaying, setBatchPaying] = useState(false);
  const [editingMemo, setEditingMemo] = useState<{ id: number; value: string } | null>(null);
  const [paying, setPaying] = useState<number | null>(null);
  const [approving, setApproving] = useState<number | null>(null);

  const settlementMonths = useMemo(() => {
    const monthSet = new Set<string>();
    settlements.forEach(s => {
      const m = s.createdAt.slice(0, 7);
      monthSet.add(m);
    });
    return Array.from(monthSet).sort((a, b) => b.localeCompare(a));
  }, [settlements]);

  const filteredSettlements = useMemo(() => {
    const statusOrder = ["pending_review", "ready", "draft", "pending", "paid"];
    return settlements
      .filter(s => {
        if (settlementFilter !== "all" && s.status !== settlementFilter) return false;
        if (settlementMonthFilter !== "all" && s.createdAt.slice(0, 7) !== settlementMonthFilter) return false;
        if (paidDateFrom || paidDateTo) {
          if (!s.paidDate) return false;
          const pd = new Date(s.paidDate);
          if (paidDateFrom && pd < new Date(paidDateFrom)) return false;
          if (paidDateTo) {
            const toEnd = new Date(paidDateTo);
            toEnd.setHours(23, 59, 59, 999);
            if (pd > toEnd) return false;
          }
        }
        return true;
      })
      .sort((a, b) => {
        const si = statusOrder.indexOf(a.status ?? "pending");
        const sj = statusOrder.indexOf(b.status ?? "pending");
        if (si !== sj) return si - sj;
        const da = a.payoutDueDate ?? "9999-12-31";
        const db = b.payoutDueDate ?? "9999-12-31";
        if (da !== db) return da.localeCompare(db);
        const na = (a.translatorName ?? a.translatorEmail ?? "").toLowerCase();
        const nb = (b.translatorName ?? b.translatorEmail ?? "").toLowerCase();
        return na.localeCompare(nb, "ko");
      });
  }, [settlements, settlementFilter, settlementMonthFilter, paidDateFrom, paidDateTo]);

  const settlementStats = useMemo(() => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const thisMonth = today.slice(0, 7);
    const net = (s: AdminSettlement) => Number(s.netAmount ?? s.translatorAmount ?? 0);
    const readyList = settlements.filter(s => s.status === "ready");
    const unpaidTotal = readyList.reduce((sum, s) => sum + net(s), 0);
    const unpaidCount = readyList.length;
    const pendingReviewCount = settlements.filter(s => s.status === "pending_review").length;
    const thisMonthUnpaid = readyList
      .filter(s => s.createdAt.slice(0, 7) === thisMonth)
      .reduce((sum, s) => sum + net(s), 0);
    const paidTotal = settlements
      .filter(s => s.status === "paid")
      .reduce((sum, s) => sum + net(s), 0);
    const dueTodayCount = settlements
      .filter(s => s.payoutDueDate === today && s.status !== "paid").length;
    const overdueCount = settlements
      .filter(s => s.payoutDueDate && s.payoutDueDate < today && s.status !== "paid").length;
    return { unpaidTotal, unpaidCount, pendingReviewCount, thisMonthUnpaid, paidTotal, dueTodayCount, overdueCount };
  }, [settlements]);

  const handleExportCSV = async () => {
    try {
      const res = await fetch(api("/api/admin/export/settlements"), { headers: authHeaders });
      if (!res.ok) { onToast("오류: CSV 내보내기 실패"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `settlements_${Date.now()}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch { onToast("오류: CSV 내보내기 실패"); }
  };

  const handleExportFilteredCSV = () => {
    try {
      const dateStr = new Date().toISOString().slice(0, 10);
      const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const csvHeaders = [
        "거래처명", "프로젝트명", "통번역사",
        "원금액", "원천세", "부가세", "실지급액",
        "정산 유형", "지급 예정일",
        "정산 상태", "검토 사유", "자동 생성",
        "생성일", "지급 완료일", "메모",
      ];
      const rows = filteredSettlements.map(s => [
        esc(s.companyName ?? ""),
        esc(s.projectTitle ?? `프로젝트 #${s.projectId}`),
        esc(s.translatorName || s.translatorEmail || `#${s.translatorId}`),
        Math.round(Number(s.grossAmount ?? s.totalAmount)),
        Math.round(Number(s.withholdingAmount ?? 0)),
        Math.round(Number(s.vatAmount ?? 0)),
        Math.round(Number(s.netAmount ?? s.translatorAmount)),
        esc(STYPE_KO_CSV[s.settlementType ?? ""] ?? (s.settlementType ?? "")),
        esc(s.payoutDueDate ?? ""),
        esc(SSTATUS_KO[s.status] ?? s.status),
        esc(s.reviewReason ?? ""),
        s.isAutoGenerated ? "Y" : "N",
        new Date(s.createdAt).toLocaleDateString("ko-KR"),
        s.paidDate ? new Date(s.paidDate).toLocaleDateString("ko-KR") : "",
        esc(s.paymentMemo ?? ""),
      ].join(","));
      const csv = [csvHeaders.join(","), ...rows].join("\r\n");
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `정산내역_${dateStr}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      onToast(`정산 내역 ${filteredSettlements.length}건을 다운로드했습니다.`);
    } catch { onToast("오류: CSV 내보내기 실패"); }
  };

  const handlePaymentExport = () => {
    const ids = Array.from(selectedSettlements);
    if (ids.length === 0) return;
    const idsParam = ids.join(",");
    const url = api(`/api/admin/settlements/export?ids=${idsParam}`);
    fetch(url, { headers: authHeaders })
      .then(r => r.blob())
      .then(blob => {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.setAttribute("download", `payment_${new Date().toISOString().slice(0, 10)}.csv`);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      })
      .catch(() => onToast("오류: 지급 파일 다운로드 실패"));
  };

  const runSettlementApprove = async (settlementId: number) => {
    setApproving(settlementId);
    try {
      const res = await fetch(api(`/api/admin/settlements/${settlementId}/approve`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast(`정산 #${settlementId} 지급 준비로 승인되었습니다.`);
      await onRefresh();
    } catch { onToast("오류: 승인 처리 실패"); }
    finally { setApproving(null); }
  };

  const runSettlementPay = async (settlementId: number, paymentMemo?: string) => {
    setPaying(settlementId);
    try {
      const res = await fetch(api(`/api/admin/settlements/${settlementId}/pay`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ paymentMemo: paymentMemo ?? null }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setEditingMemo(null);
      onToast(`정산 #${settlementId} 완료 처리되었습니다.`);
      await onRefresh();
    } catch { onToast("오류: 정산 처리 실패"); }
    finally { setPaying(null); }
  };

  const runBatchPay = async () => {
    const ids = Array.from(selectedSettlements);
    if (ids.length === 0) return;
    setBatchPaying(true);
    try {
      const res = await fetch(api("/api/admin/settlements/bulk-pay"), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ settlementIds: ids }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast(`${data.updated}건 지급 완료 처리되었습니다.${data.skipped > 0 ? ` (${data.skipped}건 스킵)` : ""}`);
      setSelectedSettlements(new Set());
      await onRefresh();
    } catch { onToast("오류: 일괄 정산 처리 실패"); }
    finally { setBatchPaying(false); }
  };

  const readyIds = filteredSettlements.filter(s => s.status === "ready").map(s => s.id);
  const allReadySelected = readyIds.length > 0 && readyIds.every(id => selectedSettlements.has(id));
  const someSelected = selectedSettlements.size > 0;
  const toggleAll = () => {
    setSelectedSettlements(prev => {
      const currentlyAll = readyIds.length > 0 && readyIds.every(id => prev.has(id));
      const next = new Set(prev);
      if (currentlyAll) { readyIds.forEach(id => next.delete(id)); }
      else { readyIds.forEach(id => next.add(id)); }
      return next;
    });
  };
  const selectedTotal = filteredSettlements
    .filter(s => selectedSettlements.has(s.id))
    .reduce((sum, s) => sum + (parseFloat(String(s.netAmount ?? "0")) || 0), 0);

  return (
    <Section
      title={`정산 현황 (${filteredSettlements.length})`}
      action={
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <GhostBtn onClick={handleExportCSV} style={{ fontSize: 12, padding: "6px 12px" }}>⬇ 전체 CSV</GhostBtn>
          <FilterPill label="전체" active={settlementFilter === "all"} onClick={() => setSettlementFilter("all")} />
          {ALL_SETTLEMENT_STATUSES.map(s => (
            <FilterPill key={s} label={SETTLEMENT_LABEL[s] ?? STATUS_LABEL[s] ?? s}
              active={settlementFilter === s} onClick={() => setSettlementFilter(s)} />
          ))}
        </div>
      }
    >
      {/* ── 선택 액션 바 ── */}
      {someSelected && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 16px",
          background: "linear-gradient(135deg, #eff6ff, #dbeafe)",
          border: "1px solid #93c5fd", borderRadius: 10, marginBottom: 16,
          flexWrap: "wrap",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 200 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#1d4ed8" }}>
              {selectedSettlements.size}건 선택됨
            </span>
            <span style={{ fontSize: 12, color: "#6b7280" }}>|</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>
              합계 ₩{selectedTotal.toLocaleString()}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={handlePaymentExport} style={{
              padding: "7px 14px", fontSize: 12, borderRadius: 8, fontWeight: 600, cursor: "pointer",
              background: "#fff", border: "1px solid #3b82f6", color: "#2563eb", whiteSpace: "nowrap",
            }}>
              ⬇ 지급 파일 다운로드
            </button>
            <button type="button" onClick={runBatchPay} disabled={batchPaying} style={{
              padding: "7px 14px", fontSize: 12, borderRadius: 8, fontWeight: 700,
              cursor: batchPaying ? "not-allowed" : "pointer",
              background: batchPaying ? "#86efac" : "#059669", border: "none", color: "#fff", whiteSpace: "nowrap",
            }}>
              {batchPaying ? "처리 중..." : "선택 지급 완료"}
            </button>
            <button type="button" onClick={() => setSelectedSettlements(new Set())} style={{
              padding: "7px 12px", fontSize: 12, borderRadius: 8, fontWeight: 600, cursor: "pointer",
              background: "#f3f4f6", border: "1px solid #e5e7eb", color: "#6b7280", whiteSpace: "nowrap",
            }}>
              ✕ 선택 취소
            </button>
          </div>
        </div>
      )}

      {/* ── 통계 카드 4종 ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        <div style={{ background: "#fff", border: `1px solid ${settlementStats.dueTodayCount > 0 ? "#fecaca" : "#e5e7eb"}`, borderRadius: 12, padding: "14px 18px", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #ef4444, #f87171)" }} />
          <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, color: "#ef4444", textTransform: "uppercase", letterSpacing: "0.05em" }}>오늘 지급 예정</p>
          <p style={{ margin: "0 0 2px", fontSize: 22, fontWeight: 800, color: "#111827" }}>{settlementStats.dueTodayCount}건</p>
          {settlementStats.overdueCount > 0 && <p style={{ margin: 0, fontSize: 11, color: "#ef4444", fontWeight: 600 }}>⚠ 초과 {settlementStats.overdueCount}건</p>}
          {settlementStats.overdueCount === 0 && <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>오늘 기준</p>}
        </div>
        <div style={{ background: "#fff", border: `1px solid ${settlementStats.unpaidCount > 0 ? "#bbf7d0" : "#e5e7eb"}`, borderRadius: 12, padding: "14px 18px", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #059669, #34d399)" }} />
          <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, color: "#059669", textTransform: "uppercase", letterSpacing: "0.05em" }}>지급 준비</p>
          <p style={{ margin: "0 0 2px", fontSize: 22, fontWeight: 800, color: "#111827" }}>{settlementStats.unpaidCount}건</p>
          <p style={{ margin: 0, fontSize: 11, color: "#6b7280" }}>실지급 {Math.round(settlementStats.unpaidTotal).toLocaleString()}원</p>
        </div>
        <div style={{ background: "#fff", border: `1px solid ${settlementStats.pendingReviewCount > 0 ? "#fde68a" : "#e5e7eb"}`, borderRadius: 12, padding: "14px 18px", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #f59e0b, #fbbf24)" }} />
          <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, color: "#b45309", textTransform: "uppercase", letterSpacing: "0.05em" }}>검토 필요</p>
          <p style={{ margin: "0 0 2px", fontSize: 22, fontWeight: 800, color: "#111827" }}>{settlementStats.pendingReviewCount}건</p>
          <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>승인 후 지급 가능</p>
        </div>
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "14px 18px", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #6b7280, #9ca3af)" }} />
          <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>이번달 지급 예정액</p>
          <p style={{ margin: "0 0 2px", fontSize: 22, fontWeight: 800, color: "#111827" }}>{Math.round(settlementStats.thisMonthUnpaid).toLocaleString()}원</p>
          <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>누적 완료 {Math.round(settlementStats.paidTotal).toLocaleString()}원</p>
        </div>
      </div>

      {/* ── 월별 필터 ── */}
      {settlementMonths.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", marginRight: 2, whiteSpace: "nowrap" }}>월별</span>
          <button onClick={() => setSettlementMonthFilter("all")}
            style={{ padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: settlementMonthFilter === "all" ? 700 : 500, cursor: "pointer",
              background: settlementMonthFilter === "all" ? "#374151" : "#f3f4f6",
              color: settlementMonthFilter === "all" ? "#fff" : "#374151", border: "none" }}>
            전체
          </button>
          {settlementMonths.map(m => {
            const [y, mo] = m.split("-");
            const isActive = settlementMonthFilter === m;
            return (
              <button key={m} onClick={() => setSettlementMonthFilter(m)}
                style={{ padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: isActive ? 700 : 500, cursor: "pointer",
                  background: isActive ? "#1d4ed8" : "#f3f4f6", color: isActive ? "#fff" : "#374151", border: "none" }}>
                {y}.{mo}
              </button>
            );
          })}
        </div>
      )}

      {/* ── 지급 완료일 기간 필터 + 다운로드 ── */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
          padding: "10px 14px", background: "#f9fafb", borderRadius: 10, border: "1px solid #e5e7eb" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", whiteSpace: "nowrap" }}>지급일</span>
          <input
            type="date"
            value={paidDateFrom}
            onChange={e => setPaidDateFrom(e.target.value)}
            max={paidDateTo || undefined}
            style={{ ...inputStyle, fontSize: 12, padding: "5px 8px", width: 140 }}
          />
          <span style={{ fontSize: 12, color: "#9ca3af" }}>~</span>
          <input
            type="date"
            value={paidDateTo}
            onChange={e => setPaidDateTo(e.target.value)}
            min={paidDateFrom || undefined}
            style={{ ...inputStyle, fontSize: 12, padding: "5px 8px", width: 140 }}
          />
          {(paidDateFrom || paidDateTo) && (
            <button type="button" onClick={() => { setPaidDateFrom(""); setPaidDateTo(""); }}
              style={{ padding: "5px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer",
                background: "#fff", border: "1px solid #e5e7eb", color: "#6b7280", fontWeight: 500, whiteSpace: "nowrap" }}>
              초기화
            </button>
          )}
          <button type="button" onClick={handleExportFilteredCSV}
            style={{ ...inputStyle, padding: "5px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer",
              background: "#1d4ed8", border: "1px solid #1d4ed8", color: "#fff", fontWeight: 600,
              whiteSpace: "nowrap", marginLeft: "auto" }}>
            📥 내역 다운로드
          </button>
        </div>
        {(() => {
          const isFiltered = settlementFilter !== "all" || settlementMonthFilter !== "all" || !!paidDateFrom || !!paidDateTo;
          return (
            <p style={{ margin: "6px 0 0", fontSize: 12,
              color: isFiltered ? "#1d4ed8" : "#9ca3af", fontWeight: isFiltered ? 600 : 400 }}>
              {isFiltered
                ? `총 ${filteredSettlements.length}건의 정산 내역이 필터링되었습니다.`
                : `전체 ${filteredSettlements.length}건 표시 중`}
            </p>
          );
        })()}
      </div>

      {/* ── 목록 ── */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
      ) : filteredSettlements.length === 0 ? (
        <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>정산 내역이 없습니다.</Card>
      ) : (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ ...tableTh, width: 36, textAlign: "center" as const }}>
                    <input type="checkbox" checked={allReadySelected} onChange={toggleAll}
                      disabled={readyIds.length === 0}
                      title={readyIds.length === 0 ? "선택 가능한 미지급 건 없음" : "ready 전체 선택"}
                      style={{ cursor: readyIds.length === 0 ? "not-allowed" : "pointer" }} />
                  </th>
                  {["프로젝트","통번역사","납품일","지급 예정일","원금액","원천세","실지급액","정산 유형","상태","액션"].map(h => (
                    <th key={h} style={tableTh}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredSettlements.map(s => {
                  const isChecked = selectedSettlements.has(s.id);
                  const isEditing = editingMemo?.id === s.id;
                  const gross = Number(s.grossAmount ?? s.totalAmount ?? 0);
                  const net = Number(s.netAmount ?? s.translatorAmount ?? 0);
                  const withholding = Number(s.withholdingAmount ?? 0);
                  const today = new Date().toISOString().slice(0, 10);
                  const isOverdue = s.payoutDueDate && s.payoutDueDate < today && s.status !== "paid";
                  const isDueToday = s.payoutDueDate === today && s.status !== "paid";
                  return (
                    <tr key={s.id}
                      onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                      onMouseLeave={e => (e.currentTarget.style.background = isChecked ? "#f0fdf4" : "transparent")}
                      style={{ background: isChecked ? "#f0fdf4" : "transparent" }}>
                      <td style={{ ...tableTd, textAlign: "center" as const, width: 36 }}>
                        {s.status === "ready" ? (
                          <input type="checkbox" checked={isChecked}
                            onChange={() => setSelectedSettlements(prev => {
                              const next = new Set(prev);
                              isChecked ? next.delete(s.id) : next.add(s.id);
                              return next;
                            })}
                            style={{ cursor: "pointer" }} />
                        ) : (
                          <span style={{ color: "#d1d5db", fontSize: 10 }}>—</span>
                        )}
                      </td>
                      {/* 프로젝트 */}
                      <td style={{ ...tableTd, fontWeight: 600, color: "#111827", maxWidth: 150 }}>
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.projectTitle ?? `프로젝트 #${s.projectId}`}</div>
                        {s.companyName && <div style={{ fontSize: 11, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.companyName}</div>}
                      </td>
                      {/* 통번역사 */}
                      <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>
                        {(s.translatorName || s.translatorEmail)
                          ? <>
                              <div style={{ fontWeight: 600 }}>{s.translatorName || s.translatorEmail}</div>
                              {s.translatorName && s.translatorEmail && (
                                <div style={{ color: "#9ca3af", fontSize: 11 }}>{s.translatorEmail}</div>
                              )}
                            </>
                          : <span style={{ color: "#d1d5db", fontSize: 12 }}>정보 없음</span>
                        }
                      </td>
                      {/* 납품일 */}
                      <td style={{ ...tableTd, fontSize: 12, whiteSpace: "nowrap" }}>
                        {s.createdAt
                          ? <div>
                              <div style={{ fontWeight: 500, color: "#374151" }}>
                                {s.createdAt.slice(5, 10).replace("-", ".")}
                              </div>
                              {s.isAutoGenerated && (
                                <div style={{ fontSize: 10, color: "#7c3aed", fontWeight: 600, marginTop: 1 }}>🤖 자동</div>
                              )}
                            </div>
                          : <span style={{ color: "#d1d5db" }}>—</span>
                        }
                      </td>
                      {/* 지급 예정일 */}
                      <td style={{ ...tableTd, fontSize: 12, whiteSpace: "nowrap" }}>
                        {s.payoutDueDate
                          ? <div>
                              <span style={{ fontWeight: 600, color: isOverdue ? "#dc2626" : isDueToday ? "#d97706" : "#111827" }}>
                                {s.payoutDueDate}
                              </span>
                              {isOverdue && (
                                <div style={{ marginTop: 2 }}>
                                  <span style={{ padding: "1px 5px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: "#fee2e2", color: "#dc2626" }}>지연</span>
                                </div>
                              )}
                              {isDueToday && (
                                <div style={{ marginTop: 2 }}>
                                  <span style={{ padding: "1px 5px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: "#fef3c7", color: "#d97706" }}>오늘</span>
                                </div>
                              )}
                            </div>
                          : <span style={{ color: "#d1d5db" }}>—</span>}
                      </td>
                      {/* 원금액 */}
                      <td style={{ ...tableTd, fontWeight: 700, color: "#0891b2", whiteSpace: "nowrap" }}>
                        {Math.round(gross).toLocaleString()}원
                      </td>
                      {/* 원천세 */}
                      <td style={{ ...tableTd, fontSize: 12, color: "#b45309", whiteSpace: "nowrap" }}>
                        {withholding > 0
                          ? <><div>{Math.round(withholding).toLocaleString()}원</div><div style={{ fontSize: 10, color: "#9ca3af" }}>3.3%</div></>
                          : <span style={{ color: "#d1d5db" }}>—</span>}
                      </td>
                      {/* 실지급액 */}
                      <td style={{ ...tableTd, fontWeight: 700, color: "#059669", whiteSpace: "nowrap" }}>
                        {Math.round(net).toLocaleString()}원
                      </td>
                      {/* 정산 유형 */}
                      <td style={{ ...tableTd, fontSize: 12 }}>
                        {s.settlementType
                          ? <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                              background: s.settlementType === "WITHHOLDING_3_3" ? "#ede9fe" : s.settlementType === "VAT_INVOICE" ? "#dbeafe" : s.settlementType === "OVERSEAS_REMITTANCE" ? "#fef3c7" : "#f3f4f6",
                              color: s.settlementType === "WITHHOLDING_3_3" ? "#7c3aed" : s.settlementType === "VAT_INVOICE" ? "#2563eb" : s.settlementType === "OVERSEAS_REMITTANCE" ? "#b45309" : "#6b7280",
                            }}>{STYPE_KO[s.settlementType] ?? s.settlementType}</span>
                          : <span style={{ color: "#d1d5db" }}>—</span>}
                      </td>
                      {/* 상태 */}
                      <td style={tableTd}>
                        <StatusBadge status={s.status} />
                        {s.status === "pending_review" && s.reviewReason && (
                          <div style={{ fontSize: 10, color: "#b45309", marginTop: 3, maxWidth: 120, lineHeight: 1.3 }} title={s.reviewReason}>
                            {s.reviewReason.length > 30 ? s.reviewReason.slice(0, 30) + "…" : s.reviewReason}
                          </div>
                        )}
                      </td>
                      {/* 액션 */}
                      <td style={{ ...tableTd, minWidth: 180 }}>
                        {s.status === "pending_review" && (
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            <button type="button"
                              onClick={() => runSettlementApprove(s.id)}
                              disabled={approving === s.id}
                              style={{ padding: "4px 10px", fontSize: 12, borderRadius: 6, fontWeight: 600, border: "none", cursor: approving === s.id ? "not-allowed" : "pointer",
                                background: approving === s.id ? "#fde68a" : "#f59e0b", color: "#fff", whiteSpace: "nowrap" }}>
                              {approving === s.id ? "처리 중..." : "✓ 승인"}
                            </button>
                          </div>
                        )}
                        {s.status === "ready" && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {isEditing ? (
                              <input autoFocus value={editingMemo!.value}
                                onChange={e => setEditingMemo({ id: s.id, value: e.target.value })}
                                onKeyDown={e => {
                                  if (e.key === "Enter") runSettlementPay(s.id, editingMemo!.value);
                                  if (e.key === "Escape") setEditingMemo(null);
                                }}
                                placeholder="지급 메모 (Enter 확인)"
                                style={{ ...inputStyle, fontSize: 12, padding: "4px 8px", width: "100%", boxSizing: "border-box" as const }}
                              />
                            ) : (
                              <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                                <button type="button" onClick={() => setEditingMemo({ id: s.id, value: s.paymentMemo ?? "" })} style={{
                                  padding: "4px 8px", fontSize: 11, borderRadius: 6, cursor: "pointer",
                                  background: "#f3f4f6", border: "1px solid #e5e7eb", color: "#374151", whiteSpace: "nowrap" }}>메모</button>
                                <button type="button" onClick={() => runSettlementPay(s.id, s.paymentMemo ?? undefined)} disabled={paying === s.id} style={{
                                  padding: "4px 10px", fontSize: 12, borderRadius: 6, fontWeight: 600, border: "none", whiteSpace: "nowrap",
                                  cursor: paying === s.id ? "not-allowed" : "pointer",
                                  background: paying === s.id ? "#86efac" : "#059669", color: "#fff" }}>
                                  {paying === s.id ? "처리 중..." : "지급 완료"}
                                </button>
                              </div>
                            )}
                            {s.paymentMemo && !isEditing && (
                              <div style={{ fontSize: 11, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }} title={s.paymentMemo}>{s.paymentMemo}</div>
                            )}
                          </div>
                        )}
                        {s.status === "paid" && (
                          <div>
                            <span style={{ color: "#059669", fontSize: 12, fontWeight: 600 }}>✓ 완료</span>
                            {(s.paidAt ?? s.paidDate) && <div style={{ fontSize: 10, color: "#9ca3af" }}>{new Date(s.paidAt ?? s.paidDate!).toLocaleDateString("ko-KR")}</div>}
                            {s.paymentMemo && <div style={{ fontSize: 11, color: "#9ca3af", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.paymentMemo}>{s.paymentMemo}</div>}
                          </div>
                        )}
                        {(s.status === "pending" || s.status === "draft") && (
                          <span style={{ color: "#9ca3af", fontSize: 12 }}>대기 중</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </Section>
  );
}
