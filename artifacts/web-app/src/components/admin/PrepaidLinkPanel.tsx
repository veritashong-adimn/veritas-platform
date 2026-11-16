// ─── 기존 입금 연결 — 판매관리 입금완료 청구회차를 선입금 원장의 예정 선입/이월 행에 참조 연결 후 확정 ─────────
//  새 현금 입금을 만들지 않는다(신규 입금 누계 불변). 후보·차단 사유·관리자 검토 사유는 서버가 판정하고,
//  이 화면은 선택·예상 원장 변경 확인·실행만 담당한다. 최종 검증은 서버(트랜잭션·부분 유니크 인덱스).
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/constants";
import { PrimaryBtn, GhostBtn, confirmDialog, alertDialog } from "../ui";

type Inflow = { id: number; type: string; amount: number; transactionDate: string | null; linkedPaymentId: number | null };
type Candidate = {
  paymentId: number; projectId: number; projectTitle: string | null; saleNo: string | null; sequence: number | null;
  amount: number; paidDate: string | null; depositStatus: string | null; depositConfirmed: boolean | null;
  companyName: string | null; billingCompanyName: string | null;
  linkedTo: { ledgerId: number; quoteId: number | null; status: string } | null;
  allocation: "prepaid_sale" | "regular_sale"; usableAmount: number; sameProject: boolean;
  blockers: string[]; needsApproval: string[];
};
const fmt = (n: number) => Math.round(n).toLocaleString("ko-KR");

