/**
 * TransactionStatementModal — 거래명세서 출력 모달
 *
 * - 저장된 견적 데이터(QuotePdfData)를 그대로 사용해 거래명세서를 렌더링한다.
 * - 견적서 PDF의 데이터 파이프라인·레이아웃을 공유하되, 거래명세서 전용 문서로 분리한다.
 * - 견적서와의 차이: 제목 "거래명세서", 거래 정보(명세서 번호·거래일자·견적번호),
 * - 거래일자(2026-11): 출력 설정에서 선택·저장(견적당 1건, /api/admin/quotes/:id/statement). 인쇄/PDF 는 저장 후 출력 —
 *   저장되지 않은 날짜가 출력되지 않는다. 번호는 견적에서 파생되어 날짜 변경과 무관(불변).
 *   수신자에 사업자등록번호 추가, 견적 조건/유효기간 미표시.
 * - 금액은 견적서에 저장된 값을 그대로 사용하고 재계산하지 않는다(부가세 라벨은 견적서와 같은 vatSummaryLabel).
 * - 공급자·수신자 박스·품목 배지·직인은 견적서와 같은 공통 부품(docParts)을 쓴다. 직인은 공급자 정보 박스 오른쪽 위에만 표시.
 * - 인쇄는 견적서와 같은 인쇄 HTML(buildQuotePrintHtml — 페이지 여백·표 분리 규칙 공통)을 사용한다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/constants';
import { DateField } from './DatePickerShared';
import type { QuotePdfData } from '../../lib/quotePdf';
import { vatSummaryLabel } from '../../lib/quotePdf';
import { renderQuoteTitle, buildDocFileName, formatDocNumber } from '../../lib/quoteTitle';
import { alertDialog } from '../ui';
import { buildQuotePrintHtml } from '../../lib/quotePrintHtml';
import { DocPreviewWindow } from './DocPreviewWindow';
import { BRAND, BRAND_LIGHT, useCompanySeal, SealImage, SealErrorNotice, InfoBox, PartyRows, SummaryRow, ItemTypeBadge } from './docParts';

// ─── 숫자 / 날짜 포맷 ────────────────────────────────────────────────────────
const fmt = (n: number) => n.toLocaleString('ko-KR');

// 'YYYY-MM-DD' → 'YYYY.MM.DD'(거래명세서 거래일자 표기)
const dotDate = (ds: string | null | undefined) => (ds ? ds.slice(0, 10).replace(/-/g, '.') : '');

type TaxRound = { id: number; sequence: number; issueDate: string; paymentMethod: string | null; supplyAmount: string; vatAmount: string; amount: string };
type StatementState = {
  statementNo: string;
  saved: { transactionDate: string; dateSource: string; linkedPaymentId: number | null; createdAt: string; updatedAt: string } | null;
  taxInvoiceRounds: TaxRound[];
  suggestion: { transactionDate: string; dateSource: string; linkedPaymentId: number | null; needsRoundSelection: boolean; basis: string };
};

// ─── 공통 인라인 스타일 ───────────────────────────────────────────────────────
const PAGE_STYLE: React.CSSProperties = {
  width: 794,
  minHeight: 1123,
  margin: '0 auto',
  padding: '48px 52px',
  background: '#fff',
  boxSizing: 'border-box',
  fontFamily: '"Apple SD Gothic Neo", "Malgun Gothic", "맑은 고딕", sans-serif',
  fontSize: 12,
  color: '#1a1a2e',
  lineHeight: 1.6,
};

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────

interface TransactionStatementModalProps {
  data: QuotePdfData;
  quoteTitle?: string;
  quoteId: number;   // 거래일자 저장 단위(견적당 거래명세서 1건)
  token: string;
  onClose: () => void;
}

export default function TransactionStatementModal({ data, quoteTitle, quoteId, token, onClose }: TransactionStatementModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  // 회사 직인 — 견적서와 같은 환경설정 직인(R2 비공개, 서버가 data URI 로 제공). 실패·미등록이면 직인 없이 출력
  const { url: sealUrl, error: sealError } = useCompanySeal();

  // 공식 문서번호 — 견적서와 동일한 formatDocNumber 규칙 사용(표시 전용, 내부 Raw 번호 미노출).
  // 거래명세서 T260716-008 / 견적번호 Q260716-008. 발행일(quoteDate) 기반 순번 파생.
  const statementNo = formatDocNumber('T', data.quoteNumber, data.quoteDate);
  const quoteNo     = formatDocNumber('Q', data.quoteNumber, data.quoteDate);

  // ── 거래명세서 출력 설정(거래일자) — 저장값 > 세금계산서 발행일(1개) > 회차 선택(여러 개) > 오늘 ──
  const [st, setSt] = useState<StatementState | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [date, setDate] = useState('');
  const [sameAsTax, setSameAsTax] = useState(false);
  const [paymentId, setPaymentId] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const authJson = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const applyState = (s: StatementState) => {
    setSt(s);
    const g = s.suggestion;
    setDate(g.transactionDate); setSameAsTax(g.dateSource === 'tax_invoice'); setPaymentId(g.linkedPaymentId);
  };
  useEffect(() => {
    let alive = true;
    fetch(api(`/api/admin/quotes/${quoteId}/statement`), { headers: authJson })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!alive) return; if (!r.ok) { setLoadErr(j.error || '거래일자 조회 실패'); return; } applyState(j); })
      .catch(() => { if (alive) setLoadErr('거래일자 조회 실패'); });
    return () => { alive = false; };
  }, [quoteId]); // eslint-disable-line react-hooks/exhaustive-deps
  const rounds = st?.taxInvoiceRounds ?? [];
  const selRound = rounds.find(r => r.id === paymentId) ?? null;
  const needRound = sameAsTax && !selRound;
  const saved = st?.saved ?? null;
  const dirty = !saved || saved.transactionDate !== date || saved.dateSource !== (sameAsTax ? 'tax_invoice' : 'manual') || (saved.linkedPaymentId ?? null) !== (sameAsTax ? paymentId : null);
  const writtenDate = dotDate(date);
  const toggleSame = (on: boolean) => {
    setSameAsTax(on); setMsg('');
    if (!on) { setPaymentId(null); return; }
    const r = selRound ?? (rounds.length === 1 ? rounds[0] : null);
    if (r) { setPaymentId(r.id); setDate(r.issueDate); }
  };
  const pickRound = (r: TaxRound) => { setSameAsTax(true); setPaymentId(r.id); setDate(r.issueDate); setMsg(''); };
  const pickDate = (v: string) => { if (!v) return; setDate(v); setSameAsTax(false); setPaymentId(null); setMsg(''); };
  // 저장(변경 시에만) — 성공하면 true. 견적당 1건 upsert, 번호 불변.
  const save = async (): Promise<boolean> => {
    if (!st) return false;
    if (needRound) { setMsg('적용할 세금계산서 발행 회차를 선택해 주세요.'); return false; }
    if (!dirty) return true;
    setSaving(true); setMsg('');
    try {
      const r = await fetch(api(`/api/admin/quotes/${quoteId}/statement`), { method: 'PUT', headers: authJson,
        body: JSON.stringify({ transactionDate: date, dateSource: sameAsTax ? 'tax_invoice' : 'manual', linkedPaymentId: sameAsTax ? paymentId : null, reason: reason.trim() || null }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(j.error || '저장 실패'); return false; }
      applyState(j); setReason(''); setMsg('저장되었습니다.');
      return true;
    } catch { setMsg('저장 실패'); return false; }
    finally { setSaving(false); }
  };

  // ESC·닫기·이동·크기 조절은 공통 팝업(DocPreviewWindow)이 처리

  // 새 창에서 인쇄 → PDF 저장
  const handlePrint = async () => {
    const content = contentRef.current;
    if (!content) return;

    // 문서가 표시된 창(독립 창 또는 본창)에서 인쇄 창을 연다 — 독립 창의 클릭으로 본창 window.open 을 부르면 차단될 수 있다
    const view = content.ownerDocument.defaultView ?? window;
    if (!st || needRound) { setMsg(needRound ? '적용할 세금계산서 발행 회차를 선택해 주세요.' : '거래일자를 불러오는 중입니다.'); return; }
    const printWin = view.open('', '_blank', 'width=900,height=700');
    if (!printWin) {
      const msg = '팝업 차단이 활성화되어 있습니다.\n브라우저 설정에서 팝업을 허용해 주세요.';
      if (view !== window) view.alert(msg);   // 독립 창에서는 그 창에 안내(본창 대화상자는 보이지 않음)
      else void alertDialog({ title: '팝업 차단됨', message: msg, variant: 'warning' });
      return;
    }

    // PDF 파일명 = '[견적서명]_거래명세서' (없으면 명세서번호 기반 fallback). 별도 인쇄창이라 메인 제목 복구 불필요.
    // 호출부가 제목 없을 때 quoteNumber를 넘기므로, 그 경우는 '제목 없음'으로 간주해 fallback을 적용한다.
    const effectiveTitle = quoteTitle && quoteTitle !== data.quoteNumber ? quoteTitle : '';
    const fileName = buildDocFileName(effectiveTitle, { suffix: '거래명세서', fallback: `${statementNo}_거래명세서` });

    // 저장되지 않은 거래일자는 출력하지 않는다 — 출력 전 저장(변경 없으면 그대로). 창은 팝업 차단 회피를 위해 먼저 연다.
    printWin.document.write('<p style="font-family:sans-serif;padding:24px">거래일자 저장 후 출력합니다…</p>');
    if (!(await save())) { printWin.close(); return; }
    printWin.document.open();
    printWin.document.write(buildQuotePrintHtml(fileName, content.innerHTML));
    printWin.document.close();
  };

  const hasItems = data.items.length > 0;
  const hasBankInfo = data.bankAccount.bankName || data.bankAccount.accountNumber;
  const hasSupplierInfo = data.supplier.companyName || data.supplier.businessNumber;

  return (
    <>
      {/* 인쇄 전용 스타일 — 모달 UI 숨김 */}
      <style>{`
        @media print {
          body > *:not(#statement-print-only) { display: none !important; }
          #statement-print-only { display: block !important; }
        }
        #statement-print-only { display: none; }
      `}</style>

      {/* 공통 미리보기 창 — 독립 브라우저 창(팝업 차단·모바일은 화면 내부 팝업으로 대체) */}
      <DocPreviewWindow
        testIdPrefix="statement-preview" closeTestId="btn-statement-close" ariaLabel="거래명세서 미리보기"
        windowTitle={`거래명세서 ${statementNo}`}
        onClose={onClose}
        title="거래명세서 미리보기"
        subtitle={<>{statementNo} · {renderQuoteTitle(quoteTitle)}</>}
        actions={<>
          <SealErrorNotice error={sealError} />
          <button
            onClick={handlePrint}
            disabled={sealUrl === undefined || !st || saving}
            style={{
              padding: '8px 20px', borderRadius: 7, border: 'none',
              background: '#2563eb', color: '#fff',
              fontWeight: 700, fontSize: 13, cursor: sealUrl === undefined ? 'wait' : 'pointer', opacity: sealUrl === undefined ? 0.7 : 1,
            }}
            data-testid="btn-statement-print"
            aria-label="거래명세서 인쇄 / PDF 저장"
          >
            🖨 {dirty ? '저장 후 인쇄 / PDF' : '인쇄 / PDF 저장'}
          </button>
        </>}
      >
        {/* ── 거래명세서 출력 설정(인쇄 영역 밖) — 거래일자·세금계산서 발행일 연동·저장 ── */}
        <div data-testid="ts-settings" style={{ maxWidth: 794, margin: '20px auto 0', padding: '12px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12, color: '#111827' }}>
          <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8 }}>거래명세서 출력 설정</div>
          {loadErr ? <div style={{ color: '#dc2626' }}>{loadErr}</div> : !st ? <div style={{ color: '#6b7280' }}>불러오는 중…</div> : <>
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 8, alignItems: 'center' }}>
              <span style={{ color: '#6b7280' }}>거래명세서 번호</span>
              <span style={{ fontFamily: 'monospace' }} data-testid="ts-set-no">{statementNo}</span>
              <span style={{ color: '#6b7280' }}>거래일자</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <DateField value={date} onChange={pickDate} allowClear={false} testid="ts-date" ariaLabel="거래일자"
                  style={{ width: 150, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12 }} />
                {sameAsTax && selRound && <span style={{ color: '#6b7280' }}>세금계산서 발행일과 동일</span>}
              </span>
              <span style={{ color: '#6b7280' }}>세금계산서 발행일</span>
              <span data-testid="ts-tax-dates">
                {rounds.length === 0 && <span style={{ color: '#6b7280' }}>없음 — 청구정보에 세금계산서 발행일이 없습니다(기본값: 오늘)</span>}
                {rounds.length === 1 && <span>{rounds[0].issueDate} <span style={{ color: '#6b7280' }}>({rounds[0].sequence}회차 · {rounds[0].paymentMethod ?? ''} · {Number(rounds[0].amount).toLocaleString('ko-KR')}원)</span></span>}
                {rounds.length > 1 && <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {rounds.map(r => (
                    <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="radio" name={`ts-round-${quoteId}`} checked={sameAsTax && paymentId === r.id} onChange={() => pickRound(r)}
                        data-testid={`ts-round-${r.sequence}`} aria-label={`${r.sequence}회차 발행일 적용`} />
                      {r.sequence}회차 · {r.issueDate} <span style={{ color: '#6b7280' }}>({r.paymentMethod ?? ''} · {Number(r.amount).toLocaleString('ko-KR')}원)</span>
                    </label>
                  ))}
                  {needRound && <span style={{ color: '#d97706' }}>발행 회차가 여러 개입니다 — 적용할 회차를 선택하거나, 체크를 해제하고 날짜를 직접 선택하세요.</span>}
                </span>}
              </span>
              <span />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: rounds.length ? 'pointer' : 'not-allowed', color: rounds.length ? '#111827' : '#9ca3af' }}>
                <input type="checkbox" checked={sameAsTax} disabled={rounds.length === 0} onChange={e => toggleSame(e.target.checked)}
                  data-testid="ts-same-as-tax" aria-label="세금계산서 발행일과 동일하게 설정" />
                세금계산서 발행일과 동일하게 설정
              </label>
              <span style={{ color: '#6b7280' }}>변경 사유(선택)</span>
              <input value={reason} onChange={e => setReason(e.target.value)} placeholder="예: 거래처 요청 — 세금계산서 발행일로 재발행"
                data-testid="ts-reason" aria-label="거래일자 변경 사유" style={{ padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12 }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => { void save(); }} disabled={saving || !dirty} data-testid="ts-save" aria-label="거래일자 저장"
                style={{ padding: '6px 16px', borderRadius: 6, border: 'none', background: dirty ? '#2563eb' : '#9ca3af', color: '#fff', fontWeight: 700, fontSize: 12, cursor: saving || !dirty ? 'default' : 'pointer' }}>
                {saving ? '저장 중…' : '저장'}</button>
              <span data-testid="ts-save-status" style={{ color: dirty ? '#d97706' : '#059669' }}>
                {dirty ? (saved ? '변경사항 미저장 — 아래 미리보기는 선택한 날짜로 표시됩니다.' : '미저장 — 기본값으로 표시 중(저장 또는 인쇄 시 확정)') : `저장됨 · 거래일자 ${dotDate(saved?.transactionDate)}`}
              </span>
              {saved && <span style={{ color: '#6b7280' }} data-testid="ts-created">문서 생성 {String(saved.createdAt).slice(0, 16).replace('T', ' ')} · 최종 변경 {String(saved.updatedAt).slice(0, 16).replace('T', ' ')}</span>}
              {msg && <span data-testid="ts-msg" style={{ color: /실패|선택/.test(msg) ? '#dc2626' : '#059669' }}>{msg}</span>}
            </div>
          </>}
        </div>
        {/* A4 용지 영역 */}
        <div style={{ padding: '32px 24px', display: 'flex', justifyContent: 'safe center', minWidth: 'fit-content' }}>
          <div
            ref={contentRef}
            id="statement-pdf-content"
            style={{ ...PAGE_STYLE, boxShadow: '0 4px 24px rgba(0,0,0,0.25)' }}
          >
            {/* ── 문서 헤더 ──────────────────────────────────────────────── */}
            <div className="qp-keep qp-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
              {/* 회사명 / 로고 */}
              <div>
                <div style={{ fontSize: 20, fontWeight: 900, color: BRAND, letterSpacing: -0.5 }}>
                  {data.supplier.companyName || 'VERITAS'}
                </div>
                <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>
                  Translation & Interpretation Platform
                </div>
              </div>
              {/* 문서 제목 */}
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 24, fontWeight: 900, color: BRAND, letterSpacing: 4 }}>거 래 명 세 서</div>
                <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace', marginTop: 4 }}>
                  {statementNo}
                </div>
              </div>
            </div>

            {/* 상단 구분선 */}
            <div className="qp-rule" style={{ height: 2, background: BRAND, marginBottom: 18 }} />

            {/* ── 공급자 정보 · 수신자 정보 2컬럼 — 견적서와 같은 항목·순서(PartyRows)·직인 위치 ─────── */}
            <div className="qp-keep qp-gap" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
              <InfoBox title="공급자 정보" aside={sealUrl ? <SealImage src={sealUrl} testId="ts-seal" /> : null}>
                <PartyRows
                  companyName={data.supplier.companyName}
                  businessNumber={data.supplier.businessNumber}
                  representative={data.supplier.ceoName}
                  showContact={false}
                  phone={data.supplier.phone}
                  email={data.supplier.email}
                  address={data.supplier.address}
                />
                {!hasSupplierInfo && (
                  <p style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>설정에서 공급자 정보를 입력해 주세요.</p>
                )}
              </InfoBox>

              {/* 수신자 정보 — 견적서와 같은 수신자(견적에 고정된 고객정보 우선, 없으면 연결 거래처·담당자) */}
              <InfoBox title="수신자 정보">
                <PartyRows
                  companyName={data.customer.brandName ? `${data.customer.companyName} (${data.customer.brandName})` : data.customer.companyName}
                  businessNumber={data.customer.businessNumber}
                  representative={data.customer.representativeName}
                  contactName={data.customer.contactName}
                  phone={data.customer.contactPhone}
                  email={data.customer.contactEmail}
                  address={data.customer.address}
                  omitEmptyContact   /* 담당자·연락처·이메일이 없으면 행 숨김(박스 외곽은 그리드 높이로 공급자 박스와 동일) */
                />
              </InfoBox>
            </div>

            {/* ── 거래 정보 ────────────────────────────────────────────── */}
            <div className="qp-keep qp-gap" style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '10px 14px', marginBottom: 14 }}>
              <div style={{
                fontSize: 10, fontWeight: 800, color: BRAND, letterSpacing: 0.5,
                marginBottom: 8, paddingBottom: 5, borderBottom: `1.5px solid ${BRAND_LIGHT}`,
              }}>
                거래 정보
              </div>
              {/* 3칸 균등 — 칸마다 '항목명 + 간격 + 값'(항목명 줄바꿈 없음), 값 길이가 달라도 칸 안에서 줄바꿈되어 겹치지 않는다 */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '3px 16px', alignItems: 'baseline' }}>
                <DealField label="거래명세서 번호" value={statementNo} mono testId="ts-deal-no" />
                <DealField label="거래일자"        value={writtenDate || '…'} testId="ts-deal-date" />
                <DealField label="견적번호"        value={quoteNo || '-'} mono testId="ts-deal-quote" />
              </div>
            </div>

            {/* ── 총금액 박스 ─────────────────────────────────────────── */}
            <div className="qp-keep qp-gap" style={{
              background: BRAND_LIGHT, borderRadius: 6, padding: '10px 16px',
              marginBottom: 18, display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
            }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600 }}>총 거래금액 (VAT 포함)</div>
                <div style={{ fontSize: 20, fontWeight: 900, color: BRAND }}>
                  ₩{fmt(data.grandTotal)}
                </div>
              </div>
            </div>

            {/* ── 상품 내역 테이블 ─────────────────────────────────────── */}
            {hasItems ? (
              <table className="qp-items" style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 14, fontSize: 11 }}>
                <thead>
                  <tr style={{ background: BRAND }}>
                    {['No', '유형', '상품명', '서비스 상세', '수량', '단위', '단가', '공급가액', '비고'].map((h, i) => (
                      <th key={h} style={{
                        padding: '7px 6px', color: '#fff', fontSize: 10, fontWeight: 700,
                        textAlign: ['상품명', '서비스 상세', '비고'].includes(h) ? 'left' : 'center',
                        whiteSpace: 'nowrap',
                        borderRight: i < 8 ? '1px solid rgba(255,255,255,0.15)' : 'none',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item, idx) => (
                    <tr key={idx} style={{ background: idx % 2 === 1 ? '#f9fafb' : '#fff' }}>
                      <td style={{ padding: '6px', textAlign: 'center', fontSize: 10, color: '#6b7280', borderBottom: '1px solid #f1f5f9', whiteSpace: 'nowrap' }}>
                        {item.index}
                      </td>
                      <td style={{ padding: '6px', textAlign: 'center', fontSize: 10, borderBottom: '1px solid #f1f5f9', whiteSpace: 'nowrap' }}>
                        <ItemTypeBadge type={item.productType} />
                      </td>
                      <td style={{ padding: '6px', borderBottom: '1px solid #f1f5f9', fontWeight: 600, fontSize: 10, wordBreak: 'break-word', maxWidth: 120, minWidth: 80 }}>
                        {item.productName}
                      </td>
                      <td style={{ padding: '6px', borderBottom: '1px solid #f1f5f9', fontSize: 10, whiteSpace: 'pre-line', wordBreak: 'break-word', maxWidth: 200, minWidth: 100, color: '#374151' }}>
                        {item.detailText || '—'}
                      </td>
                      <td style={{ padding: '6px', textAlign: 'center', borderBottom: '1px solid #f1f5f9', fontSize: 10, whiteSpace: 'nowrap' }}>
                        {Number(item.quantity).toLocaleString()}
                      </td>
                      <td style={{ padding: '6px', textAlign: 'center', borderBottom: '1px solid #f1f5f9', fontSize: 10, whiteSpace: 'nowrap' }}>
                        {item.unit}
                      </td>
                      <td style={{ padding: '6px', textAlign: 'right', borderBottom: '1px solid #f1f5f9', fontSize: 10, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        {fmt(item.unitPrice)}
                      </td>
                      <td style={{ padding: '6px', textAlign: 'right', borderBottom: '1px solid #f1f5f9', fontSize: 10, fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: BRAND }}>
                        {fmt(item.supplyAmount)}
                      </td>
                      <td style={{ padding: '6px', borderBottom: '1px solid #f1f5f9', fontSize: 10, color: '#6b7280', wordBreak: 'break-word', maxWidth: 80, minWidth: 50 }}>
                        {item.memo || ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ padding: '24px', textAlign: 'center', color: '#9ca3af', fontSize: 11, border: '1px dashed #e5e7eb', borderRadius: 6, marginBottom: 14 }}>
                거래 품목이 없습니다.
              </div>
            )}

            {/* ── 금액 합계 ────────────────────────────────────────────── */}
            <div className="qp-keep qp-gap" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
              <div style={{ width: 280 }}>
                <SummaryRow label="공급가액 합계" value={`${fmt(data.supplyTotal)}원`} />
                <SummaryRow label={vatSummaryLabel(data.items, data.taxTotal)} value={`${fmt(data.taxTotal)}원`} />
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  padding: '9px 12px', background: BRAND, borderRadius: 6, marginTop: 6,
                }}>
                  <span style={{ color: '#bfdbfe', fontSize: 11, fontWeight: 700 }}>총 거래금액</span>
                  <span style={{ color: '#fff', fontSize: 15, fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>
                    ₩{fmt(data.grandTotal)}
                  </span>
                </div>
              </div>
            </div>

            {/* ── 입금 안내 — 총 거래금액 아래, 상품 테이블과 같은 전체 폭의 가로형 한 줄(은행 | 계좌번호 | 예금주).
                계좌는 환경설정 값 그대로(하드코딩 없음). 값이 없으면 영역 전체를 그리지 않아 빈 공간이 남지 않는다.
                인쇄 시 한 덩어리(qp-keep)로 유지 — 페이지 하단에서 일부만 넘어가지 않는다. 직인은 공급자 정보 박스에만 표시. */}
            {hasBankInfo && (
              <div className="qp-keep qp-footer" data-testid="ts-bank" style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '10px 14px', background: '#fff', marginBottom: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: BRAND, letterSpacing: 0.5, lineHeight: '16px', marginBottom: 4 }}>
                  입금 안내
                </div>
                {/* 항목 3개를 같은 행 높이(16px)·가운데 정렬로 맞추고, 구분선은 글자 대신 세로선(높이 고정)으로 좌우 여백을 같게 둔다 */}
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', rowGap: 2 }}>
                  {[
                    { label: '은행',     value: data.bankAccount.bankName },
                    { label: '계좌번호', value: data.bankAccount.accountNumber, mono: true },
                    { label: '예금주',   value: data.bankAccount.accountHolder },
                  ].filter(f => f.value).map((f, i) => (
                    <span key={f.label} data-testid="ts-bank-field" style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0, lineHeight: '16px' }}>
                      {i > 0 && <span aria-hidden data-testid="ts-bank-sep" style={{ width: 1, height: 10, background: '#d1d5db', margin: '0 14px', flexShrink: 0 }} />}
                      <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, marginRight: 8, whiteSpace: 'nowrap' }}>{f.label}</span>
                      <span style={{ fontSize: f.mono ? 10 : 11, color: '#111827', fontWeight: 500, wordBreak: 'keep-all', overflowWrap: 'break-word', ...(f.mono ? { fontFamily: 'monospace' } : {}) }}>{f.value}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

          </div>{/* /page */}
        </div>
      </DocPreviewWindow>
    </>
  );
}

// 거래 정보 한 칸 — 항목명(줄바꿈 없음) + 10px 간격 + 값. 고정 폭 라벨(InfoRow 70px)보다 긴 '거래명세서 번호'도 값과 붙지 않는다.
function DealField({ label, value, mono, testId }: { label: string; value: string; mono?: boolean; testId: string }) {
  return (
    <div data-testid={testId} style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0, lineHeight: '16px', marginBottom: 2 }}>
      <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: mono ? 10 : 11, color: '#111827', fontWeight: 500, minWidth: 0, overflowWrap: 'anywhere', ...(mono ? { fontFamily: 'monospace' } : {}) }}>{value}</span>
    </div>
  );
}
