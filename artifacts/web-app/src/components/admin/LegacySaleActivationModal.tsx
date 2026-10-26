// 과거 CRM 판매건 → 운영 판매건 전환 미리보기·확인 모달.
//   미리보기(GET activation-preview, DB 미변경) → 관리자 확인 → 전환(POST activate, planToken 검증) → 판매 상세로 이동.
import React, { useEffect, useState } from "react";
import { api } from "../../lib/constants";
import { PrimaryBtn, GhostBtn } from "../ui";
import { DraggableModal } from "./DraggableModal";

type Perf = {
  progressRowId: number; translatorName: string | null; translatorId: number | null; translatorMatch: string;
  productName: string | null; deliveryDate: string | null; payDate: string | null;
  originalPreTax: number | null; computedPreTax: number; amountDiff: number | null;
  plannedStatus: "legacy_paid" | "payout_review" | "unpaid";
};
type Plan = {
  legacyRowId: number; saleNo: string; saleDate: string | null; existing: { projectId: number } | null;
  title: string; productName: string; total: number;
  company: { name: string | null; matchedId: number | null; matchedName: string | null; method: string };
  contact: { name: string | null; matchedId: number | null; method: string };
  pm: { name: string | null; matchedId: number | null };
  performances: Perf[];
  perfSummary: { total: number; legacyPaid: number; payoutReview: number; unpaid: number; translatorUnmapped: number };
  collection: { depositDate: string | null; depositMemo: string | null; status: "matched" | "review" | "none"; reason: string | null; parsedAmount: number | null };
  warnings: string[]; planToken: string;
};

const won = (n: number | null | undefined) => (n == null ? "-" : Math.round(n).toLocaleString());
const STATUS_LABEL: Record<Perf["plannedStatus"], { t: string; c: string; bg: string }> = {
  legacy_paid:   { t: "과거 지급완료", c: "#166534", bg: "#dcfce7" },
  payout_review: { t: "과거 지급 확인 필요", c: "#92400e", bg: "#fef3c7" },
  unpaid:        { t: "미지급(금액 없음)", c: "#374151", bg: "#f3f4f6" },
};
const cell: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #f3f4f6", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

