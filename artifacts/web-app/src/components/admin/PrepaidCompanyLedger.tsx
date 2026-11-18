// ─── 거래처 선입금 원장(조회 전용) — 거래일 | 구분 | 입금액 | 차감액 | 잔액 ─────────────────────────
//  선입금·차감은 차감 견적서에서만 입력·수정한다. 견적서를 저장하면 이 원장에 그대로 반영된다.
//  행을 누르면 연결된 견적서를 견적관리에서 연다(견적이 없는 과거 기록은 조회만).
//  잔액 = 누적 입금 − 누적 차감(거래일·등록 순 누적). 현재 잔액은 표 아래 한 번만.
import React, { useCallback, useEffect, useState } from "react";
import { formatDisplayDate } from "../../lib/dateFormat";
import { GhostBtn } from "../ui";
import { getJson, won, type CompanyLedger } from "./prepaidLedgerShared";
import { api } from "../../lib/constants";
import { buildQuotePdfData, type QuoteDetail } from "../../lib/quotePdf";
import QuotePdfPreviewModal from "./QuotePdfPreviewModal";

/** 원장 → 견적서 열기(AdminDashboard 가 받아 견적관리 편집 화면으로 이동) */
export const openQuoteFromLedger = (quoteId: number) => window.dispatchEvent(new CustomEvent("veritas:open-quote", { detail: { quoteId } }));