export function PrepaidLinkPanel({ quoteId, quoteLabel, deduction, currentBalance, authHeaders, isAdmin, reasons, onDone, onCancel }: {
  quoteId: number; quoteLabel: string; deduction: number; currentBalance: number;
  authHeaders: Record<string, string>; isAdmin: boolean; reasons: string[];
  onDone: () => void; onCancel: () => void;
}) {
  const [data, setData] = useState<{ inflow: Inflow[]; candidates: Candidate[] } | null>(null);
  const [pick, setPick] = useState<Record<number, number | null>>({});   // ledgerId → paymentId
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(api(`/api/prepaid/quotes/${quoteId}/link-candidates`), { headers: authHeaders })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        setData(d);
        // 자동 선택: 같은 판매·금액 일치·차단 사유 없는 후보(하나뿐일 때만) — 확정은 사용자가 버튼으로
        const init: Record<number, number | null> = {};
        for (const l of d.inflow as Inflow[]) {
          const ok = (d.candidates as Candidate[]).filter(c => c.blockers.length === 0 && Math.abs(c.amount - l.amount) < 0.005);
          const same = ok.filter(c => c.sameProject);
          init[l.id] = (same.length === 1 ? same[0] : ok.length === 1 ? ok[0] : null)?.paymentId ?? null;
        }
        setPick(init);
      }).catch(() => setData({ inflow: [], candidates: [] }));
  }, [quoteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = useMemo(() => (data?.inflow ?? []).map(l => ({ l, c: data!.candidates.find(c => c.paymentId === pick[l.id]) ?? null })), [data, pick]);
  const linkedSum = chosen.reduce((s, x) => s + (x.c ? x.l.amount : 0), 0);
  const approvals = [...new Set(chosen.flatMap(x => x.c?.needsApproval ?? []))];
  const blockers = [...new Set(chosen.flatMap(x => x.c ? [...x.c.blockers, ...(Math.abs(x.c.amount - x.l.amount) >= 0.005 ? [`금액 불일치 — 선입 ${fmt(x.l.amount)}원 · 입금 ${fmt(x.c.amount)}원`] : [])] : []))];
  const allPicked = chosen.length > 0 && chosen.every(x => x.c);
  const canRun = allPicked && blockers.length === 0 && (approvals.length === 0 || (isAdmin && note.trim().length > 0));

  const run = async () => {
    const links = chosen.filter(x => x.c).map(x => ({ ledgerId: x.l.id, paymentId: x.c!.paymentId }));
    if (!(await confirmDialog({ title: "기존 입금 연결 후 확정",
      message: `${quoteLabel}\n\n기존 입금 연결 ${fmt(linkedSum)}원(새 입금 아님 · 신규 입금 누계 변화 없음)\n차감 확정 -${fmt(deduction)}원\n확정 잔액 ${fmt(currentBalance)}원 → ${fmt(currentBalance + linkedSum - deduction)}원\n\n판매관리 청구회차·입금 기록은 바뀌지 않습니다.`,
      confirmLabel: "연결 후 확정" }))) return;
    setBusy(true);
    try {
      const post = (allowDuplicate: boolean) => fetch(api(`/api/prepaid/quotes/${quoteId}/link-confirm`), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ links, reviewNote: note.trim() || undefined, allowDuplicate }),
      });
      let res = await post(false); let d = await res.json().catch(() => ({}));
      if (res.status === 409 && d?.code === "POSSIBLE_DUPLICATE") {
        const list = (d.matches ?? []).map((m: any) => `· ${m.reason}`).join("\n");
        if (!(await confirmDialog({ title: "중복 의심 — 확정 보류", message: `${d.error}\n\n${list}\n\n서로 다른 돈이 확실한 경우에만 '그래도 반영'을 누르세요.`, confirmLabel: "그래도 반영", cancelLabel: "확정 보류", variant: "danger" }))) return;
        res = await post(true); d = await res.json().catch(() => ({}));
      }
      if (!res.ok) { await alertDialog({ title: "연결·확정 보류", message: (d?.reasons ?? [d?.error ?? `오류 (${res.status})`]).join("\n"), variant: "warning" }); return; }
      onDone();
    } finally { setBusy(false); }
  };

  const th: React.CSSProperties = { padding: "6px 8px", fontSize: 11, color: "#475569", textAlign: "left", whiteSpace: "nowrap", borderBottom: "1px solid #e2e8f0" };
  const td: React.CSSProperties = { padding: "6px 8px", fontSize: 12, borderBottom: "1px solid #f1f5f9", verticalAlign: "top" };
  return (
    <div data-testid="prepaid-link-panel" style={{ border: "1px solid #93c5fd", background: "#eff6ff", borderRadius: 12, padding: "14px 16px", marginBottom: 20 }}>
      <div style={{ fontWeight: 700, fontSize: 14, color: "#1e3a8a", marginBottom: 6 }}>기존 입금 연결 — {quoteLabel}</div>
      <div style={{ fontSize: 12, color: "#1e40af", marginBottom: 10, lineHeight: 1.6 }}>
        판매관리에 이미 입금완료된 기록이 있어 새 입금으로 반영하지 않습니다. 그 기록을 연결해 선입금으로 사용합니다.
        {reasons.length > 0 && <div style={{ marginTop: 4, color: "#92400e" }}>{reasons.map((r, i) => <div key={i}>· {r}</div>)}</div>}
      </div>
      {!data ? <div style={{ fontSize: 12, color: "#64748b" }}>불러오는 중…</div> : data.inflow.map(l => (
        <div key={l.id} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a", marginBottom: 4 }}>예정 {l.type === "carryover" ? "이월" : "선입"} {fmt(l.amount)}원 ({l.transactionDate ?? "-"}) — 연결할 입금 선택</div>
          <div style={{ overflowX: "auto", background: "#fff", borderRadius: 8, border: "1px solid #dbeafe" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["", "거래처", "판매", "청구회차", "실제 입금일", "입금금액", "기존 상태", "사용 가능", "연결 여부", "확인 사항"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {data.candidates.length === 0 && <tr><td colSpan={10} style={{ ...td, color: "#94a3b8", textAlign: "center" }}>이 거래처의 입금완료 청구회차가 없습니다.</td></tr>}
                {data.candidates.map(c => {
                  const disabled = c.blockers.length > 0;
                  return (
                    <tr key={c.paymentId} style={{ background: pick[l.id] === c.paymentId ? "#dbeafe" : undefined, opacity: disabled ? 0.6 : 1 }}>
                      <td style={td}><input type="radio" name={`link-${l.id}`} disabled={disabled} checked={pick[l.id] === c.paymentId}
                        onChange={() => setPick(p => ({ ...p, [l.id]: c.paymentId }))} data-testid={`link-pick-${l.id}-${c.paymentId}`} aria-label={`청구회차 ${c.paymentId} 선택`} /></td>
                      <td style={td}>{c.billingCompanyName ?? c.companyName ?? "-"}</td>
                      <td style={td}>#{c.projectId}{c.saleNo ? ` · ${c.saleNo}` : ""}<div style={{ color: "#64748b", fontSize: 11 }}>{c.projectTitle ?? ""}{c.sameProject ? " · 이 판매" : ""}</div></td>
                      <td style={td}>{c.sequence ?? "-"}회차 (#{c.paymentId})</td>
                      <td style={td}>{c.paidDate ?? "-"}</td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{fmt(c.amount)}원</td>
                      <td style={td}>{c.depositStatus === "completed" ? "입금완료" : c.depositStatus ?? "-"}{c.depositConfirmed ? " · 확인" : ""}</td>
                      <td style={{ ...td, textAlign: "right" }}>{fmt(c.usableAmount)}원</td>
                      <td style={td}>{c.linkedTo ? `연결됨(원장 #${c.linkedTo.ledgerId})` : "미연결"}</td>
                      <td style={{ ...td, fontSize: 11, color: c.blockers.length ? "#b91c1c" : c.needsApproval.length ? "#92400e" : "#15803d", minWidth: 220 }}>
                        {[...c.blockers, ...c.needsApproval].map((t, i) => <div key={i}>· {t}</div>)}
                        {c.blockers.length === 0 && c.needsApproval.length === 0 && (c.allocation === "prepaid_sale" ? "차감 판매 입금(수금 집계 제외) — 연결 가능" : "연결 가능")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {data && (
        <div data-testid="prepaid-link-preview" style={{ background: "#fff", border: "1px solid #dbeafe", borderRadius: 8, padding: "10px 12px", fontSize: 12, color: "#0f172a", marginBottom: 10, lineHeight: 1.7 }}>
          <b>예상 원장 변경</b> · 기존 입금 연결 +{fmt(linkedSum)}원(신규 입금 누계 변화 없음) · 차감 확정 -{fmt(deduction)}원 · 확정 잔액 {fmt(currentBalance)}원 → <b>{fmt(currentBalance + linkedSum - deduction)}원</b>
          {blockers.length > 0 && <div style={{ color: "#b91c1c" }}>{blockers.map((b, i) => <div key={i}>· {b}</div>)}</div>}
        </div>
      )}
      {approvals.length > 0 && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 12px", marginBottom: 10, fontSize: 12, color: "#92400e" }}>
          <b>관리자 검토 필요</b>{approvals.map((a, i) => <div key={i}>· {a}</div>)}
          {isAdmin
            ? <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="검토 결과(예: CRM 진행 건과 별개 입금 확인 — 근거)" rows={2}
                data-testid="link-review-note" aria-label="관리자 검토 사유" style={{ width: "100%", marginTop: 6, boxSizing: "border-box", fontSize: 12, padding: 6, borderRadius: 6, border: "1px solid #fcd34d" }} />
            : <div style={{ marginTop: 4 }}>관리자 계정으로 검토 사유를 입력해야 진행할 수 있습니다.</div>}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <PrimaryBtn onClick={run} disabled={!canRun || busy} data-testid="btn-link-confirm" aria-label="기존 입금 연결 후 확정" style={{ fontSize: 12, padding: "6px 14px" }}>
          {busy ? "처리 중…" : "기존 입금 연결 후 확정"}
        </PrimaryBtn>
        <GhostBtn onClick={onCancel} data-testid="btn-link-cancel" aria-label="연결 취소" style={{ fontSize: 12, padding: "6px 14px" }}>닫기(보류)</GhostBtn>
      </div>
    </div>
  );
}