export function LegacySaleActivationModal({ legacyRowId, token, onClose, onActivated, onToast }: {
  legacyRowId: number; token: string; onClose: () => void; onActivated: (projectId: number) => void; onToast: (m: string) => void;
}) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const authH = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(api(`/api/admin/legacy-archive/${legacyRowId}/activation-preview`), { headers: authH });
        const d = await res.json();
        if (!res.ok) { if (alive) setErr(d?.error ?? `미리보기 실패 (${res.status})`); return; }
        if (alive) setPlan(d);
      } catch { if (alive) setErr("미리보기 조회 중 오류가 발생했습니다."); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacyRowId, token]);

  const activate = async () => {
    if (!plan || busy) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/legacy-archive/${legacyRowId}/activate`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, planToken: plan.planToken }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.status === 409 && d?.projectId) { onToast("이미 전환된 판매건입니다. 운영 판매 상세로 이동합니다."); onActivated(d.projectId); return; }
      if (!res.ok) { onToast(`전환 실패: ${d?.error ?? res.status}`); return; }
      onToast("운영 판매건으로 전환되었습니다.");
      onActivated(d.projectId);
    } catch { onToast("전환 중 오류가 발생했습니다."); }
    finally { setBusy(false); }
  };

  return (
    <DraggableModal title="과거 CRM 판매건 운영 전환" subtitle="미리보기 — 확인 전에는 아무것도 저장되지 않습니다" onClose={onClose} width={860} zIndex={500} bodyPadding="16px 22px" resizable>
      {err && <div style={{ padding: 14, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }} data-testid="activation-error">{err}</div>}
      {!err && !plan && <div style={{ padding: 24, textAlign: "center", color: "#6b7280", fontSize: 13 }}>미리보기 불러오는 중…</div>}
      {plan && (
        <div data-testid="activation-preview" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {plan.existing && (
            <div style={{ padding: 10, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, fontSize: 13, color: "#1e40af" }}>
              이미 운영 판매건으로 전환되었습니다.
              <GhostBtn onClick={() => onActivated(plan.existing!.projectId)} style={{ marginLeft: 8, fontSize: 12, padding: "4px 10px" }} data-testid="btn-open-activated" aria-label="운영 판매 상세 열기">운영 판매 상세 열기</GhostBtn>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {([
              ["판매번호", plan.saleNo], ["판매일", plan.saleDate ?? "-"], ["판매금액(총액)", `${won(plan.total)}원`],
              ["거래처", plan.company.matchedId ? `${plan.company.name} → Master 연결` : `${plan.company.name ?? "-"} (${plan.company.method === "ambiguous" ? "후보 여러 곳 · 미연결" : "Master 미연결"})`],
              ["담당자/고객", plan.contact.matchedId ? `${plan.contact.name} → 담당자 연결` : `${plan.contact.name ?? "-"} (미연결)`],
              ["상품(1개 항목)", plan.productName],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} style={{ padding: "7px 10px", background: "#f9fafb", border: "1px solid #f0f0f0", borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: "#6b7280" }}>{k}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#111827", wordBreak: "break-word" }}>{v}</div>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 13, fontWeight: 800, color: "#111827" }}>
            수행정보 {plan.perfSummary.total}건 — 과거 지급완료 {plan.perfSummary.legacyPaid} · 과거 지급 확인 필요 {plan.perfSummary.payoutReview} · 미지급 {plan.perfSummary.unpaid}
            {plan.perfSummary.translatorUnmapped > 0 && <span style={{ color: "#b45309" }}> · 통번역사 미연결 {plan.perfSummary.translatorUnmapped}</span>}
          </div>
          {plan.performances.length > 0 && (
            <div style={{ maxHeight: 220, overflow: "auto", border: "1px solid #e5e7eb", borderRadius: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                <thead><tr style={{ background: "#f9fafb" }}>
                  {["통번역사", "Master", "상품/내용", "납품일", "지급일", "원본 지급액(세전)", "처리"].map(h => <th key={h} style={{ ...cell, textAlign: "left", fontWeight: 700, color: "#6b7280" }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {plan.performances.map(p => (
                    <tr key={p.progressRowId}>
                      <td style={cell}>{p.translatorName ?? "-"}</td>
                      <td style={{ ...cell, color: p.translatorId ? "#166534" : "#b45309" }}>{p.translatorId ? "연결" : "미연결"}</td>
                      <td style={cell} title={p.productName ?? undefined}>{p.productName ?? "-"}</td>
                      <td style={cell}>{p.deliveryDate ?? "-"}</td>
                      <td style={cell}>{p.payDate ?? "-"}</td>
                      <td style={cell}>{won(p.originalPreTax)}{p.amountDiff != null && Math.abs(p.amountDiff) >= 1 && <span style={{ color: "#b45309" }}> (계산 {won(p.computedPreTax)})</span>}</td>
                      <td style={cell}><span style={{ padding: "1px 6px", borderRadius: 4, background: STATUS_LABEL[p.plannedStatus].bg, color: STATUS_LABEL[p.plannedStatus].c, fontWeight: 700 }}>{STATUS_LABEL[p.plannedStatus].t}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ padding: "8px 12px", borderRadius: 8, fontSize: 13, background: plan.collection.status === "matched" ? "#f0fdf4" : "#fffbeb", border: `1px solid ${plan.collection.status === "matched" ? "#bbf7d0" : "#fde68a"}` }} data-testid="activation-collection">
            <b>수금</b> — 원본 입금일 {plan.collection.depositDate ?? "-"} · 입금내역 {plan.collection.depositMemo ?? "-"}
            <div style={{ marginTop: 2, color: plan.collection.status === "matched" ? "#166534" : "#92400e" }}>
              {plan.collection.status === "matched" ? "입금합계 = 판매금액 → 과거 수금완료 기록 1건으로 연결합니다(중복 생성 없음)."
                : plan.collection.status === "review" ? `수금 확인 대상 — ${plan.collection.reason}. 자동 수금완료 처리하지 않습니다.`
                : "원본 입금기록 없음 — 미수금으로 전환됩니다."}
            </div>
          </div>

          {plan.warnings.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#6b7280", lineHeight: 1.6 }}>
              {plan.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          <div style={{ fontSize: 12, color: "#6b7280" }}>과거 CRM 원본은 변경되지 않으며, 원본↔운영 매핑(판매번호)으로 연결됩니다. 재업로드해도 운영정보는 덮어쓰지 않습니다.</div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <GhostBtn onClick={onClose} disabled={busy} style={{ fontSize: 13, padding: "8px 16px" }} data-testid="btn-activation-cancel" aria-label="전환 취소">취소</GhostBtn>
            {!plan.existing && (
              <PrimaryBtn onClick={activate} disabled={busy} style={{ fontSize: 13, padding: "8px 16px" }} data-testid="btn-activation-confirm" aria-label="운영 판매건으로 전환 후 수정">
                {busy ? "전환 중…" : "운영 판매건으로 전환 후 수정"}
              </PrimaryBtn>
            )}
          </div>
        </div>
      )}
    </DraggableModal>
  );
}
