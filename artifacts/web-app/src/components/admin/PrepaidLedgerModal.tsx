import React, { useState, useEffect, useCallback } from "react";
import { formatDisplayDate } from '../../lib/dateFormat';
import './readTableView.css';
import { api } from "../../lib/constants";
import { PrimaryBtn, GhostBtn, NumericInput, confirmDialog, alertDialog } from "../ui";
import { DraggableModal } from "./DraggableModal";
import { DateField } from "./DatePickerShared";
import { PrepaidLinkPanel } from "./PrepaidLinkPanel";

interface LedgerEntry {
  id: number;
  accountId: number;
  projectId: number | null;
  projectTitle: string | null;
  type: "deposit" | "deduction" | "adjustment" | "carryover";
  amount: number;
  balanceAfter: number;
  description: string | null;
  transactionDate: string;
  createdAt: string;
  supplyAmount: number | null;
  taxAmount: number | null;
  /** 기존 입금 연결(판매관리 입금완료 청구회차 참조) — 새 현금 입금 아님 */
  linkedPayment?: { paymentId: number; projectId?: number; projectTitle?: string; saleNo?: string | null; sequence?: number; amount?: number; paidDate?: string | null; depositStatus?: string } | null;
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
  // 확정 대기(차감 견적 예약) — 확정 원장·잔액과 분리된 예상값
  pendingInflow?: number;
  pendingDeduction?: number;
  expectedBalance?: number;
  pending?: PendingQuote[];
  linkedAmount?: number;   // 기존 입금 연결 합계(확정) — 신규 입금 누계와 분리
  usedAmount?: number;     // 사용 금액 = 신규 입금 + 기존 입금 연결 − 잔액
}

interface PendingQuote {
  quoteId: number; quoteNumber: string | null; quoteStatus: string | null; quoteTitle: string | null;
  projectId: number | null; projectTitle: string | null;
  inflow: Array<{ id: number; type: string; amount: number; transactionDate: string | null }>;
  deduction: { id: number; amount: number; supplyAmount: number | null; taxAmount: number | null; transactionDate: string | null } | null;
  confirmable: boolean;
}

interface Props {
  accountId: number;
  authHeaders: Record<string, string>;
  onClose: () => void;
  onUpdate: () => void;
  /** 입금·차감 등록(prepaid.manage) — 미전달 시 기존 동작(표시). */
  canManage?: boolean;
  /** 원장 항목 영구삭제(관리자 전용) — 미전달 시 기존 동작(표시). */
  canDelete?: boolean;
  /** 관리자 — 기존 입금 연결 시 검토 사유 입력(일반 판매 배분 입금·과거 사용 이력 불명확) */
  isAdmin?: boolean;
}

const fmt = (n: number) => n.toLocaleString("ko-KR");

