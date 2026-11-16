// ─── 선입금 원장 행 — 상세 · 수정 · 수정 이력 ─────────────────────────────────────────────
//  저장 흐름: 입력 → 변경 필드만 PATCH(불러온 값 base 동봉 — 동시 수정 감지) → 서버 검증·한 트랜잭션 저장
//   → 응답 성공일 때만 '저장됨' 표시 → 상세·이력·원장·목록을 서버에서 다시 조회(화면 = DB 값).
//  다른 확정 거래·판매확정 견적에 영향이 있으면 서버가 영향 범위를 돌려주고, 확인 후에만 저장한다.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { formatDisplayDate } from "../../lib/dateFormat";
import { api } from "../../lib/constants";
import { PrimaryBtn, GhostBtn, NumericInput, confirmDialog, alertDialog, promptDialog } from "../ui";
import { DraggableModal } from "./DraggableModal";
import { DateField } from "./DatePickerShared";
import { getJson, won, TYPE_LABEL, isOutflowType, parseQuoteLineDesc, composeQuoteLineDesc } from "./prepaidLedgerShared";

type Snapshot = {
  id: number; accountId: number; projectId: number | null; quoteId: number | null; type: string; status: string; amount: number;
  supplyAmount: number | null; taxAmount: number | null; description: string | null; memo: string | null; transactionDate: string;
  linkedPaymentId: number | null; balanceBefore: number | null; balanceAfter: number | null;
};
type FieldRule = { editable: boolean; reason?: string };
type Detail = {
  entry: Snapshot & { createdAt: string; createdBy: number | null; confirmedAt: string | null };
  companyId: number | null; companyName: string | null; accountStatus: string | null;
  projectTitle: string | null; saleNo: string | null; serviceNames: string | null;
  quote: { id: number; quoteNumber: string | null; quoteType: string; status: string; title: string | null; projectId: number | null } | null;
  linkedPayment: { paymentId: number; projectId: number; projectTitle: string; saleNo: string | null; sequence: number; amount: number; paidDate: string | null } | null;
  createdByName: string | null; confirmedByName: string | null; modifiedAt: string | null; modifiedByName: string | null;
  label: string;
  rules: { editable: boolean; quoteManaged: boolean; notice: string | null; fields: Record<string, FieldRule> };
};
type Candidate = { paymentId: number; projectId: number; projectTitle: string | null; saleNo: string | null; sequence: number | null; amount: number; paidDate: string | null; linkedRow: number | null };
type History = { id: number; ledgerId: number; related: boolean; action: string; before: any; after: any; reason: string | null; changedAt: string; changedByName: string | null };
type Form = { transactionDate: string; type: string; amount: string; supplyAmount: string; taxAmount: string; description: string; sourceRef: string; lineNote: string; memo: string; quoteId: string; projectId: string; linkedPaymentId: string };

const FIELD_LABEL: Record<string, string> = {
  transactionDate: "거래일", type: "구분", amount: "금액", supplyAmount: "공급가", taxAmount: "부가세", description: "거래 내용", memo: "비고",
  quoteId: "연결 견적", projectId: "연결 판매", linkedPaymentId: "기존 입금 연결",
};
const ACTION_LABEL: Record<string, string> = { create: "등록", update: "수정", quote_sync: "견적 연동 재계산", delete: "삭제", link: "기존 입금 연결", confirm: "확정" };
const fmtVal = (k: string, v: any) => v == null || v === "" ? "(없음)" : ["amount", "supplyAmount", "taxAmount", "balanceBefore", "balanceAfter"].includes(k) ? `${won(Number(v))}원`
  : k === "type" ? (TYPE_LABEL[v] ?? v) : k === "linkedPaymentId" ? `청구회차 #${v}` : k === "transactionDate" ? formatDisplayDate(String(v)) : String(v);
const fmtTs = (s: string | null) => (s ? new Date(s).toLocaleString("ko-KR", { hour12: false }) : "-");
const toNum = (s: string) => (s.trim() === "" ? null : Number(s.replace(/,/g, "")));

