// ─────────────────────────────────────────────────────────────────────────────
// 과거 CRM 차감견적서 AI 불러오기 — 차감견적서 작성 화면 전용 버튼 + 확인 패널.
//  · PDF 업로드 → 서버 AI 분석(전체 페이지) → 결과는 편집 화면 입력칸에만 채움(저장 전 DB 미반영).
//  · '확인 필요'(합계 불일치·날짜 미확인·부가세 불명확), 기존 원장 중복 의심, 같은 PDF 복원 이력을 표시.
//  · 저장 후 재조회 시 원본 PDF 열람 + 분석 당시 확인 항목 표시(견적 이력 기록).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useRef, useState } from 'react';
import { api } from '../../lib/constants';
import { Card, DsButton } from '../ui';
import { C } from '../../lib/ds';

export type LegacyAnalysis = {
  companyName: string | null; contactName: string | null; quoteDate: string | null; title?: string | null;
  vatMode: 'excluded' | 'included' | 'unknown';
  deposits: Array<{ date: string | null; amount: number; supplyAmount?: number | null; grossSource?: string; note?: string | null; page?: number | null }>;
  items: Array<{ date: string | null; fileName?: string | null; service: string; serviceType?: string | null; quantity?: number | null; unit?: string | null; unitPrice?: number | null; amount: number; note?: string | null; page?: number | null; productId?: number | null; productName?: string | null }>;
  totals: { supply: number | null; vat: number | null; total: number | null; remainingBalance: number | null };
  warnings: string[];
};
export type LegacyPlan = {
  convention: 'usage' | 'balance' | 'unknown';
  deposits: Array<{ amount: number; supplyAmount: number | null; date: string | null; invoiceDate: string | null; estimated: boolean; note: string }>;
  items: Array<LegacyAnalysis['items'][number] & { memo: string }>;
};
export type LegacyAnalyzeResult = {
  analysis: LegacyAnalysis; plan: LegacyPlan; flags: string[];
  company: { id: number; name: string } | null; contact: { id: number; name: string } | null;
  depositMatches: Array<{ index: number; ledgerId: number; status: string; date: string | null; quoteId: number | null }>;
  priorRestores: Array<{ quoteId: number; quoteNumber: string | null }>;
  // 같은 거래처의 다른 차감 견적에 같은 내역(파일명 과반 일치)이 이미 원장(예약/확정)에 있음 → 새로 채우지 않음(중복 계산 방지)
  existingRestore: { quoteId: number; quoteNumber: string | null; quoteStatus: string; ledgerStatus: 'reserved' | 'confirmed'; inflow: number; deduction: number; matched: number; total: number } | null;
  source: { fileKey: string | null; fileName: string; sha256: string; pages: number | null };
};
export type LegacyRestoreInfo = { fileKey?: string | null; fileName?: string | null; flags?: string[]; result?: string; restoredAt?: string; restoredBy?: string | null; useExisting?: boolean; excludedLedgerIds?: number[] } | null;

