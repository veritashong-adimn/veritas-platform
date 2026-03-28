import React, { useState, useEffect, useCallback } from "react";
import { api } from "../../lib/constants";
import { PrimaryBtn, GhostBtn } from "../ui";

interface LedgerEntry {
  id: number;
  accountId: number;
  projectId: number | null;
  projectTitle: string | null;
  type: "deposit" | "deduction" | "adjustment";
  amount: number;
  balanceAfter: number;
  description: string | null;
  transactionDate: string;
  createdAt: string;
  supplyAmount: number | null;
  taxAmount: number | null;
}

interface PrepaidAccount {
  id: number;
  companyId: number;
  companyName: string;
  initialAmount: number;
  currentBalance: number;
  status: string;
  note: string | null;
  depositDate: string | null;
  createdAt: string;
  ledger: LedgerEntry[];
}

interface Props {
  accountId: number;
  authHeaders: Record<string, string>;
  onClose: () => void;
  onUpdate: () => void;
}

const fmt = (n: number) => n.toLocaleString("ko-KR");

export function PrepaidLedgerModal({ accountId, authHeaders, onClose, onUpdate }: Props) {
  const [account, setAccount] = useState<PrepaidAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [showTxForm, setShowTxForm] = useState(false);
  const [txType, setTxType] = useState<"deduction" | "deposit">("deduction");
  const [txAmount, setTxAmount] = useState("");
  const [txDesc, setTxDesc] = useState("");
  const [txDate, setTxDate] = useState(new Date().toISOString().slice(0, 10));
  const [txProjectId, setTxProjectId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api(`/api/admin/prepaid-accounts/${accountId}`), { headers: authHeaders });
      if (res.ok) setAccount(await res.json());
    } finally {
      setLoading(false);
    }
  }, [accountId, authHeaders]);

  useEffect(() => { load(); }, [load]);

  const handleAddTx = async () => {
    const amount = Number(txAmount.replace(/,/g, ""));
    if (!amount || amount <= 0) return;
    setSubmitting(true);
    try {
      const res = await fetch(api(`/api/admin/prepaid-accounts/${accountId}/transactions`), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: txType,
          amount,
          description: txDesc || undefined,
          projectId: txProjectId ? Number(txProjectId) : undefined,
          transactionDate: txDate,
        }),
      });
      if (res.ok) {
        setShowTxForm(false);
        setTxAmount("");
        setTxDesc("");
        setTxProjectId("");
        await load();
        onUpdate();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteEntry = async (entryId: number) => {
    if (!confirm("이 항목을 삭제하면 잔액이 자동 재계산됩니다. 계속하시겠습니까?")) return;
    setDeleteId(entryId);
    try {
      const res = await fetch(api(`/api/admin/prepaid-ledger/${entryId}`), {
        method: "DELETE", headers: authHeaders,
      });
      if (res.ok) { await load(); onUpdate(); }
    } finally {
      setDeleteId(null);
    }
  };

  const overlay: React.CSSProperties = {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1200, padding: 16,
  };
  const modal: React.CSSProperties = {
    background: "#fff", borderRadius: 16, width: "100%", maxWidth: 780,
    maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
  };

  if (loading) return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...modal, padding: 40, textAlign: "center", color: "#9ca3af" }}>불러오는 중...</div>
    </div>
  );
  if (!account) return null;

  const typeLabel = { deposit: "입금", deduction: "차감", adjustment: "조정" };
  const typeColor = {
    deposit:    { bg: "#dcfce7", color: "#15803d", prefix: "+" },
    deduction:  { bg: "#fee2e2", color: "#dc2626", prefix: "-" },
    adjustment: { bg: "#fef3c7", color: "#92400e", prefix: "±" },
  } as const;

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>
        {/* Header */}
        <div style={{ background: "linear-gradient(135deg, #1e40af 0%, #3b82f6 100%)", borderRadius: "16px 16px 0 0", padding: "24px 28px", color: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.8, marginBottom: 4, letterSpacing: "0.05em" }}>선입금 계정 원장</div>
              <div style={{ fontSize: 22, fontWeight: 800 }}>{account.companyName}</div>
              {account.note && <div style={{ fontSize: 13, opacity: 0.85, marginTop: 4 }}>{account.note}</div>}
            </div>
            <button onClick={onClose} style={{ background: "rgba(255,255,255,0.2)", border: "none", borderRadius: 8, color: "#fff", cursor: "pointer", padding: "8px 14px", fontSize: 13, fontWeight: 600 }}>닫기</button>
          </div>
          {/* 잔액 summary */}
          <div style={{ display: "flex", gap: 16, marginTop: 20, flexWrap: "wrap" }}>
            {[
              { label: "최초 입금액", value: `${fmt(account.initialAmount)}원`, sub: account.depositDate ? `입금일: ${account.depositDate}` : undefined },
              { label: "사용 금액", value: `${fmt(account.initialAmount - account.currentBalance)}원`, sub: "누적 차감" },
              { label: "현재 잔액", value: `${fmt(account.currentBalance)}원`, highlight: true },
            ].map(s => (
              <div key={s.label} style={{ background: s.highlight ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.12)", borderRadius: 10, padding: "12px 20px", flex: "1 1 140px", backdropFilter: "blur(8px)", border: s.highlight ? "1px solid rgba(255,255,255,0.4)" : "none" }}>
                <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 4, fontWeight: 600 }}>{s.label}</div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>{s.value}</div>
                {s.sub && <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>{s.sub}</div>}
              </div>
            ))}
          </div>
        </div>

        <div style={{ padding: 24 }}>
          {/* 거래 추가 버튼 */}
          <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
            <PrimaryBtn onClick={() => { setTxType("deduction"); setShowTxForm(true); }} style={{ fontSize: 13, padding: "8px 16px" }}>
              ➖ 차감 추가
            </PrimaryBtn>
            <GhostBtn onClick={() => { setTxType("deposit"); setShowTxForm(true); }} style={{ fontSize: 13, padding: "8px 16px" }}>
              ➕ 추가 입금
            </GhostBtn>
          </div>

          {/* 거래 추가 폼 */}
          {showTxForm && (
            <div style={{ background: txType === "deduction" ? "#fef2f2" : "#f0fdf4", border: `1px solid ${txType === "deduction" ? "#fca5a5" : "#86efac"}`, borderRadius: 12, padding: 18, marginBottom: 20 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14, color: txType === "deduction" ? "#dc2626" : "#15803d" }}>
                {txType === "deduction" ? "➖ 서비스 차감 입력" : "➕ 추가 입금 입력"}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 }}>금액 (원) *</label>
                  <input value={txAmount} onChange={e => setTxAmount(e.target.value)} placeholder="예: 500000"
                    style={{ width: "100%", boxSizing: "border-box", padding: "8px 12px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 14, outline: "none" }} />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 }}>거래 날짜</label>
                  <input type="date" value={txDate} onChange={e => setTxDate(e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box", padding: "8px 12px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 14, outline: "none" }} />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 }}>내용 / 서비스 내역</label>
                  <input value={txDesc} onChange={e => setTxDesc(e.target.value)} placeholder="예: 계약서 번역 (영→한)"
                    style={{ width: "100%", boxSizing: "border-box", padding: "8px 12px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 14, outline: "none" }} />
                </div>
                {txType === "deduction" && (
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 }}>연결 프로젝트 ID (선택)</label>
                    <input value={txProjectId} onChange={e => setTxProjectId(e.target.value)} placeholder="프로젝트 번호"
                      style={{ width: "100%", boxSizing: "border-box", padding: "8px 12px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 14, outline: "none" }} />
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <PrimaryBtn onClick={handleAddTx} disabled={submitting} style={{ fontSize: 13, padding: "8px 18px", background: txType === "deduction" ? "#dc2626" : "#15803d" }}>
                  {submitting ? "처리 중..." : "저장"}
                </PrimaryBtn>
                <GhostBtn onClick={() => setShowTxForm(false)} style={{ fontSize: 13 }}>취소</GhostBtn>
              </div>
            </div>
          )}

          {/* 원장 테이블 */}
          <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 12 }}>거래 내역 (원장)</div>
          {account.ledger.length === 0 ? (
            <div style={{ textAlign: "center", padding: 32, color: "#9ca3af", fontSize: 14, background: "#f9fafb", borderRadius: 10 }}>거래 내역이 없습니다.</div>
          ) : (
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    {[
                      { h: "날짜", align: "left" as const },
                      { h: "구분", align: "left" as const },
                      { h: "내용 / 프로젝트", align: "left" as const },
                      { h: "공급가", align: "right" as const },
                      { h: "부가세", align: "right" as const },
                      { h: "합계", align: "right" as const },
                      { h: "잔액", align: "right" as const },
                      { h: "", align: "left" as const },
                    ].map(({ h, align }) => (
                      <th key={h} style={{ padding: "10px 14px", textAlign: align, fontSize: 11, fontWeight: 700, color: "#6b7280", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {account.ledger.map((e, idx) => {
                    const tc = typeColor[e.type] ?? typeColor.adjustment;
                    const isDeduct = e.type === "deduction";
                    const bgRow = isDeduct ? (idx % 2 === 0 ? "#fdf4ff" : "#f5f0ff") : (idx % 2 === 0 ? "#fff" : "#f9fafb");
                    const desc = e.projectTitle
                      ? `${e.description ?? ""} #${e.projectId} ${e.projectTitle}`.trim()
                      : (e.description ?? "-");
                    const tdBase: React.CSSProperties = { padding: "10px 14px", borderBottom: "1px solid #f3f4f6", whiteSpace: "nowrap" };
                    return (
                      <tr key={e.id} style={{ background: bgRow }}>
                        <td style={{ ...tdBase, fontSize: 13, color: "#374151" }}>{e.transactionDate}</td>
                        <td style={{ ...tdBase }}>
                          <span style={{ background: tc.bg, color: tc.color, borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>
                            {typeLabel[e.type] ?? e.type}
                          </span>
                        </td>
                        <td style={{ ...tdBase, fontSize: 12, color: "#374151", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{desc}</td>
                        {/* 공급가 */}
                        <td style={{ ...tdBase, textAlign: "right", fontSize: 13, color: "#374151" }}>
                          {isDeduct && e.supplyAmount != null ? `${fmt(e.supplyAmount)}원` : <span style={{ color: "#d1d5db" }}>-</span>}
                        </td>
                        {/* 부가세 */}
                        <td style={{ ...tdBase, textAlign: "right", fontSize: 13, color: isDeduct && e.taxAmount != null && e.taxAmount > 0 ? "#7c3aed" : "#374151" }}>
                          {isDeduct && e.taxAmount != null ? `${fmt(e.taxAmount)}원` : <span style={{ color: "#d1d5db" }}>-</span>}
                        </td>
                        {/* 합계 */}
                        <td style={{ ...tdBase, textAlign: "right", fontWeight: 800, fontSize: 15, color: tc.color }}>
                          {tc.prefix}{fmt(e.amount)}원
                        </td>
                        {/* 잔액 */}
                        <td style={{ ...tdBase, textAlign: "right", fontWeight: 800, fontSize: 15, color: e.balanceAfter > 0 ? "#15803d" : e.balanceAfter === 0 ? "#6b7280" : "#dc2626" }}>
                          {fmt(e.balanceAfter)}원
                        </td>
                        <td style={{ ...tdBase }}>
                          <button onClick={() => handleDeleteEntry(e.id)} disabled={deleteId === e.id}
                            style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 12, padding: "2px 6px", borderRadius: 4 }}
                            title="이 항목 삭제">
                            {deleteId === e.id ? "..." : "🗑"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {/* 합계 행 */}
                  <tr style={{ background: "#f0f9ff", borderTop: "2px solid #bfdbfe" }}>
                    <td colSpan={3} style={{ padding: "12px 14px", fontWeight: 700, fontSize: 13, color: "#1e40af" }}>최종 잔액</td>
                    <td style={{ padding: "12px 14px" }} />
                    <td style={{ padding: "12px 14px" }} />
                    <td style={{ padding: "12px 14px" }} />
                    <td style={{ padding: "12px 14px", textAlign: "right", fontWeight: 900, fontSize: 18, color: account.currentBalance > 0 ? "#15803d" : "#dc2626" }}>
                      {fmt(account.currentBalance)}원
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