export function PrepaidLedgerModal({ accountId, authHeaders, onClose, onUpdate, canManage = true, canDelete = true, isAdmin = false }: Props) {
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

  // 판매확정 차감 견적의 예약 → 확정 반영(직원 명시 실행). 중복 의심이면 한 번 더 확인.
  const [confirmingQuote, setConfirmingQuote] = useState<number | null>(null);
  // 기존 입금 연결 필요(판매관리 입금완료 기록 존재) — 연결 패널 대상
  const [linkTarget, setLinkTarget] = useState<{ pq: PendingQuote; reasons: string[] } | null>(null);
  const handleConfirmQuote = async (pq: PendingQuote) => {
    const inflow = pq.inflow.reduce((s, l) => s + l.amount, 0), ded = pq.deduction?.amount ?? 0;
    const ok = await confirmDialog({
      title: "선입금 확정 반영",
      message: `견적 ${pq.quoteNumber ?? "#" + pq.quoteId}의 예정 내역을 확정 원장에 반영합니다.\n\n입금(선입/이월) +${fmt(inflow)}원 · 차감 -${fmt(ded)}원\n\n실제 입금과 차감이 확정된 경우에만 진행하세요. 반영 후 계정 잔액이 바뀝니다.`,
      confirmLabel: "확정 반영",
    });
    if (!ok) return;
    setConfirmingQuote(pq.quoteId);
    try {
      const post = (allowDuplicate: boolean) => fetch(api(`/api/prepaid/quotes/${pq.quoteId}/confirm`), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ allowDuplicate }),
      });
      let res = await post(false);
      let d = await res.json().catch(() => ({}));
      if (res.status === 409 && d?.code === "LINK_REQUIRED") {
        // 새 입금으로 반영하지 않고 '기존 입금 연결' 경로로 안내(중복 검사 우회 없음)
        setLinkTarget({ pq, reasons: (d.matches ?? []).map((m: any) => m.reason) });
        return;
      }
      if (res.status === 409 && d?.code === "POSSIBLE_DUPLICATE") {
        // 구체적인 중복 사유(선입 원장·다른 견적 예정·판매 청구회차·입금거래·차감) — 기존 기록은 바꾸지 않음
        const list = (d.matches ?? []).map((m: any) => `· ${m.reason ?? `${m.date ?? "-"} ${fmt(Number(m.amount))}원`}`).join("\n");
        const again = await confirmDialog({ title: "중복 의심 — 확정 보류", message: `${d.error}\n\n${list}\n\n서로 다른 돈이 확실한 경우에만 '그래도 반영'을 누르세요.`, confirmLabel: "그래도 반영", cancelLabel: "확정 보류", variant: "danger" });
        if (!again) return;
        res = await post(true); d = await res.json().catch(() => ({}));
      }
      if (!res.ok) { await alertDialog({ title: "확정 반영 실패", message: d?.error ?? `오류 (${res.status})`, variant: "warning" }); return; }
      if (d.already) await alertDialog({ title: "이미 확정됨", message: "이 견적의 예정 내역은 이미 확정되어 있습니다(변경 없음)." });
      await load(); onUpdate();
    } finally { setConfirmingQuote(null); }
  };

  const handleDeleteEntry = async (entryId: number) => {
    if (!(await confirmDialog({ title: "원장 항목 삭제", message: "이 항목을 삭제하면 잔액이 자동 재계산됩니다. 계속하시겠습니까?", confirmLabel: "삭제", variant: "danger" }))) return;
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

  if (loading) return (
    <DraggableModal title="선입금 계정 원장" onClose={onClose} width={780} zIndex={1200}>
      <p style={{ textAlign: "center", color: "#9ca3af", padding: "32px 0" }}>불러오는 중...</p>
    </DraggableModal>
  );
  if (!account) return null;

  const typeLabel: Record<string, string> = { deposit: "입금", carryover: "이월", deduction: "차감", adjustment: "조정" };
  const typeColor = {
    deposit:    { bg: "#dcfce7", color: "#15803d", prefix: "+" },
    carryover:  { bg: "#dcfce7", color: "#15803d", prefix: "+" },
    deduction:  { bg: "#fee2e2", color: "#dc2626", prefix: "-" },
    adjustment: { bg: "#fef3c7", color: "#92400e", prefix: "±" },
  } as const;

  return (
    <DraggableModal title="선입금 계정 원장" subtitle={account.companyName} onClose={onClose} width={780} zIndex={1200} bodyPadding="0" resizable>
        {/* Header */}
        <div style={{ background: "linear-gradient(135deg, #1e40af 0%, #3b82f6 100%)", padding: "20px 28px", color: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.8, marginBottom: 4, letterSpacing: "0.05em" }}>선입금 계정 원장</div>
              <div style={{ fontSize: 22, fontWeight: 800 }}>{account.companyName}</div>
              {account.note && <div style={{ fontSize: 13, opacity: 0.85, marginTop: 4 }}>{account.note}</div>}
            </div>
          </div>
          {/* 잔액 summary */}
          <div style={{ display: "flex", gap: 16, marginTop: 20, flexWrap: "wrap" }}>
            {[
              { label: "신규 입금 누계", value: `${fmt(account.initialAmount)}원`, sub: account.depositDate ? `입금일: ${formatDisplayDate(account.depositDate)}` : "선입금관리에서 받은 입금" },
              ...((account.linkedAmount ?? 0) > 0 ? [{ label: "기존 입금 연결", value: `${fmt(account.linkedAmount ?? 0)}원`, sub: "판매관리 입금완료 기록 참조(새 입금 아님)" }] : []),
              { label: "사용 금액", value: `${fmt(account.usedAmount ?? (account.initialAmount - account.currentBalance))}원`, sub: "누적 차감" },
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
          {canManage && <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
            <PrimaryBtn onClick={() => { setTxType("deduction"); setShowTxForm(true); }} style={{ fontSize: 13, padding: "8px 16px" }}>
              ➖ 차감 추가
            </PrimaryBtn>
            <GhostBtn onClick={() => { setTxType("deposit"); setShowTxForm(true); }} style={{ fontSize: 13, padding: "8px 16px" }}>
              ➕ 추가 입금
            </GhostBtn>
          </div>}

          {/* 거래 추가 폼 */}
          {showTxForm && (
            <div style={{ background: txType === "deduction" ? "#fef2f2" : "#f0fdf4", border: `1px solid ${txType === "deduction" ? "#fca5a5" : "#86efac"}`, borderRadius: 12, padding: 18, marginBottom: 20 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14, color: txType === "deduction" ? "#dc2626" : "#15803d" }}>
                {txType === "deduction" ? "➖ 서비스 차감 입력" : "➕ 추가 입금 입력"}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 }}>금액 (원) *</label>
                  <NumericInput value={txAmount} onChange={raw => setTxAmount(raw)} placeholder="예: 500000" suffix="원"
                    style={{ width: "100%", boxSizing: "border-box", padding: "8px 12px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 14, outline: "none" }} />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 }}>거래 날짜</label>
                  <DateField value={txDate} onChange={v => setTxDate(v)} ariaLabel="거래 날짜"
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

          {/* 확정 대기(차감 견적 예약) — 확정 원장과 분리 표시. 판매확정 견적만 '확정 반영' 가능 */}
          {(account.pending?.length ?? 0) > 0 && (
            <div data-testid="prepaid-pending" style={{ border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 12, padding: "14px 16px", marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#92400e" }}>확정 대기 (예상) — 아직 잔액에 반영되지 않음</div>
                <div data-testid="prepaid-expected" style={{ fontSize: 13, color: "#92400e" }}>
                  예정 입금 +{fmt(account.pendingInflow ?? 0)}원 · 예정 차감 -{fmt(account.pendingDeduction ?? 0)}원 · <b>예상 잔액 {fmt(account.expectedBalance ?? account.currentBalance)}원</b>
                </div>
              </div>
              {account.pending!.map(pq => (
                <div key={pq.quoteId} data-testid={`prepaid-pending-${pq.quoteId}`} style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "8px 0", borderTop: "1px dashed #fcd34d", fontSize: 13 }}>
                  <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: "#111827" }}>{pq.quoteNumber ?? `견적 #${pq.quoteId}`} · {pq.projectTitle ?? pq.quoteTitle ?? "-"}</div>
                    <div style={{ color: "#6b7280", fontSize: 12 }}>
                      {pq.inflow.map(l => `${l.transactionDate ?? "-"} ${typeLabel[l.type] ?? l.type} +${fmt(l.amount)}원`).join(" · ") || "선입/이월 없음"}
                      {pq.deduction ? ` · 차감 -${fmt(pq.deduction.amount)}원(VAT 포함)` : ""}
                    </div>
                  </div>
                  {pq.confirmable
                    ? (canManage && <PrimaryBtn onClick={() => handleConfirmQuote(pq)} disabled={confirmingQuote === pq.quoteId}
                        data-testid={`btn-prepaid-confirm-${pq.quoteId}`} aria-label="선입금 확정 반영" style={{ fontSize: 12, padding: "6px 12px" }}>
                        {confirmingQuote === pq.quoteId ? "반영 중…" : "확정 반영"}
                      </PrimaryBtn>)
                    : <span style={{ fontSize: 12, color: "#92400e" }}>판매전환 시 자동 확정</span>}
                </div>
              ))}
            </div>
          )}

          {linkTarget && (
            <PrepaidLinkPanel quoteId={linkTarget.pq.quoteId} quoteLabel={`견적 ${linkTarget.pq.quoteNumber ?? "#" + linkTarget.pq.quoteId} · ${linkTarget.pq.projectTitle ?? linkTarget.pq.quoteTitle ?? ""}`}
              deduction={linkTarget.pq.deduction?.amount ?? 0} currentBalance={account.currentBalance} authHeaders={authHeaders}
              isAdmin={isAdmin} reasons={linkTarget.reasons}
              onDone={async () => { setLinkTarget(null); await load(); onUpdate(); }} onCancel={() => setLinkTarget(null)} />
          )}

          {/* 원장 테이블 */}
          <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 12 }}>거래 내역 (원장)</div>
          {account.ledger.length === 0 ? (
            <div style={{ textAlign: "center", padding: 32, color: "#9ca3af", fontSize: 14, background: "#f9fafb", borderRadius: 10 }}>거래 내역이 없습니다.</div>
          ) : (
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
              <table className="veritas-read-table" style={{ width: "100%", borderCollapse: "collapse" }}>
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
                    const lp = e.linkedPayment;
                    const desc = (e.projectTitle
                      ? `${e.description ?? ""} #${e.projectId} ${e.projectTitle}`.trim()
                      : (e.description ?? "-"))
                      + (lp ? ` · 연결: 판매 #${lp.projectId ?? "-"}${lp.saleNo ? `(${lp.saleNo})` : ""} ${lp.sequence ?? "-"}회차 · 실제 입금 ${lp.paidDate ?? "-"}` : "");
                    const tdBase: React.CSSProperties = { padding: "10px 14px", borderBottom: "1px solid #f3f4f6", whiteSpace: "nowrap" };
                    return (
                      <tr key={e.id} style={{ background: bgRow }}>
                        <td style={{ ...tdBase, fontSize: 13, color: "#374151" }}>{formatDisplayDate(e.transactionDate)}</td>
                        <td style={{ ...tdBase }}>
                          <span style={{ background: tc.bg, color: tc.color, borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>
                            {e.linkedPayment ? "기존 입금 연결" : (typeLabel[e.type] ?? e.type)}
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
                          {canDelete && <button onClick={() => handleDeleteEntry(e.id)} disabled={deleteId === e.id}
                            style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 12, padding: "2px 6px", borderRadius: 4 }}
                            title="이 항목 삭제">
                            {deleteId === e.id ? "..." : "🗑"}
                          </button>}
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
    </DraggableModal>
  );
}