const won = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n).toLocaleString('ko-KR')}원`);

type Current = { supply: number; tax: number; total: number; deposit: number };
// 원본 PDF 합계 ↔ 입력값 대조(저장 전 표시·확인용 — 잔액 확정에 쓰지 않음).
//  · 잔액형 PDF(balance): PDF 합계 = 입금 − 차감 사용내역  · 일반(usage): PDF 합계 = 차감 사용내역
//  입금 공급가: 입력 입금액이 반영안과 같으면 PDF 인쇄 공급가, 바뀌었으면 입금액 ÷ 1.1.
export function legacyReconcile(p: LegacyAnalyzeResult, cur: Current) {
  const deps = p.plan.deposits;
  const pdfDep = deps.reduce((s, d) => s + d.amount, 0);
  const depSupply = Math.abs(cur.deposit - pdfDep) < 1
    ? deps.reduce((s, d) => s + (d.supplyAmount ?? Math.round(d.amount / 1.1)), 0)
    : Math.round(cur.deposit / 1.1);
  const bal = p.plan.convention === 'balance';
  return {
    bal, pdfDep,
    supply: bal ? depSupply - cur.supply : cur.supply,
    tax: bal ? (cur.deposit - depSupply) - cur.tax : cur.tax,
    total: bal ? cur.deposit - cur.total : cur.total,
  };
}
export function legacyDiffs(p: LegacyAnalyzeResult, cur: Current): string[] {
  const t = p.analysis.totals;
  const r = legacyReconcile(p, cur);
  const near = (a: number, b: number) => Math.abs(a - b) < 1;
  const out: string[] = [];
  const lbl = r.bal ? '입력(입금 − 차감)' : '입력(차감 사용내역)';
  if (t.supply != null && !near(r.supply, t.supply)) out.push(`공급가액: PDF ${won(t.supply)} · ${lbl} ${won(r.supply)}`);
  if (t.vat != null && !near(r.tax, t.vat)) out.push(`부가세: PDF ${won(t.vat)} · ${lbl} ${won(r.tax)}`);
  if (t.total != null && !near(r.total, t.total)) out.push(`합계: PDF ${won(t.total)} · ${lbl} ${won(r.total)}`);
  if (!near(cur.deposit, r.pdfDep)) out.push(`선입금: PDF ${won(r.pdfDep)} · 입력 ${won(cur.deposit)}`);
  return out;
}

interface Props {
  token: string;
  savedQuoteId: number | null;
  pending: LegacyAnalyzeResult | null;        // 분석 후 저장 전
  saved: LegacyRestoreInfo;                   // 저장(원장 반영) 후 재조회
  disabled?: boolean;
  current: Current;                           // 현재 입력값 합계(원본 대조용)
  onAnalyzed: (r: LegacyAnalyzeResult) => void;
  onToast: (m: string) => void;
}

export function LegacyDeductionImport({ token, savedQuoteId, pending, saved, disabled, current, onAnalyzed, onToast }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [showDrop, setShowDrop] = useState(false);   // 버튼 클릭 → 업로드 영역(드래그 놓기 · 클릭 선택)
  const [dragOver, setDragOver] = useState(false);
  const [blocked, setBlocked] = useState<LegacyAnalyzeResult | null>(null);   // 이미 다른 견적으로 원장에 있는 내역
  const MAX_MB = 20;                                 // 서버 업로드 제한과 동일
  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { onToast('PDF 파일만 업로드할 수 있습니다.'); return; }
    if (f.size > MAX_MB * 1024 * 1024) { onToast(`파일 용량은 ${MAX_MB}MB 이하만 가능합니다.`); return; }
    void analyze(f);
  };

  const analyze = async (f: File) => {
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', f);
      if (savedQuoteId != null) fd.append('quoteId', String(savedQuoteId));   // 지금 편집 중인 견적은 중복 비교에서 제외
      const res = await fetch(api('/api/admin/quotes/legacy-deduction/analyze'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(d.error ?? `분석 실패(${res.status})`); return; }
      setShowDrop(false);
      if ((d as LegacyAnalyzeResult).existingRestore) { setBlocked(d as LegacyAnalyzeResult); return; }   // 입력칸에 채우지 않음
      setBlocked(null);
      onAnalyzed(d as LegacyAnalyzeResult);
    } catch { onToast('AI 분석 중 오류가 발생했습니다.'); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const openOriginal = async () => {
    if (savedQuoteId == null) return;
    const res = await fetch(api(`/api/admin/quotes/${savedQuoteId}/legacy-restore/file`), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { onToast('원본 PDF를 불러오지 못했습니다.'); return; }
    window.open(URL.createObjectURL(await res.blob()), '_blank');
  };

  const flags = pending?.flags ?? saved?.flags ?? [];
  const box: React.CSSProperties = { marginTop: 10, padding: '10px 14px', borderRadius: 8, fontSize: 12, lineHeight: 1.6 };

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>과거 견적서 불러오기</strong>
        <span style={{ fontSize: 12, color: C.textSecondary }}>과거 CRM 차감견적서 PDF를 AI가 분석해 아래 입력칸을 채웁니다. 저장 전에는 DB에 반영되지 않습니다.</span>
        <span style={{ flex: 1 }} />
        <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden data-testid="input-legacy-deduction-pdf" aria-label="과거 견적서 PDF 선택"
          onChange={e => pick(e.target.files?.[0])} />
        <DsButton onClick={() => setShowDrop(v => !v)} disabled={busy || disabled} data-testid="btn-legacy-deduction-ai" aria-label="과거 견적서 AI 불러오기">
          {busy ? 'AI 분석 중…' : '과거 견적서 AI 불러오기'}
        </DsButton>
      </div>

      {showDrop && (
        <div role="button" tabIndex={0} data-testid="legacy-deduction-dropzone" aria-label="PDF 파일을 끌어다 놓거나 클릭해 선택"
          onClick={() => !busy && fileRef.current?.click()}
          onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !busy) { e.preventDefault(); fileRef.current?.click(); } }}
          onDragOver={e => { e.preventDefault(); if (!busy) setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); if (!busy) pick(e.dataTransfer.files?.[0]); }}
          style={{ marginTop: 10, padding: '22px 14px', borderRadius: 8, textAlign: 'center', fontSize: 12.5, cursor: busy ? 'wait' : 'pointer',
            border: `2px dashed ${dragOver ? C.primary : C.g300}`, background: dragOver ? '#eff6ff' : C.g50, color: C.textSecondary, transition: 'border-color .15s, background .15s' }}>
          {busy ? 'AI 분석 중… 잠시 기다려 주세요.' : <>과거 차감견적서 <b>PDF를 여기로 끌어다 놓거나</b> 클릭해 선택하세요 · PDF만 · 최대 {MAX_MB}MB</>}
        </div>
      )}

      {blocked?.existingRestore && (() => {
        const e = blocked.existingRestore;
        return (
          <div style={{ ...box, background: '#fef2f2', border: '1px solid #fecaca' }} data-testid="legacy-deduction-already">
            <b style={{ color: C.danger }}>이미 원장에 반영된 내역입니다 — 입력칸에 채우지 않았습니다.</b>
            <div>{blocked.source.fileName}의 차감 항목 {e.total}건 중 {e.matched}건이 견적 <b>{e.quoteNumber ?? `#${e.quoteId}`}</b>에 있고,
              그 견적의 선입금 원장({e.ledgerStatus === 'confirmed' ? '확정' : '예약'})에 입금 {won(e.inflow)} · 차감 {won(e.deduction)}이 올라가 있습니다.</div>
            <div style={{ color: C.textSecondary }}>새 견적으로 다시 저장하면 같은 거래가 두 번 계산됩니다. 견적 목록에서 {e.quoteNumber ?? `#${e.quoteId}`}를 열어 확인·수정하세요(그 견적 안에서 다시 불러오면 같은 원장 행을 갱신합니다).</div>
          </div>
        );
      })()}

      {pending && (
        <div style={{ ...box, background: '#eff6ff', border: '1px solid #bfdbfe' }} data-testid="legacy-deduction-pending">
          <div><b>{pending.source.fileName}</b>{pending.source.pages ? ` · ${pending.source.pages}페이지` : ''} 분석 결과를 입력칸에 채웠습니다 — 확인·수정 후 저장하면 선입금 원장에 반영됩니다.</div>
          <div style={{ color: C.textSecondary }}>
            입금 {pending.plan.deposits.length}건 · 차감 {pending.plan.items.length}행{pending.plan.convention === 'balance' ? ' (잔액형 PDF → 입금·차감으로 변환)' : ''} · 견적일 {pending.analysis.quoteDate ?? '미확인'}
            {' · '}금액 기준 {pending.analysis.vatMode === 'included' ? '부가세 포함(원본 값 그대로 입력)' : pending.analysis.vatMode === 'excluded' ? '공급가액(부가세 별도)' : '불명확'}
          </div>
          {(() => {
            const t = pending.analysis.totals;
            const diffs = legacyDiffs(pending, current);
            const cell: React.CSSProperties = { padding: '2px 10px', textAlign: 'right', whiteSpace: 'nowrap' };
            const r = legacyReconcile(pending, current);
            const rows: Array<[string, number | null, number]> = [
              ['공급가액', t.supply, r.supply], ['부가세', t.vat, r.tax], ['합계', t.total, r.total],
              ['└ 입금(선입금 항목, 부가세 포함)', r.pdfDep, current.deposit], ['└ 차감 사용내역 합계', null, current.total],
            ];
            return (
              <div style={{ overflowX: 'auto', marginTop: 4 }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 12 }} data-testid="legacy-deduction-compare">
                  <thead><tr><th style={{ ...cell, textAlign: 'left' }}>원본 대조</th><th style={cell}>PDF</th><th style={cell}>{r.bal ? '입력값(입금 − 차감)' : '입력값'}</th></tr></thead>
                  <tbody>{rows.map(([k, pdf, cur]) => {
                    const bad = pdf != null && Math.abs(pdf - cur) >= 1;
                    return <tr key={k} style={{ color: bad ? C.danger : undefined, fontWeight: bad ? 700 : undefined }}>
                      <td style={{ ...cell, textAlign: 'left' }}>{k}</td><td style={cell}>{won(pdf)}</td><td style={cell}>{won(cur)}{bad ? ' ⚠' : ''}</td></tr>;
                  })}</tbody>
                </table>
                {diffs.length > 0
                  ? <div style={{ color: C.danger, fontWeight: 600 }}>원본과 다른 값 {diffs.length}건 — 확인·수정 후 저장하세요(저장 시 한 번 더 확인).</div>
                  : <div style={{ color: C.successText }}>원본 PDF의 금액과 일치합니다.</div>}
              </div>
            );
          })()}
          {pending.priorRestores.length > 0 && (
            <div style={{ color: C.danger, fontWeight: 600 }}>같은 PDF로 이미 복원된 견적이 있습니다: {pending.priorRestores.map(p => p.quoteNumber ?? `#${p.quoteId}`).join(', ')} — 중복 저장하지 마세요.</div>
          )}
          {pending.depositMatches.length > 0 && (
            <div style={{ color: '#b45309' }}>
              기존 원장에 같은 금액의 선입금이 있습니다: {pending.depositMatches.map(m => `선입금 ${m.index + 1} ↔ 원장 #${m.ledgerId}(${m.date ?? '-'}, ${m.status === 'confirmed' ? '확정' : '예약'})`).join(' · ')}
              {' '}— 저장 시 '기존 기록 사용' 또는 '신규 복원'을 선택합니다.
            </div>
          )}
        </div>
      )}

      {!pending && saved && (
        <div style={{ ...box, background: C.g50, border: `1px solid ${C.g200}` }} data-testid="legacy-deduction-saved">
          과거 견적서에서 복원됨{saved.fileName ? ` · ${saved.fileName}` : ''}{saved.restoredAt ? ` · ${String(saved.restoredAt).slice(0, 10)}` : ''}
          {saved.result === 'confirmed' ? ' · 선입금 원장 반영 완료' : ''}{saved.useExisting ? ' · 중복 선입금은 기존 기록 사용' : ''}
          {saved.fileKey && <DsButton onClick={openOriginal} style={{ marginLeft: 8, fontSize: 11, padding: '2px 8px' }} data-testid="btn-legacy-deduction-original" aria-label="원본 PDF 보기">원본 PDF</DsButton>}
        </div>
      )}

      {flags.length > 0 && (
        <div style={{ ...box, background: '#fef2f2', border: '1px solid #fecaca' }} data-testid="legacy-deduction-flags">
          <b style={{ color: C.danger }}>확인 필요 {flags.length}건</b>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{flags.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </div>
      )}
    </Card>
  );
}
