// 운영 판매 상세 — 과거 CRM 에서 전환된 판매건의 출처·확인 대상·CRM 원본정보(원본은 조회 전용).
//   과거 지급 확인 필요 건은 여기서 관리자 확인(지급완료 확인 / 미지급 확인)으로만 처리한다(서버 settlement.pay 권한 검증).
import React, { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/constants";
import { Card, GhostBtn, promptDialog, confirmDialog, alertDialog } from "../ui";

type Origin = {
  saleNo: string; activatedAt: string; legacyRowId: number | null; sourceChanged: boolean;
  amountBasis?: { originalProductName: string | null; originalTotal: number | null; taxBreakdown: string };
  sourceRaw: Record<string, unknown> | null;
  payoutItems: { assignmentId: number; legacyStatus: string; payDate: string | null; originalPreTax: number | null; performerName: string | null; costTotal: number | null; paymentStatus: string | null; deleted: boolean }[];
  payoutSummary: { legacyPaid: number; reviewPending: number; reviewResolved: number };
  collection: { status: string; reason?: string | null; parsedAmount?: number | null; total?: number; depositDate?: string | null } | null;
};

const won = (n: number | null | undefined) => (n == null ? "-" : Math.round(Number(n)).toLocaleString());
const LEGACY_LABEL: Record<string, string> = {
  legacy_paid: "과거 지급완료", payout_review: "과거 지급 확인 필요",
  payout_review_paid: "확인: 지급완료", payout_review_unpaid: "확인: 미지급(지급대상)", unpaid: "미지급(금액 없음)",
};

export function LegacyOriginSection({ projectId, token, onChanged, onToast, onLoaded, onReverted }: {
  projectId: number; token: string; onChanged: () => void; onToast: (m: string) => void; onLoaded?: (isLegacy: boolean) => void;
  onReverted?: () => void;   // 과거 CRM 원복 완료 — 판매 목록으로 복귀 등
}) {
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reverting, setReverting] = useState(false);
  const authH = { Authorization: `Bearer ${token}` };
  // 원복은 관리자만(서버도 admin 역할을 다시 확인)
  const isAdmin = (() => { try { return JSON.parse(localStorage.getItem("auth_user") ?? "{}")?.role === "admin"; } catch { return false; } })();

  const load = useCallback(async () => {
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/legacy-origin`), { headers: authH });
      const d = await res.json().catch(() => ({}));
      setOrigin(res.ok ? (d.origin ?? null) : null);
      onLoaded?.(!!(res.ok && d.origin));
    } catch { setOrigin(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, token]);
  useEffect(() => { load(); }, [load]);

  const resolve = async (assignmentId: number, decision: "paid" | "unpaid") => {
    const reason = await promptDialog({
      title: decision === "paid" ? "과거 지급완료 확인" : "미지급 확인(지급대상 전환)",
      message: decision === "paid" ? "과거에 이미 지급된 건으로 확정합니다. 지급회차·대량이체 대상에서 계속 제외됩니다.\n확인 근거를 입력하세요." : "아직 지급되지 않은 건으로 확인합니다. 지급보류가 해제되어 지급회차 수집 대상이 됩니다.\n확인 근거를 입력하세요.",
      placeholder: "예: 2025-03 지급 통장내역 확인",
      confirmLabel: "확인",
    });
    if (reason == null || !reason.trim()) return;
    setBusyId(assignmentId);
    try {
      const res = await fetch(api(`/api/admin/performances/${assignmentId}/legacy-payout-review`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" }, body: JSON.stringify({ decision, reason: reason.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`처리 실패: ${d?.error ?? res.status}`); return; }
      onToast("과거 지급 확인이 처리되었습니다.");
      await load(); onChanged();
    } catch { onToast("처리 중 오류가 발생했습니다."); }
    finally { setBusyId(null); }
  };

  // 과거 CRM 원복 — 서버가 실제 DB 연결(입금·정산·지급회차·추가 견적 등)을 확인한 뒤에만 확인창을 띄운다
  const revert = async () => {
    setReverting(true);
    try {
      const cr = await fetch(api(`/api/admin/projects/${projectId}/legacy-revert-check`), { headers: authH });
      const c = await cr.json().catch(() => ({}));
      if (!cr.ok) { onToast(`원복 확인 실패: ${c?.error ?? cr.status}`); return; }
      if (!c.canRevert) {
        await alertDialog({ title: "과거 CRM 판매건 원복", message: `${c.message}\n\n${(c.reasons ?? []).map((r: string) => `· ${r}`).join("\n")}`, variant: "warning" });
        return;
      }
      const ok = await confirmDialog({
        title: "과거 CRM 판매건 원복",
        message: "이 판매건을 과거 CRM 자료로 원복하시겠습니까?\n\n원복 후에는 과거 CRM 자료로 분류되며, 다시 수정하려면 운영 판매건으로 전환해야 합니다."
          + (c.modified?.changed ? `\n\n※ 전환 후 수정된 내용(${c.modified.fields.join(", ")})은 삭제되지 않고 취소된 운영 판매건·견적 휴지통에 보관됩니다.` : ""),
        confirmLabel: "원복 실행", cancelLabel: "취소", variant: "danger",
      });
      if (!ok) return;
      const res = await fetch(api(`/api/admin/projects/${projectId}/legacy-revert`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (d?.code === "REVERT_BLOCKED") await alertDialog({ title: "과거 CRM 판매건 원복", message: `${d.error}\n\n${(d.reasons ?? []).map((r: string) => `· ${r}`).join("\n")}`, variant: "warning" });
        else onToast(`원복 실패: ${d?.error ?? res.status}`);
        return;
      }
      onToast(`판매번호 ${d.saleNo} — 과거 CRM 판매건으로 원복했습니다.`);
      onReverted ? onReverted() : onChanged();
    } catch { onToast("원복 처리 중 오류가 발생했습니다."); }
    finally { setReverting(false); }
  };

  if (!origin) return null;
  const pending = origin.payoutItems.filter(p => p.legacyStatus === "payout_review" && !p.deleted);
  const col = origin.collection;
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }} data-testid="legacy-origin-section">
        <span style={{ width: 22, height: 22, borderRadius: 6, background: "#fef3c7", color: "#92400e", fontSize: 12, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>F</span>
        <span style={{ fontSize: 15, fontWeight: 800, color: "#111827" }}>과거 CRM 원본정보</span>
        <span style={{ fontSize: 12, color: "#6b7280" }}>판매번호 {origin.saleNo} · 원본은 변경되지 않습니다</span>
        {isAdmin && (
          <GhostBtn onClick={revert} disabled={reverting} style={{ marginLeft: "auto", fontSize: 12, padding: "4px 10px" }}
            data-testid="btn-legacy-revert" aria-label="과거 CRM으로 원복">{reverting ? "확인 중…" : "과거 CRM으로 원복"}</GhostBtn>
        )}
      </div>

      {origin.sourceChanged && (
        <div style={{ padding: "8px 12px", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, fontSize: 12, color: "#9a3412", marginBottom: 10 }} data-testid="legacy-origin-changed">
          전환 이후 과거 CRM 재업로드로 원본이 바뀌었습니다. 운영정보에는 자동 반영하지 않았습니다 — 아래 원본과 비교해 필요 시 직접 수정하세요.
        </div>
      )}

      {origin.amountBasis && (
        <div style={{ fontSize: 12, color: "#374151", marginBottom: 8 }} data-testid="legacy-origin-amount-basis">
          원본 상품명 <b>{origin.amountBasis.originalProductName ?? "-"}</b> · 원본 총액 <b>{won(origin.amountBasis.originalTotal)}원</b>
          <span style={{ color: "#92400e" }}> — 원본에 공급가·부가세 구분 없음(총액 그대로 1개 항목, 고객용 문서에는 이 안내를 출력하지 않음)</span>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, marginBottom: 10 }}>
        <span>과거 지급완료 <b>{origin.payoutSummary.legacyPaid}</b>건</span>
        <span style={{ color: pending.length ? "#92400e" : undefined }}>과거 지급 확인 필요 <b>{pending.length}</b>건</span>
        <span>확인 완료 <b>{origin.payoutSummary.reviewResolved}</b>건</span>
        {col && (
          <span style={{ color: col.status === "collection_review" ? "#92400e" : undefined }} data-testid="legacy-origin-collection">
            수금: {col.status === "legacy_collected" ? `과거 수금완료 연결(${col.depositDate ?? "-"})` : col.status === "collection_review" ? `수금 확인 대상 — ${col.reason ?? ""}${col.parsedAmount != null ? ` (원본 입금합계 ${won(col.parsedAmount)} / 판매 ${won(col.total)})` : ""}` : "원본 입금기록 없음"}
          </span>
        )}
      </div>

      {pending.length > 0 && (
        <div style={{ border: "1px solid #fde68a", borderRadius: 8, marginBottom: 12, overflow: "hidden" }}>
          <div style={{ padding: "6px 10px", background: "#fffbeb", fontSize: 12, fontWeight: 700, color: "#92400e" }}>과거 지급 확인 필요 — 확인 전에는 지급회차·기업은행 대량이체에서 제외됩니다</div>
          {pending.map(p => (
            <div key={p.assignmentId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", borderTop: "1px solid #fef3c7", fontSize: 12 }}>
              <span style={{ minWidth: 120 }}>{p.performerName ?? "-"}</span>
              <span>원가합계 {won(p.costTotal)}</span>
              <span style={{ color: "#6b7280" }}>원본 지급액(세전) {won(p.originalPreTax)}</span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                <GhostBtn onClick={() => resolve(p.assignmentId, "paid")} disabled={busyId === p.assignmentId} style={{ fontSize: 11, padding: "3px 8px" }}
                  data-testid={`btn-legacy-paid-${p.assignmentId}`} aria-label="과거 지급완료로 확인">지급완료 확인</GhostBtn>
                <GhostBtn onClick={() => resolve(p.assignmentId, "unpaid")} disabled={busyId === p.assignmentId} style={{ fontSize: 11, padding: "3px 8px" }}
                  data-testid={`btn-legacy-unpaid-${p.assignmentId}`} aria-label="미지급으로 확인">미지급 확인</GhostBtn>
              </span>
            </div>
          ))}
        </div>
      )}

      {origin.payoutItems.length > 0 && (
        <details style={{ marginBottom: 10 }}>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "#374151" }}>원본 수행행 처리 내역 ({origin.payoutItems.length}건)</summary>
          <div style={{ marginTop: 6, fontSize: 12 }}>
            {origin.payoutItems.map(p => (
              <div key={p.assignmentId} style={{ display: "flex", gap: 10, padding: "3px 0", borderBottom: "1px solid #f3f4f6" }}>
                <span style={{ minWidth: 120 }}>{p.performerName ?? "-"}</span>
                <span style={{ minWidth: 150 }}>{LEGACY_LABEL[p.legacyStatus] ?? p.legacyStatus}</span>
                <span>지급일 {p.payDate ?? "-"}</span>
                <span>원본 지급액 {won(p.originalPreTax)}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {origin.sourceRaw && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            {Object.entries(origin.sourceRaw).map(([k, v]) => (
              <tr key={k} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <td style={{ padding: "6px 8px", width: 200, color: "#6b7280" }}>{k}</td>
                <td style={{ padding: "6px 8px", color: "#111827", wordBreak: "break-word" }}>{v == null || v === "" ? "-" : String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
