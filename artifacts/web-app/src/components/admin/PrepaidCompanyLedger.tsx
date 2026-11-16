// ─── 거래처 선입금 원장 — 하나의 표: 거래일 | 구분 | 입금액 | 차감액 | 잔액 | 관리 ─────────────────
//  입금 1건 = 1행, 차감 1건 = 1행. 거래일·등록 순서로 누적 잔액(잔액 = 누적 입금 − 누적 차감).
//  행을 누르면 상세(거래 내용·연결 견적/판매·변경 이력)를 볼 수 있다. 현재 잔액은 표 아래 한 번만.
import React, { useCallback, useEffect, useState } from "react";
import { formatDisplayDate } from "../../lib/dateFormat";
import { api } from "../../lib/constants";
import { PrimaryBtn, GhostBtn, NumericInput, alertDialog } from "../ui";
import { DateField } from "./DatePickerShared";
import { PrepaidLedgerEntryModal } from "./PrepaidLedgerEntryModal";
import { getJson, won, type CompanyLedger } from "./prepaidLedgerShared";

export function PrepaidCompanyLedger({ companyId, authHeaders, canManage, canDelete, onChanged, onToast }: {
  companyId: number; authHeaders: Record<string, string>; canManage: boolean; canDelete: boolean;
  onChanged?: () => void | Promise<void>; onToast?: (msg: string) => void;
}) {
  const [data, setData] = useState<CompanyLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entry, setEntry] = useState<{ id: number; edit: boolean } | null>(null);
  const [form, setForm] = useState<null | { type: "deposit" | "deduction"; amount: string; date: string; desc: string }>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await getJson<CompanyLedger>(`/api/prepaid/companies/${companyId}/ledger`, authHeaders)); }
    catch (e: any) { setError(e?.message ?? "원장 조회 실패"); }
  }, [companyId, authHeaders]);
  useEffect(() => { load(); }, [load]);
  const refreshAll = async () => { await load(); await onChanged?.(); };

  const account = (data?.accounts ?? []).filter(a => a.status === "active").slice(-1)[0] ?? null;
  const submit = async () => {
    if (!form || busy || !account) return;
    const amount = Number(form.amount.replace(/,/g, ""));
    if (!amount || amount <= 0) { await alertDialog({ title: "금액 확인", message: "금액을 입력하세요.", variant: "warning" }); return; }
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/prepaid-accounts/${account.id}/transactions`), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ type: form.type, amount, description: form.desc.trim() || undefined, transactionDate: form.date }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { await alertDialog({ title: "저장 실패", message: d?.error ?? `오류 (${res.status}) — 저장되지 않았습니다.`, variant: "warning" }); return; }
      setForm(null);
      onToast?.(form.type === "deposit" ? "입금을 등록했습니다." : "차감을 등록했습니다.");
      await refreshAll();
    } finally { setBusy(false); }
  };

  if (error) return <div role="alert" style={{ color: "#b91c1c", fontSize: 12 }}>{error} <GhostBtn onClick={load} style={{ fontSize: 11, padding: "2px 8px" }} aria-label="원장 다시 불러오기" data-testid={`prepaid-ledger-retry-${companyId}`}>다시 시도</GhostBtn></div>;
  if (!data) return <div style={{ fontSize: 12, color: "#94a3b8", padding: 6 }}>불러오는 중…</div>;

  const th: React.CSSProperties = { padding: "5px 8px", fontSize: 11.5, fontWeight: 700, color: "#475569", borderBottom: "1px solid #e2e8f0", background: "#f8fafc", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "5px 8px", borderBottom: "1px solid #f1f5f9", fontSize: 12.5, whiteSpace: "nowrap" };
  const num: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const inp: React.CSSProperties = { padding: "4px 8px", fontSize: 12, border: "1px solid #d1d5db", borderRadius: 6, background: "#fff", boxSizing: "border-box" };
  const dash = <span style={{ color: "#cbd5e1" }}>-</span>;

  return (
    <div data-testid={`company-ledger-${companyId}`} style={{ maxWidth: 760 }}>
      <div style={{ border: "1px solid #e2e8f0", borderRadius: 6, background: "#fff", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left" }}>거래일</th>
              <th style={{ ...th, textAlign: "left" }}>구분</th>
              <th style={{ ...th, textAlign: "right" }}>입금액</th>
              <th style={{ ...th, textAlign: "right" }}>차감액</th>
              <th style={{ ...th, textAlign: "right" }}>잔액</th>
              <th style={{ ...th, textAlign: "center", width: 56 }}>관리</th>
            </tr>
          </thead>
          <tbody>
            {data.openingBalance !== 0 && (
              <tr data-testid={`ledger-opening-${companyId}`} title="이관 등으로 원장 행 없이 계정에 있던 잔액">
                <td style={td}>미입력</td><td style={td}>기초 잔액</td>
                <td style={num}>{data.openingBalance > 0 ? won(data.openingBalance) : dash}</td>
                <td style={num}>{data.openingBalance < 0 ? won(-data.openingBalance) : dash}</td>
                <td style={num}>{won(data.openingBalance)}</td><td style={td} />
              </tr>
            )}
            {data.ledger.length === 0 && data.openingBalance === 0 && <tr><td colSpan={6} style={{ ...td, textAlign: "center", color: "#94a3b8" }}>거래가 없습니다.</td></tr>}
            {data.ledger.map(r => (
              <tr key={r.id} data-testid={`ledger-row-${r.id}`} onClick={() => setEntry({ id: r.id, edit: false })} style={{ cursor: "pointer" }} title={r.description ?? ""}>
                <td style={td}>{r.transactionDate ? formatDisplayDate(r.transactionDate) : "미입력"}</td>
                <td style={td}>{r.label}</td>
                <td style={num}>{r.inflow ? won(r.inflow) : dash}</td>
                <td style={num}>{r.outflow ? won(r.outflow) : dash}</td>
                <td style={{ ...num, color: r.balance < 0 ? "#b91c1c" : undefined }}>{won(r.balance)}</td>
                <td style={{ ...td, textAlign: "center" }} onClick={e => e.stopPropagation()}>
                  {canManage && <button type="button" onClick={() => setEntry({ id: r.id, edit: true })} data-testid={`ledger-edit-${r.id}`} aria-label={`원장 #${r.id} 수정`}
                    style={{ fontSize: 11, padding: "1px 8px", border: "1px solid #cbd5e1", borderRadius: 4, background: "#fff", cursor: "pointer", color: "#1e40af" }}>수정</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
        {canManage && account && !form && <>
          <GhostBtn onClick={() => setForm({ type: "deposit", amount: "", date: new Date().toISOString().slice(0, 10), desc: "" })} data-testid={`ledger-add-deposit-${companyId}`} aria-label="입금 추가" style={{ fontSize: 11, padding: "3px 10px" }}>+ 입금</GhostBtn>
          <GhostBtn onClick={() => setForm({ type: "deduction", amount: "", date: new Date().toISOString().slice(0, 10), desc: "" })} data-testid={`ledger-add-deduction-${companyId}`} aria-label="차감 추가" style={{ fontSize: 11, padding: "3px 10px" }}>+ 차감</GhostBtn>
        </>}
        {form && (
          <div data-testid={`ledger-add-form-${companyId}`} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 12 }}>
            <b>{form.type === "deposit" ? "입금" : "차감"}</b>
            <div style={{ width: 130 }}><DateField value={form.date} onChange={v => setForm({ ...form, date: v })} ariaLabel="거래일" testid="ledger-add-date" allowClear={false} style={{ ...inp, width: "100%" }} /></div>
            <div style={{ width: 130 }}><NumericInput value={form.amount} onChange={v => setForm({ ...form, amount: v })} suffix="원" ariaLabel="금액" testId="ledger-add-amount" style={{ ...inp, width: "100%" }} /></div>
            <input value={form.desc} onChange={e => setForm({ ...form, desc: e.target.value })} placeholder="내용(선택)" aria-label="거래 내용" data-testid="ledger-add-desc" style={{ ...inp, width: 180 }} />
            <PrimaryBtn onClick={submit} disabled={busy} data-testid="ledger-add-save" aria-label="저장" style={{ fontSize: 12, padding: "4px 12px" }}>{busy ? "저장 중…" : "저장"}</PrimaryBtn>
            <GhostBtn onClick={() => setForm(null)} data-testid="ledger-add-cancel" aria-label="취소" style={{ fontSize: 12, padding: "4px 10px" }}>취소</GhostBtn>
          </div>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 13 }}>현재 잔액: <b data-testid={`ledger-balance-${companyId}`}>{won(data.totals.balance)}원</b></span>
      </div>

      {entry && (
        <PrepaidLedgerEntryModal entryId={entry.id} authHeaders={authHeaders} canManage={canManage} canDelete={canDelete} startEditing={entry.edit}
          onClose={() => setEntry(null)} onSaved={refreshAll} onDeleted={async () => { setEntry(null); await refreshAll(); }} onToast={onToast} />
      )}
    </div>
  );
}
