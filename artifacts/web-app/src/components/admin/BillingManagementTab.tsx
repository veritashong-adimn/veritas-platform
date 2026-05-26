import React, { useState, useCallback, useEffect } from 'react';
import { api } from '../../lib/constants';
import { Card, GhostBtn } from '../ui';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>{title}</h2>
      </div>
      {children}
    </div>
  );
}

const tableTh: React.CSSProperties = {
  padding: "10px 12px", textAlign: "left", fontSize: 12,
  fontWeight: 600, color: "#6b7280", background: "#f9fafb",
  borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap",
};
const tableTd: React.CSSProperties = {
  padding: "9px 12px", fontSize: 13, color: "#374151",
  borderBottom: "1px solid #edf0f3", verticalAlign: "middle",
};

type BillingBatch = {
  id: number; companyId: number; companyName: string | null;
  periodStart: string | null; periodEnd: string | null;
  status: string; totalAmount: number;
  quoteId: number | null; quoteStatus: string | null;
  itemCount: number; createdAt: string;
};

const STATUS_COLOR: Record<string, { bg: string; color: string; label: string }> = {
  draft:    { bg: "#f3f4f6", color: "#374151", label: "초안" },
  sent:     { bg: "#eff6ff", color: "#1d4ed8", label: "발송" },
  approved: { bg: "#fef3c7", color: "#92400e", label: "승인" },
  paid:     { bg: "#dcfce7", color: "#15803d", label: "완료" },
};

interface Props {
  token: string;
  onToast: (msg: string) => void;
  onNavigateToProjects: () => void;
}

export function BillingManagementTab({ token, onToast, onNavigateToProjects }: Props) {
  const authHeaders = { Authorization: `Bearer ${token}` };

  const [billingBatches, setBillingBatches] = useState<BillingBatch[]>([]);
  const [billingBatchesLoading, setBillingBatchesLoading] = useState(false);
  const [billingBatchStatusFilter, setBillingBatchStatusFilter] = useState<string>("all");

  const fetchBillingBatches = useCallback(async () => {
    setBillingBatchesLoading(true);
    try {
      const params = new URLSearchParams();
      if (billingBatchStatusFilter !== "all") params.set("status", billingBatchStatusFilter);
      const res = await fetch(api(`/api/admin/billing-batches${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setBillingBatches(Array.isArray(data) ? data : []);
    } catch { onToast("오류: 누적 청구 조회 실패"); }
    finally { setBillingBatchesLoading(false); }
  }, [token, billingBatchStatusFilter]);

  useEffect(() => { fetchBillingBatches(); }, [fetchBillingBatches]);

  return (
    <Section title="누적 청구 관리">
      {/* 상태 필터 */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
        {[
          { id: "all", label: "전체" },
          { id: "draft", label: "초안" },
          { id: "sent", label: "발송" },
          { id: "approved", label: "승인" },
          { id: "paid", label: "완료" },
        ].map(f => (
          <button key={f.id} onClick={() => setBillingBatchStatusFilter(f.id)}
            style={{ padding: "6px 14px", borderRadius: 16, border: "1px solid", cursor: "pointer", fontSize: 12, fontWeight: 500,
              background: billingBatchStatusFilter === f.id ? "#2563eb" : "#fff",
              borderColor: billingBatchStatusFilter === f.id ? "#2563eb" : "#d1d5db",
              color: billingBatchStatusFilter === f.id ? "#fff" : "#374151" }}>
            {f.label}
          </button>
        ))}
        <GhostBtn onClick={fetchBillingBatches} style={{ padding: "6px 14px", fontSize: 12, marginLeft: "auto" }}>새로고침</GhostBtn>
      </div>

      {billingBatchesLoading ? (
        <div style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
      ) : billingBatches.length === 0 ? (
        <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>
          누적 청구 내역이 없습니다.
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["ID","거래처","청구 기간","건수","합계금액","배치상태","견적상태","생성일"].map(h => (
                    <th key={h} style={tableTh}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {billingBatches.map(b => {
                  const sc = STATUS_COLOR[b.status] ?? { bg: "#f3f4f6", color: "#374151", label: b.status };
                  const qsc = b.quoteStatus ? (STATUS_COLOR[b.quoteStatus] ?? { bg: "#f3f4f6", color: "#374151", label: b.quoteStatus }) : null;
                  return (
                    <tr key={b.id}
                      onClick={onNavigateToProjects}
                      style={{ cursor: "pointer" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                      <td style={{ ...tableTd, color: "#9ca3af" }}>#{b.id}</td>
                      <td style={{ ...tableTd, fontWeight: 700, color: "#2563eb" }}>{b.companyName ?? "-"}</td>
                      <td style={{ ...tableTd, fontSize: 12 }}>
                        {b.periodStart ? new Date(b.periodStart).toLocaleDateString("ko-KR") : "?"} ~{" "}
                        {b.periodEnd ? new Date(b.periodEnd).toLocaleDateString("ko-KR") : "?"}
                      </td>
                      <td style={{ ...tableTd, textAlign: "right" }}>{b.itemCount}건</td>
                      <td style={{ ...tableTd, fontWeight: 700, textAlign: "right" }}>{b.totalAmount.toLocaleString()}원</td>
                      <td style={tableTd}>
                        <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: sc.bg, color: sc.color }}>{sc.label}</span>
                      </td>
                      <td style={tableTd}>
                        {qsc ? (
                          <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: qsc.bg, color: qsc.color }}>{qsc.label}</span>
                        ) : <span style={{ color: "#d1d5db", fontSize: 11 }}>미발행</span>}
                      </td>
                      <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af" }}>
                        {new Date(b.createdAt).toLocaleDateString("ko-KR")}
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