export function PrepaidCompanyLedger({ companyId, authHeaders, onOpenQuote }: {
  companyId: number; authHeaders: Record<string, string>;
  /** 행 클릭 시 추가 동작(예: 팝업 닫기). 견적 이동 자체는 항상 수행 */
  onOpenQuote?: (quoteId: number) => void;
}) {
  const [data, setData] = useState<CompanyLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 연결 견적서 미리보기(기존 견적서 미리보기·인쇄/PDF 저장 재사용) — 조회 전용, 데이터 변경 없음
  const [pdf, setPdf] = useState<{ data: ReturnType<typeof buildQuotePdfData>; title: string } | null>(null);
  const [pdfErr, setPdfErr] = useState<string | null>(null);
  const preview = async (quoteId: number, quoteNumber?: string | null) => {
    setPdfErr(null);
    try {
      const res = await fetch(api(`/api/admin/quotes/${quoteId}`), { headers: authHeaders, cache: "no-store" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setPdfErr(`견적서 ${quoteNumber ?? `#${quoteId}`} 미리보기 실패: ${(d as any)?.error ?? res.status}`); return; }
      setPdf({ data: buildQuotePdfData(d as QuoteDetail), title: (d as any).title ?? quoteNumber ?? `견적서 #${quoteId}` });
    } catch { setPdfErr("견적서 미리보기 중 오류가 발생했습니다."); }
  };

  const load = useCallback(async () => {
    setError(null);
    try { setData(await getJson<CompanyLedger>(`/api/prepaid/companies/${companyId}/ledger`, authHeaders)); }
    catch (e: any) { setError(e?.message ?? "원장 조회 실패"); }
  }, [companyId, authHeaders]);
  useEffect(() => { load(); }, [load]);

  if (error) return <div role="alert" style={{ color: "#b91c1c", fontSize: 12 }}>{error} <GhostBtn onClick={load} style={{ fontSize: 11, padding: "2px 8px" }} aria-label="원장 다시 불러오기" data-testid={`prepaid-ledger-retry-${companyId}`}>다시 시도</GhostBtn></div>;
  if (!data) return <div style={{ fontSize: 12, color: "#94a3b8", padding: 6 }}>불러오는 중…</div>;

  const th: React.CSSProperties = { padding: "5px 8px", fontSize: 11.5, fontWeight: 700, color: "#475569", borderBottom: "1px solid #e2e8f0", background: "#f8fafc", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "5px 8px", borderBottom: "1px solid #f1f5f9", fontSize: 12.5, whiteSpace: "nowrap" };
  const num: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const dash = <span style={{ color: "#cbd5e1" }}>-</span>;
  const open = (quoteId: number) => { openQuoteFromLedger(quoteId); onOpenQuote?.(quoteId); };
  // 이 거래처 원장에 연결된 견적서(중복 제거, 등장 순)
  const linkedQuotes = [...new Map(data.ledger.filter(r => r.quoteId != null).map(r => [r.quoteId!, r.quoteNumber ?? null])).entries()];
  const quoteBtn = (id: number, no: string | null) => (
    <button key={id} type="button" onClick={e => { e.stopPropagation(); void preview(id, no); }}
      data-testid={`ledger-quote-preview-${id}`} aria-label={`견적서 ${no ?? `#${id}`} 미리보기`} title="견적서 미리보기 · 인쇄/PDF 저장"
      style={{ border: "1px solid #bfdbfe", background: "#eff6ff", color: "#1e40af", borderRadius: 4, padding: "1px 7px", fontSize: 11.5, cursor: "pointer", fontVariantNumeric: "tabular-nums" }}>
      {no ?? `#${id}`}
    </button>
  );

  return (
    <div data-testid={`company-ledger-${companyId}`} style={{ maxWidth: 820 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 6, fontSize: 12 }} data-testid={`ledger-quotes-${companyId}`}>
        <span style={{ color: "#475569", fontWeight: 700 }}>연결 견적서</span>
        {linkedQuotes.length ? linkedQuotes.map(([id, no]) => quoteBtn(id, no)) : <span style={{ color: "#94a3b8" }}>연결된 견적서 없음</span>}
      </div>
      {pdfErr && <div role="alert" style={{ color: "#b91c1c", fontSize: 12, marginBottom: 6 }}>{pdfErr}</div>}
      <div style={{ border: "1px solid #e2e8f0", borderRadius: 6, background: "#fff", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left" }}>거래일</th>
              <th style={{ ...th, textAlign: "left" }}>구분</th>
              <th style={{ ...th, textAlign: "right" }}>입금액</th>
              <th style={{ ...th, textAlign: "right" }}>차감액</th>
              <th style={{ ...th, textAlign: "right" }}>잔액</th>
              <th style={{ ...th, textAlign: "left" }}>견적서</th>
            </tr>
          </thead>
          <tbody>
            {data.openingBalance !== 0 && (
              <tr data-testid={`ledger-opening-${companyId}`} title="이관 등으로 원장 행 없이 계정에 있던 잔액">
                <td style={td}>미입력</td><td style={td}>기초 잔액</td>
                <td style={num}>{data.openingBalance > 0 ? won(data.openingBalance) : dash}</td>
                <td style={num}>{data.openingBalance < 0 ? won(-data.openingBalance) : dash}</td>
                <td style={num}>{won(data.openingBalance)}</td>
                <td style={{ ...td, color: "#94a3b8" }}>연결된 견적서 없음</td>
              </tr>
            )}
            {data.ledger.length === 0 && data.openingBalance === 0 && <tr><td colSpan={6} style={{ ...td, textAlign: "center", color: "#94a3b8" }}>거래가 없습니다.</td></tr>}
            {data.ledger.map(r => {
              const linked = r.quoteId != null;
              return (
                <tr key={r.id} data-testid={`ledger-row-${r.id}`}
                  onClick={linked ? () => open(r.quoteId!) : undefined}
                  onKeyDown={linked ? e => { if (e.key === "Enter") open(r.quoteId!); } : undefined}
                  tabIndex={linked ? 0 : undefined} role={linked ? "link" : undefined}
                  aria-label={linked ? `${r.label} — 연결 견적서 열기` : undefined}
                  title={linked ? "클릭하면 연결된 견적서에서 수정할 수 있습니다" : "연결된 견적서가 없는 기록입니다(조회 전용)"}
                  style={{ cursor: linked ? "pointer" : "default" }}>
                  <td style={td}>{r.transactionDate ? formatDisplayDate(r.transactionDate) : "미입력"}</td>
                  <td style={{ ...td, color: linked ? "#1e40af" : undefined, textDecoration: linked ? "underline" : undefined, textUnderlineOffset: 2 }}>{r.label}</td>
                  <td style={num}>{r.inflow ? won(r.inflow) : dash}</td>
                  <td style={num}>{r.outflow ? won(r.outflow) : dash}</td>
                  <td style={{ ...num, color: r.balance < 0 ? "#b91c1c" : undefined }}>{won(r.balance)}</td>
                  <td style={td}>{linked ? quoteBtn(r.quoteId!, r.quoteNumber ?? null) : <span style={{ color: "#94a3b8" }}>연결된 견적서 없음</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ textAlign: "right", marginTop: 6, fontSize: 13 }}>
        현재 잔액: <b data-testid={`ledger-balance-${companyId}`}>{won(data.totals.balance)}원</b>
      </div>
      {pdf && <QuotePdfPreviewModal data={pdf.data} quoteTitle={pdf.title} onClose={() => setPdf(null)} />}
    </div>
  );
}
