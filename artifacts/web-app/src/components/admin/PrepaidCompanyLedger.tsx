// ─── 거래처별 상세 원장(목록형) — 입금 1건 = 1행, 차감 1건 = 1행, 행별 거래 후 잔액 ─────────────────
//  정렬: 확정 거래(거래일·등록순) → 예정 거래(거래일·등록순). 잔액 = 기초 잔액 + 누적
//   → 마지막 확정 행 잔액 = 확정 잔액, 마지막 예정 행 잔액 = 예상 잔액(혼동 방지를 위해 구간·색 분리).
//  기존 기능 통합: 입금/차감 추가 · 판매확정 견적 '확정 반영' · 기존 입금 연결 · 계정 원장(기존 화면).
import React, { useCallback, useEffect, useState } from "react";
import { formatDisplayDate } from "../../lib/dateFormat";
import { api } from "../../lib/constants";
import { PrimaryBtn, GhostBtn, NumericInput, confirmDialog, alertDialog } from "../ui";
import { DateField } from "./DatePickerShared";
import { PrepaidLinkPanel } from "./PrepaidLinkPanel";
import { PrepaidLedgerEntryModal } from "./PrepaidLedgerEntryModal";
import { exportPrepaidCompanyLedger } from "../../lib/prepaidExcel";
import { getJson, won, typeLabelOf, type CompanyLedger, type LedgerRow, type PendingQuote } from "./prepaidLedgerShared";