export function PrepaidLedgerEntryModal({ entryId, authHeaders, canManage, canDelete, startEditing, onClose, onSaved, onDeleted, onToast }: {
  entryId: number; authHeaders: Record<string, string>; canManage: boolean; canDelete: boolean; startEditing?: boolean;
  onClose: () => void; onSaved: () => void | Promise<void>; onDeleted: () => void | Promise<void>; onToast?: (m: string) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!!startEditing);
  const [form, setForm] = useState<Form | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [cands, setCands] = useState<Candidate[]>([]);
  useEffect(() => {
    if (!editing) return;
    getJson<Candidate[]>(`/api/prepaid/ledger/${entryId}/link-candidates`, authHeaders).then(setCands).catch(() => setCands([]));
  }, [editing, entryId, authHeaders]);

  const toForm = (d: Detail): Form => {
    const p = parseQuoteLineDesc(d.entry.description);
    return {
      transactionDate: d.entry.transactionDate, type: d.entry.type, amount: String(d.entry.amount),
      supplyAmount: d.entry.supplyAmount != null ? String(d.entry.supplyAmount) : "", taxAmount: d.entry.taxAmount != null ? String(d.entry.taxAmount) : "",
      description: d.entry.description ?? "", sourceRef: p.sourceRef, lineNote: p.note, memo: d.entry.memo ?? "",
      quoteId: d.entry.quoteId != null ? String(d.entry.quoteId) : "", projectId: d.entry.projectId != null ? String(d.entry.projectId) : "",
      linkedPaymentId: d.entry.linkedPaymentId != null ? String(d.entry.linkedPaymentId) : "",
    };
  };
  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, h] = await Promise.all([
        getJson<Detail>(`/api/prepaid/ledger/${entryId}`, authHeaders),
        getJson<History[]>(`/api/prepaid/ledger/${entryId}/history`, authHeaders),
      ]);
      setDetail(d); setHistory(h); setForm(toForm(d));
      return d;
    } catch (e: any) { setError(e?.message ?? "조회 실패"); return null; }
  }, [entryId, authHeaders]);
  useEffect(() => { load(); }, [load]);

  const e = detail?.entry;
  const rules = detail?.rules;
  const f = (k: string) => !!rules?.fields[k]?.editable && canManage;
  const isDed = e ? isOutflowType(e.type) : false;
  const quoteInflow = !!rules?.quoteManaged && !isDed;

  // 변경된 필드만 서버로 보낸다(서버는 보낸 필드 전부를 검증한 뒤 한 번에 저장 — 일부만 저장되는 일 없음)
  const changes = useMemo(() => {
    if (!e || !form) return {} as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (form.transactionDate !== e.transactionDate) out.transactionDate = form.transactionDate;
    if (form.type !== e.type) out.type = form.type;
    const amt = toNum(form.amount); if (amt !== e.amount) out.amount = amt;
    if (isDed) {
      const s = toNum(form.supplyAmount), t = toNum(form.taxAmount);
      if (s !== e.supplyAmount) out.supplyAmount = s;
      if (t !== e.taxAmount) out.taxAmount = t;
    }
    const desc = quoteInflow ? composeQuoteLineDesc(form.type, parseQuoteLineDesc(e.description).label, form.sourceRef, form.lineNote) : form.description.trim();
    if ((desc || null) !== (e.description ?? null) && !(quoteInflow && desc === (e.description ?? ""))) out.description = desc || null;
    if ((form.memo.trim() || null) !== (e.memo ?? null)) out.memo = form.memo.trim() || null;
    const qid = form.quoteId.trim() ? Number(form.quoteId) : null; if (qid !== e.quoteId) out.quoteId = qid;
    const pid = form.projectId.trim() ? Number(form.projectId) : null; if (pid !== e.projectId) out.projectId = pid;
    const lid = form.linkedPaymentId ? Number(form.linkedPaymentId) : null; if (lid !== e.linkedPaymentId) out.linkedPaymentId = lid;
    return out;
  }, [e, form, isDed, quoteInflow]);
  const dirty = Object.keys(changes).length > 0;

  const save = async () => {
    if (!e || !dirty || saving) return;
    setSaving(true); setErrors([]); setSavedAt(null);
    try {
      const send = (confirmImpact: boolean) => fetch(api(`/api/prepaid/ledger/${entryId}`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ base: e, changes, reason: reason.trim() || undefined, confirmImpact }),
      });
      let res = await send(false); let d = await res.json().catch(() => ({}));
      if (res.status === 409 && d?.code === "IMPACT_CONFIRM_REQUIRED") {
        const im = d.impact;
        const lines = [
          ...im.warnings.map((w: string) => `⚠ ${w}`), "",
          `잔액 ${won(im.balance.before)}원 → ${won(im.balance.after)}원`,
          ...(im.quote ? [`견적 ${im.quote.quoteNumber ?? "#" + im.quote.id} 차감 적용액 ${won(im.quote.before.usageAmount)}원 → ${won(im.quote.after.usageAmount)}원 · 차감 후 잔액 ${won(im.quote.before.balanceAfter)}원 → ${won(im.quote.after.balanceAfter)}원`] : []),
          ...im.otherFinancialChanges.filter((o: any) => !o.removed && !o.added).map((o: any) => `원장 #${o.id}(${TYPE_LABEL[o.type] ?? o.type}) ${FIELD_LABEL[o.field] ?? o.field}: ${fmtVal(o.field, o.before)} → ${fmtVal(o.field, o.after)}`),
          ...(im.balanceOnlyRows ? [`잔액 표시만 바뀌는 확정 행 ${im.balanceOnlyRows}건`] : []),
          "", "원래 값은 수정 이력에 보존됩니다.",
        ];
        if (!(await confirmDialog({ title: "영향 범위 확인", message: lines.join("\n"), confirmLabel: "확인하고 저장", cancelLabel: "저장 안 함", variant: "warning" }))) return;
        res = await send(true); d = await res.json().catch(() => ({}));
      }
      if (res.status === 409 && d?.code === "CONFLICT") {
        await alertDialog({ title: "다른 사용자가 먼저 수정함", message: d.error, variant: "warning" });
        const nd = await load(); if (nd) setForm(toForm(nd));
        return;
      }
      if (!res.ok) { setErrors(d?.errors ?? [d?.error ?? `저장 실패 (${res.status}) — 저장되지 않았습니다.`]); return; }
      // 성공 — 서버 값으로 다시 읽어 화면 = DB 값 보장
      const nd = await load();
      if (nd) setForm(toForm(nd));
      setReason(""); setEditing(false);
      setSavedAt(d.unchanged ? "변경된 내용이 없습니다." : "저장되었습니다.");
      if (!d.unchanged) { onToast?.("원장을 수정했습니다."); await onSaved(); }
    } catch {
      setErrors(["서버에 연결하지 못했습니다 — 저장되지 않았습니다."]);
    } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!e) return;
    const r = await promptDialog({ title: "원장 행 삭제", message: `이 거래(#${e.id}, ${TYPE_LABEL[e.type] ?? e.type} ${won(e.amount)}원)를 삭제합니다.\n잔액은 자동 재계산되고, 삭제 전 값은 이력에 남습니다.\n\n삭제 사유를 입력하세요.`, confirmLabel: "삭제", variant: "danger", label: "삭제 사유", validate: v => (v.trim() ? null : "삭제 사유를 입력하세요.") });
    if (r == null) return;
    const res = await fetch(api(`/api/admin/prepaid-ledger/${e.id}?reason=${encodeURIComponent(r)}`), { method: "DELETE", headers: authHeaders });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { await alertDialog({ title: "삭제 실패", message: d?.error ?? `오류 (${res.status})`, variant: "warning" }); return; }
    onToast?.("원장 행을 삭제했습니다.");
    await onDeleted();
  };

  const inp: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "6px 9px", fontSize: 13, border: "1px solid #d1d5db", borderRadius: 6, background: "#fff" };
  const dis: React.CSSProperties = { ...inp, background: "#f3f4f6", color: "#6b7280" };
  const lbl = (text: string, k?: string) => (
    <label style={{ fontSize: 11.5, fontWeight: 600, color: "#374151", display: "block", marginBottom: 3 }}>
      {text}{k && rules?.fields[k] && !rules.fields[k].editable && <span title={rules.fields[k].reason} style={{ color: "#9ca3af", fontWeight: 400 }}> · 잠김</span>}
    </label>
  );
  const info = (k: string, v: React.ReactNode) => (
    <div key={k} style={{ display: "contents" }}>
      <div style={{ fontSize: 12, color: "#64748b", padding: "4px 0" }}>{k}</div>
      <div style={{ fontSize: 12.5, color: "#0f172a", padding: "4px 0", wordBreak: "break-all" }}>{v ?? "-"}</div>
    </div>
  );

  return (
    <DraggableModal title={`선입금 원장 #${entryId}`} subtitle={detail?.companyName ?? undefined} onClose={onClose} width={720} zIndex={1300} resizable>
      {error && <div role="alert" style={{ color: "#b91c1c", fontSize: 13 }}>{error}</div>}
      {!detail || !e || !form ? (!error && <div style={{ padding: 24, textAlign: "center", color: "#94a3b8" }}>불러오는 중…</div>) : (
        <div data-testid="prepaid-entry-modal">
          {rules?.notice && <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e40af", borderRadius: 6, padding: "7px 10px", fontSize: 12, marginBottom: 10 }}>{rules.notice}</div>}
          {savedAt && <div role="status" data-testid="entry-saved" style={{ background: "#dcfce7", color: "#166534", borderRadius: 6, padding: "6px 10px", fontSize: 12, marginBottom: 10 }}>{savedAt}</div>}

          {!editing ? (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 110px 1fr", columnGap: 12, marginBottom: 10 }}>
                {info("거래처", detail.companyName)}
                {info("거래일", formatDisplayDate(e.transactionDate))}
                {info("구분", detail.label)}
                {info(isDed ? "차감액" : "입금액", <b style={{ color: isDed ? "#b91c1c" : "#15803d" }}>{won(e.amount)}원</b>)}
                {info("공급가 / 부가세", isDed && e.supplyAmount != null ? `${won(e.supplyAmount)} / ${won(e.taxAmount)}` : "-")}
                {info("연결 견적번호", detail.quote ? `${detail.quote.quoteNumber ?? "#" + detail.quote.id}${detail.quote.title ? ` · ${detail.quote.title}` : ""}` : "-")}
                {info("연결 판매번호", e.projectId != null ? `#${e.projectId}${detail.saleNo ? ` (${detail.saleNo})` : ""}${detail.projectTitle ? ` · ${detail.projectTitle}` : ""}` : "-")}
                {info("서비스명", detail.serviceNames ?? "-")}
                {info("기존 입금 연결", detail.linkedPayment ? `판매 #${detail.linkedPayment.projectId}${detail.linkedPayment.saleNo ? `(${detail.linkedPayment.saleNo})` : ""} ${detail.linkedPayment.sequence}회차 · ${won(detail.linkedPayment.amount)}원 · 입금일 ${detail.linkedPayment.paidDate ?? "-"}` : "-")}
                {info("거래 내용", e.description ?? "-")}
                {info("비고", e.memo ?? "-")}
                {info("등록자", `${detail.createdByName ?? "-"} · ${fmtTs(e.createdAt)}`)}
                {info("최종 수정자", detail.modifiedByName ?? "-")}
                {info("최종 수정일시", fmtTs(detail.modifiedAt))}
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                {canManage && rules?.editable && <PrimaryBtn onClick={() => { setEditing(true); setSavedAt(null); }} data-testid="entry-edit-btn" aria-label="수정" style={{ fontSize: 12, padding: "6px 14px" }}>수정</PrimaryBtn>}
                {canDelete && <GhostBtn onClick={remove} data-testid="entry-delete-btn" aria-label="원장 행 삭제" style={{ fontSize: 12, padding: "6px 14px", color: "#b91c1c" }}>삭제</GhostBtn>}
                <GhostBtn onClick={onClose} data-testid="entry-close-btn" aria-label="닫기" style={{ fontSize: 12, padding: "6px 14px" }}>닫기</GhostBtn>
              </div>
            </>
          ) : (
            <div data-testid="entry-edit-form" style={{ marginBottom: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>{lbl("거래일", "transactionDate")}
                  {f("transactionDate") ? <DateField value={form.transactionDate} onChange={v => setForm({ ...form, transactionDate: v })} allowClear={false} ariaLabel="거래일" testid="entry-date" style={inp} />
                    : <input value={formatDisplayDate(form.transactionDate)} disabled style={dis} aria-label="거래일(잠김)" data-testid="entry-date-locked" />}</div>
                <div>{lbl(isDed ? "구분" : "입금 유형", "type")}
                  <select value={form.type} disabled={!f("type")} onChange={ev => setForm({ ...form, type: ev.target.value })} aria-label="구분" data-testid="entry-type" style={f("type") ? inp : dis}>
                    {isDed ? <option value={e.type}>{TYPE_LABEL[e.type] ?? e.type}</option> : (
                      (rules?.quoteManaged || e.linkedPaymentId != null ? ["deposit", "carryover"] : ["deposit", "carryover", "adjustment"]).map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)
                    )}
                  </select></div>
                <div>{lbl(isDed ? "차감액(원)" : "입금액(원)", "amount")}
                  <NumericInput value={form.amount} onChange={v => setForm({ ...form, amount: v })} allowDecimal disabled={!f("amount")} suffix="원" ariaLabel="금액" testId="entry-amount" style={f("amount") ? inp : dis} /></div>
                {isDed ? (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <div>{lbl("공급가", "supplyAmount")}<NumericInput value={form.supplyAmount} onChange={v => setForm({ ...form, supplyAmount: v })} disabled={!f("supplyAmount")} ariaLabel="공급가" testId="entry-supply" style={f("supplyAmount") ? inp : dis} /></div>
                    <div>{lbl("부가세", "taxAmount")}<NumericInput value={form.taxAmount} onChange={v => setForm({ ...form, taxAmount: v })} disabled={!f("taxAmount")} ariaLabel="부가세" testId="entry-tax" style={f("taxAmount") ? inp : dis} /></div>
                  </div>
                ) : <div />}
                <div>{lbl("연결 견적 ID", "quoteId")}
                  <input value={form.quoteId} onChange={ev => setForm({ ...form, quoteId: ev.target.value.replace(/\D/g, "") })} disabled={!f("quoteId")} placeholder="견적 ID(선택)" aria-label="연결 견적 ID" data-testid="entry-quote" style={f("quoteId") ? inp : dis} />
                  {detail.quote && <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>현재: {detail.quote.quoteNumber ?? "#" + detail.quote.id}</div>}</div>
                <div>{lbl("연결 판매 ID", "projectId")}
                  <input value={form.projectId} onChange={ev => setForm({ ...form, projectId: ev.target.value.replace(/\D/g, "") })} disabled={!f("projectId")} placeholder="판매(프로젝트) ID(선택)" aria-label="연결 판매 ID" data-testid="entry-project" style={f("projectId") ? inp : dis} />
                  {e.projectId != null && <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>현재: #{e.projectId}{detail.saleNo ? ` (${detail.saleNo})` : ""}</div>}</div>
                {quoteInflow ? (
                  <>
                    <div>{lbl("원천(원 견적/판매 번호 등)", "description")}<input value={form.sourceRef} onChange={ev => setForm({ ...form, sourceRef: ev.target.value })} disabled={!f("description")} aria-label="원천" data-testid="entry-source" style={f("description") ? inp : dis} /></div>
                    <div>{lbl("거래 내용(견적 선입 비고)", "description")}<input value={form.lineNote} onChange={ev => setForm({ ...form, lineNote: ev.target.value })} disabled={!f("description")} aria-label="거래 내용" data-testid="entry-desc" style={f("description") ? inp : dis} /></div>
                  </>
                ) : (
                  <div style={{ gridColumn: "1 / -1" }}>{lbl("거래 내용", "description")}<input value={form.description} onChange={ev => setForm({ ...form, description: ev.target.value })} disabled={!f("description")} aria-label="거래 내용" data-testid="entry-desc" style={f("description") ? inp : dis} /></div>
                )}
                {!isDed && (
                  <div style={{ gridColumn: "1 / -1" }}>{lbl("기존 입금 연결(판매·수금관리에 이미 기록된 입금 — 새 입금으로 이중 계산하지 않음)", "linkedPaymentId")}
                    <select value={form.linkedPaymentId} onChange={ev => setForm({ ...form, linkedPaymentId: ev.target.value })} disabled={!f("linkedPaymentId")}
                      aria-label="기존 입금 연결" data-testid="entry-link" style={f("linkedPaymentId") ? inp : dis}>
                      <option value="">연결 안 함(선입금관리에서 받은 입금)</option>
                      {cands.map(c => (
                        <option key={c.paymentId} value={String(c.paymentId)} disabled={c.linkedRow != null}>
                          판매 #{c.projectId}{c.saleNo ? `(${c.saleNo})` : ""} {c.sequence ?? "-"}회차 · {won(c.amount)}원 · 입금 {c.paidDate ?? "-"}{c.linkedRow != null ? ` — 원장 #${c.linkedRow}에 연결됨` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div style={{ gridColumn: "1 / -1" }}>{lbl("비고", "memo")}<input value={form.memo} onChange={ev => setForm({ ...form, memo: ev.target.value })} disabled={!f("memo")} aria-label="비고" data-testid="entry-memo" style={f("memo") ? inp : dis} /></div>
                <div style={{ gridColumn: "1 / -1" }}>
                  {lbl("수정 사유 (선택)")}
                  <input value={reason} onChange={ev => setReason(ev.target.value)} placeholder="예: 입금액 정정" aria-label="수정 사유" data-testid="entry-reason" style={inp} />
                </div>
              </div>
              {errors.length > 0 && <div role="alert" data-testid="entry-errors" style={{ marginTop: 10, background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: 6, padding: "7px 10px", fontSize: 12, whiteSpace: "pre-line" }}>{errors.join("\n")}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
                <PrimaryBtn onClick={save} disabled={!dirty || saving} data-testid="entry-save" aria-label="저장" style={{ fontSize: 12, padding: "6px 16px" }}>{saving ? "저장 중…" : "저장"}</PrimaryBtn>
                <GhostBtn onClick={() => { setEditing(false); setErrors([]); setReason(""); setForm(toForm(detail)); }} disabled={saving} data-testid="entry-cancel" aria-label="수정 취소" style={{ fontSize: 12, padding: "6px 14px" }}>취소</GhostBtn>
                {dirty && <span style={{ fontSize: 11.5, color: "#64748b" }}>변경: {Object.keys(changes).map(k => FIELD_LABEL[k] ?? k).join(", ")}</span>}
              </div>
            </div>
          )}

          <div style={{ fontWeight: 700, fontSize: 13, color: "#0f172a", margin: "4px 0 6px" }}>수정 이력 <span style={{ fontWeight: 400, color: "#94a3b8", fontSize: 11 }}>— 이전 값은 여기에 보존됩니다</span></div>
          {history.length === 0 ? <div style={{ fontSize: 12, color: "#94a3b8" }}>이력이 없습니다(이력 기록 이전에 등록된 거래).</div> : (
            <div style={{ border: "1px solid #e2e8f0", borderRadius: 6, overflow: "auto", maxHeight: 260 }}>
              <table data-testid="entry-history" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr>{["일시", "수정자", "구분", "변경 내용", "사유"].map(h => <th key={h} style={{ textAlign: "left", padding: "5px 8px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 11, color: "#475569", whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
                <tbody>
                  {history.map(h => {
                    const keys = Object.keys(FIELD_LABEL).filter(k => (h.before?.[k] ?? null) !== (h.after?.[k] ?? null) && !(h.before?.[k] != null && h.after?.[k] != null && Number(h.before[k]) === Number(h.after[k]) && typeof h.before[k] === "number"));
                    return (
                      <tr key={h.id} style={{ borderBottom: "1px solid #f1f5f9", background: h.related ? "#fafafa" : undefined }}>
                        <td style={{ padding: "5px 8px", whiteSpace: "nowrap", verticalAlign: "top" }}>{fmtTs(h.changedAt)}</td>
                        <td style={{ padding: "5px 8px", whiteSpace: "nowrap", verticalAlign: "top" }}>{h.changedByName ?? "-"}</td>
                        <td style={{ padding: "5px 8px", whiteSpace: "nowrap", verticalAlign: "top" }}>{ACTION_LABEL[h.action] ?? h.action}{h.related ? <div style={{ fontSize: 10, color: "#94a3b8" }}>같은 견적 행 #{h.ledgerId}</div> : null}</td>
                        <td style={{ padding: "5px 8px", verticalAlign: "top" }}>
                          {h.action === "create" ? `${fmtVal("type", h.after?.type)} ${fmtVal("amount", h.after?.amount)} · ${fmtVal("transactionDate", h.after?.transactionDate)}`
                            : h.action === "delete" ? `삭제 전: ${fmtVal("type", h.before?.type)} ${fmtVal("amount", h.before?.amount)} · ${fmtVal("transactionDate", h.before?.transactionDate)}`
                            : keys.length === 0 ? <span style={{ color: "#94a3b8" }}>잔액 재계산</span>
                            : keys.map(k => <div key={k}><span style={{ color: "#64748b" }}>{FIELD_LABEL[k]}</span> {fmtVal(k, h.before?.[k])} → <b>{fmtVal(k, h.after?.[k])}</b></div>)}
                        </td>
                        <td style={{ padding: "5px 8px", verticalAlign: "top", color: "#475569" }}>{h.reason ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </DraggableModal>
  );
}