export function PrepaidCompanyLedger({ companyId, authHeaders, canManage, canDelete, isAdmin, onOpenAccount, onChanged, onToast }: {
  companyId: number; authHeaders: Record<string, string>; canManage: boolean; canDelete: boolean; isAdmin: boolean;
  onOpenAccount: (accountId: number) => void; onChanged: () => void | Promise<void>; onToast?: (msg: string) => void;
}) {
  const [data, setData] = useState<CompanyLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entryId, setEntryId] = useState<number | null>(null);
  const [entryEdit, setEntryEdit] = useState(false);
  const [form, setForm] = useState<null | { type: "deposit" | "deduction"; accountId: number; amount: string; date: string; desc: string; projectId: string }>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [linkTarget, setLinkTarget] = useState<{ pq: PendingQuote; reasons: string[] } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await getJson<CompanyLedger>(`/api/prepaid/companies/${companyId}/ledger`, authHeaders)); }
    catch (e: any) { setError(e?.message ?? "원장 조회 실패"); }
  }, [companyId, authHeaders]);
  useEffect(() => { load(); }, [load]);
  const refreshAll = async () => { await load(); await onChanged(); };

  const activeAccounts = (data?.accounts ?? []).filter(a => a.status === "active");
  const openForm = (type: "deposit" | "deduction") => {
    if (activeAccounts.length === 0) { alertDialog({ title: "활성 계정 없음", message: "이 거래처에 활성 선입금 계정이 없습니다.", variant: "warning" }); return; }
    setForm({ type, accountId: activeAccounts[activeAccounts.length - 1].id, amount: "", date: new Date().toISOString().slice(0, 10), desc: "", projectId: "" });
  };
  const submitForm = async () => {
    if (!form || busy) return;
    const amount = Number(form.amount.replace(/,/g, ""));
    if (!amount || amount <= 0) { await alertDialog({ title: "금액 확인", message: "금액을 입력하세요.", variant: "warning" }); return; }
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/prepaid-accounts/${form.accountId}/transactions`), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ type: form.type, amount, description: form.desc.trim() || undefined, transactionDate: form.date, projectId: form.projectId ? Number(form.projectId) : undefined }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { await alertDialog({ title: "저장 실패", message: d?.error ?? `오류 (${res.status}) — 저장되지 않았습니다.`, variant: "warning" }); return; }
      setForm(null);
      onToast?.(form.type === "deposit" ? "입금을 등록했습니다." : "차감을 등록했습니다.");
      await refreshAll();
    } finally { setBusy(false); }
  };

  // 판매확정 차감 견적 예정 → 확정 반영(기존 PrepaidLedgerModal 과 같은 API·같은 중복 검사)
  const confirmQuote = async (pq: PendingQuote) => {
    const inflow = pq.inflow.reduce((s, l) => s + l.amount, 0), ded = pq.deduction?.amount ?? 0;
    if (!(await confirmDialog({ title: "선입금 확정 반영", confirmLabel: "확정 반영",
      message: `견적 ${pq.quoteNumber ?? "#" + pq.quoteId}의 예정 내역을 확정 원장에 반영합니다.\n\n입금(선입/이월) +${won(inflow)}원 · 차감 -${won(ded)}원\n\n실제 입금과 차감이 확정된 경우에만 진행하세요.` }))) return;
    setConfirming(pq.quoteId);
    try {
      const post = (allowDuplicate: boolean) => fetch(api(`/api/prepaid/quotes/${pq.quoteId}/confirm`), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ allowDuplicate }),
      });
      let res = await post(false); let d = await res.json().catch(() => ({}));
      if (res.status === 409 && d?.code === "LINK_REQUIRED") { setLinkTarget({ pq, reasons: (d.matches ?? []).map((m: any) => m.reason) }); return; }
      if (res.status === 409 && d?.code === "POSSIBLE_DUPLICATE") {
        const list = (d.matches ?? []).map((m: any) => `· ${m.reason ?? `${m.date ?? "-"} ${won(Number(m.amount))}원`}`).join("\n");
        if (!(await confirmDialog({ title: "중복 의심 — 확정 보류", message: `${d.error}\n\n${list}\n\n서로 다른 돈이 확실한 경우에만 '그래도 반영'을 누르세요.`, confirmLabel: "그래도 반영", cancelLabel: "확정 보류", variant: "danger" }))) return;
        res = await post(true); d = await res.json().catch(() => ({}));
      }
      if (!res.ok) { await alertDialog({ title: "확정 반영 실패", message: d?.error ?? `오류 (${res.status})`, variant: "warning" }); return; }
      onToast?.(d.already ? "이미 확정된 견적입니다(변경 없음)." : "확정 원장에 반영했습니다.");
      await refreshAll();
    } finally { setConfirming(null); }
  };

  const exportExcel = () => {
    if (!data) return;
    exportPrepaidCompanyLedger(data.companyName, [
      ...(data.openingBalance !== 0 ? [{ transactionDate: "", typeLabel: "기초 잔액", description: "원장에 기록되지 않은 기초 잔액", quoteNumber: "", saleNo: "", inflow: data.openingBalance > 0 ? data.openingBalance : null, outflow: data.openingBalance < 0 ? -data.openingBalance : null, runningBalance: data.openingBalance, statusLabel: "확정", memo: "" }] : []),
      ...data.ledger.map(r => ({
        transactionDate: r.transactionDate, typeLabel: typeLabelOf(r), description: r.description ?? "", quoteNumber: r.quoteNumber ?? (r.quoteId ? `#${r.quoteId}` : ""),
        saleNo: saleLabel(r), inflow: r.inflow || null, outflow: r.outflow || null, runningBalance: r.runningBalance,
        statusLabel: r.status === "confirmed" ? "확정" : "예정", memo: r.memo ?? "",
      })),
    ]);
  };

  if (error) return <div role="alert" style={{ color: "#b91c1c", fontSize: 12 }}>{error} <GhostBtn onClick={load} style={{ fontSize: 11, padding: "2px 8px" }} aria-label="원장 다시 불러오기" data-testid={`prepaid-ledger-retry-${companyId}`}>다시 시도</GhostBtn></div>;
  if (!data) return <div style={{ fontSize: 12, color: "#94a3b8", padding: 8 }}>원장 불러오는 중…</div>;

  const conf = data.ledger.filter(r => r.status === "confirmed"), res = data.ledger.filter(r => r.status === "reserved");
  const confirmable = data.pending.filter(p => p.confirmable);
  const thS: React.CSSProperties = { padding: "6px 8px", fontSize: 11, fontWeight: 700, color: "#475569", borderBottom: "1px solid #e2e8f0", background: "#f1f5f9", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9", fontSize: 12, verticalAlign: "top" };
  const num: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
  const inp: React.CSSProperties = { padding: "5px 8px", fontSize: 12, border: "1px solid #d1d5db", borderRadius: 6, background: "#fff", boxSizing: "border-box" };

  const row = (r: LedgerRow) => {
    const reserved = r.status === "reserved";
    return (
      <tr key={r.id} data-testid={`ledger-row-${r.id}`} onClick={() => { setEntryEdit(false); setEntryId(r.id); }}
        style={{ cursor: "pointer", background: reserved ? "#fffbeb" : "#fff", color: reserved ? "#78350f" : undefined }}>
        <td style={{ ...td, whiteSpace: "nowrap" }}>{formatDisplayDate(r.transactionDate)}{reserved && isOutDed(r) && <div style={{ fontSize: 10, color: "#b45309" }}>차감일 미확정</div>}</td>
        <td style={{ ...td, whiteSpace: "nowrap" }}>
          <span style={{ fontWeight: 700, color: r.outflow ? "#b91c1c" : "#15803d" }}>{typeLabelOf(r)}</span>
        </td>
        <td style={{ ...td, maxWidth: 280 }}>
          <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.description ?? ""}>{r.description ?? "-"}</div>
          {r.linkedPayment && <div style={{ fontSize: 10.5, color: "#1d4ed8" }}>판매 #{r.linkedPayment.projectId}{r.linkedPayment.saleNo ? `(${r.linkedPayment.saleNo})` : ""} {r.linkedPayment.sequence ?? "-"}회차 · 실제 입금 {r.linkedPayment.paidDate ?? "-"}</div>}
        </td>
        <td style={{ ...td, whiteSpace: "nowrap" }}>{r.quoteNumber ?? (r.quoteId ? `#${r.quoteId}` : <span style={{ color: "#cbd5e1" }}>-</span>)}</td>
        <td style={{ ...td, whiteSpace: "nowrap" }} title={r.projectTitle ?? ""}>{saleLabel(r) || <span style={{ color: "#cbd5e1" }}>-</span>}</td>
        <td style={{ ...num, color: "#15803d", fontWeight: r.inflow ? 700 : 400 }}>{r.inflow ? won(r.inflow) : <span style={{ color: "#cbd5e1" }}>-</span>}</td>
        <td style={{ ...num, color: "#b91c1c", fontWeight: r.outflow ? 700 : 400 }}>{r.outflow ? won(r.outflow) : <span style={{ color: "#cbd5e1" }}>-</span>}</td>
        <td style={{ ...num, fontWeight: 700, color: r.runningBalance < 0 ? "#b91c1c" : reserved ? "#92400e" : "#0f172a", fontStyle: reserved ? "italic" : undefined }}>{won(r.runningBalance)}</td>
        <td style={{ ...td, textAlign: "center", whiteSpace: "nowrap" }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 4, padding: "1px 6px", background: reserved ? "#fef3c7" : "#dcfce7", color: reserved ? "#92400e" : "#15803d" }}>{reserved ? "예정" : "확정"}</span>
        </td>
        <td style={{ ...td, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#475569" }} title={r.memo ?? ""}>{r.memo ?? ""}</td>
        <td style={{ ...td, whiteSpace: "nowrap", textAlign: "center" }} onClick={e => e.stopPropagation()}>
          {canManage && <button type="button" onClick={() => { setEntryEdit(true); setEntryId(r.id); }} data-testid={`ledger-edit-${r.id}`} aria-label={`원장 #${r.id} 수정`}
            style={{ fontSize: 11, padding: "2px 8px", border: "1px solid #cbd5e1", borderRadius: 4, background: "#fff", cursor: "pointer", color: "#1e40af" }}>수정</button>}
        </td>
      </tr>
    );
  };

  return (
    <div data-testid={`company-ledger-${companyId}`}>
      {/* 요약 + 도구 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", fontSize: 12, marginBottom: 6 }}>
        <span>총 입금 <b style={{ color: "#15803d" }}>{won(data.totals.totalDeposit)}</b></span>
        <span>총 차감 <b style={{ color: "#b91c1c" }}>{won(data.totals.totalDeduction)}</b></span>
        <span>확정 잔액 <b data-testid={`ledger-confirmed-${companyId}`}>{won(data.totals.confirmedBalance)}</b></span>
        <span style={{ color: "#92400e" }}>예정 +{won(data.totals.pendingInflow)} / −{won(data.totals.pendingDeduction)} → 예상 잔액 <b data-testid={`ledger-expected-${companyId}`}>{won(data.totals.expectedBalance)}</b></span>
        <div style={{ flex: 1 }} />
        {canManage && <GhostBtn onClick={() => openForm("deposit")} data-testid={`ledger-add-deposit-${companyId}`} aria-label="입금 추가" style={{ fontSize: 11, padding: "4px 10px" }}>+ 입금</GhostBtn>}
        {canManage && <GhostBtn onClick={() => openForm("deduction")} data-testid={`ledger-add-deduction-${companyId}`} aria-label="차감 추가" style={{ fontSize: 11, padding: "4px 10px" }}>+ 차감</GhostBtn>}
        {data.accounts.map(a => (
          <GhostBtn key={a.id} onClick={() => onOpenAccount(a.id)} data-testid={`ledger-open-account-${a.id}`} aria-label={`계정 #${a.id} 기존 원장 화면 열기`} style={{ fontSize: 11, padding: "4px 10px" }}>
            계정 #{a.id}{a.status !== "active" ? "(마감)" : ""} 화면
          </GhostBtn>
        ))}
        <GhostBtn onClick={exportExcel} data-testid={`ledger-excel-${companyId}`} aria-label="거래처 원장 Excel 다운로드" style={{ fontSize: 11, padding: "4px 10px" }}>Excel</GhostBtn>
        <GhostBtn onClick={load} data-testid={`ledger-refresh-${companyId}`} aria-label="원장 새로고침" style={{ fontSize: 11, padding: "4px 10px" }}>↻</GhostBtn>
      </div>

      {form && (
        <div data-testid={`ledger-add-form-${companyId}`} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", background: form.type === "deposit" ? "#f0fdf4" : "#fef2f2", border: "1px solid #e2e8f0", borderRadius: 6, padding: "8px 10px", marginBottom: 8, fontSize: 12 }}>
          <b style={{ color: form.type === "deposit" ? "#15803d" : "#b91c1c", alignSelf: "center" }}>{form.type === "deposit" ? "입금 추가" : "차감 추가"}</b>
          {activeAccounts.length > 1 && (
            <select value={form.accountId} onChange={e => setForm({ ...form, accountId: Number(e.target.value) })} aria-label="계정 선택" data-testid="ledger-add-account" style={inp}>
              {activeAccounts.map(a => <option key={a.id} value={a.id}>계정 #{a.id} (잔액 {won(a.currentBalance)})</option>)}
            </select>
          )}
          <div style={{ width: 140 }}><NumericInput value={form.amount} onChange={v => setForm({ ...form, amount: v })} suffix="원" ariaLabel="금액" testId="ledger-add-amount" style={{ ...inp, width: "100%" }} /></div>
          <div style={{ width: 130 }}><DateField value={form.date} onChange={v => setForm({ ...form, date: v })} ariaLabel="거래일" testid="ledger-add-date" allowClear={false} style={{ ...inp, width: "100%" }} /></div>
          <input value={form.desc} onChange={e => setForm({ ...form, desc: e.target.value })} placeholder="거래 내용" aria-label="거래 내용" data-testid="ledger-add-desc" style={{ ...inp, width: 220 }} />
          {form.type === "deduction" && <input value={form.projectId} onChange={e => setForm({ ...form, projectId: e.target.value.replace(/\D/g, "") })} placeholder="판매 ID(선택)" aria-label="연결 판매 ID" data-testid="ledger-add-project" style={{ ...inp, width: 110 }} />}
          <PrimaryBtn onClick={submitForm} disabled={busy} data-testid="ledger-add-save" aria-label="저장" style={{ fontSize: 12, padding: "5px 12px" }}>{busy ? "저장 중…" : "저장"}</PrimaryBtn>
          <GhostBtn onClick={() => setForm(null)} data-testid="ledger-add-cancel" aria-label="취소" style={{ fontSize: 12, padding: "5px 12px" }}>취소</GhostBtn>
        </div>
      )}

      {confirmable.length > 0 && (
        <div data-testid={`ledger-confirmable-${companyId}`} style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "6px 10px", marginBottom: 8, fontSize: 12, color: "#92400e" }}>
          {confirmable.map(pq => (
            <div key={pq.quoteId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
              <span style={{ flex: 1 }}>판매확정 견적 <b>{pq.quoteNumber ?? `#${pq.quoteId}`}</b> · {pq.projectTitle ?? pq.quoteTitle ?? ""} — 예정 내역이 아직 확정 원장에 반영되지 않았습니다.</span>
              {canManage && <PrimaryBtn onClick={() => confirmQuote(pq)} disabled={confirming === pq.quoteId} data-testid={`btn-prepaid-confirm-${pq.quoteId}`} aria-label="선입금 확정 반영" style={{ fontSize: 11, padding: "3px 10px" }}>
                {confirming === pq.quoteId ? "반영 중…" : "확정 반영"}</PrimaryBtn>}
            </div>
          ))}
        </div>
      )}
      {linkTarget && (
        <PrepaidLinkPanel quoteId={linkTarget.pq.quoteId} quoteLabel={`견적 ${linkTarget.pq.quoteNumber ?? "#" + linkTarget.pq.quoteId} · ${linkTarget.pq.projectTitle ?? linkTarget.pq.quoteTitle ?? ""}`}
          deduction={linkTarget.pq.deduction?.amount ?? 0} currentBalance={data.totals.confirmedBalance} authHeaders={authHeaders}
          isAdmin={isAdmin} reasons={linkTarget.reasons}
          onDone={async () => { setLinkTarget(null); onToast?.("기존 입금을 연결하고 확정했습니다."); await refreshAll(); }} onCancel={() => setLinkTarget(null)} />
      )}

      <div style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: 6, background: "#fff" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["거래일", "구분", "거래 내용", "연결 견적", "연결 판매"].map(h => <th key={h} style={{ ...thS, textAlign: "left" }}>{h}</th>)}
              {["입금액", "차감액", "잔액"].map(h => <th key={h} style={{ ...thS, textAlign: "right" }}>{h}</th>)}
              <th style={{ ...thS, textAlign: "center" }}>상태</th>
              <th style={{ ...thS, textAlign: "left" }}>비고</th>
              <th style={{ ...thS, textAlign: "center" }}>수정</th>
            </tr>
          </thead>
          <tbody>
            {data.openingBalance !== 0 && (
              <tr data-testid={`ledger-opening-${companyId}`} style={{ background: "#f8fafc", color: "#475569" }}>
                <td style={td}>-</td><td style={{ ...td, fontWeight: 700 }}>기초 잔액</td>
                <td style={td} colSpan={3}>계정 잔액 중 원장에 기록되지 않은 금액(이관 등) — 임의로 보정하지 않고 그대로 표시합니다.</td>
                <td style={num}>{data.openingBalance > 0 ? won(data.openingBalance) : ""}</td><td style={num}>{data.openingBalance < 0 ? won(-data.openingBalance) : ""}</td>
                <td style={{ ...num, fontWeight: 700 }}>{won(data.openingBalance)}</td><td style={{ ...td, textAlign: "center" }}>확정</td><td style={td} /><td style={td} />
              </tr>
            )}
            {conf.length === 0 && data.openingBalance === 0 && <tr><td colSpan={11} style={{ ...td, textAlign: "center", color: "#94a3b8" }}>확정 거래가 없습니다.</td></tr>}
            {conf.map(row)}
            <tr style={{ background: "#f0fdf4" }}>
              <td colSpan={7} style={{ ...td, fontWeight: 700, color: "#166534" }}>확정 잔액</td>
              <td style={{ ...num, fontWeight: 800, color: "#166534" }}>{won(data.totals.confirmedBalance)}</td><td colSpan={3} style={td} />
            </tr>
            {res.length > 0 && (
              <>
                <tr><td colSpan={11} style={{ ...td, background: "#fef3c7", color: "#92400e", fontWeight: 700, fontSize: 11 }}>예정 거래 — 확정 잔액에는 반영되지 않음(견적 판매확정·확정 반영 시 반영)</td></tr>
                {res.map(row)}
                <tr style={{ background: "#fffbeb" }}>
                  <td colSpan={7} style={{ ...td, fontWeight: 700, color: "#92400e" }}>예상 잔액</td>
                  <td style={{ ...num, fontWeight: 800, color: "#92400e" }}>{won(data.totals.expectedBalance)}</td><td colSpan={3} style={td} />
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>

      {entryId != null && (
        <PrepaidLedgerEntryModal entryId={entryId} authHeaders={authHeaders} canManage={canManage} canDelete={canDelete} startEditing={entryEdit}
          onClose={() => setEntryId(null)} onSaved={async () => { await refreshAll(); }} onDeleted={async () => { setEntryId(null); await refreshAll(); }} onToast={onToast} />
      )}
    </div>
  );
}

const isOutDed = (r: LedgerRow) => r.type === "deduction";
function saleLabel(r: LedgerRow): string {
  if (r.projectId == null) return "";
  return `#${r.projectId}${r.saleNo ? ` (${r.saleNo})` : ""}`;
}
