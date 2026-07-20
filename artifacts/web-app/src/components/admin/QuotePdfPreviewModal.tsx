/**
 * QuotePdfPreviewModal — 견적서 PDF 미리보기 모달
 *
 * - HTML/CSS A4 템플릿으로 견적서를 렌더링한다.
 * - 인쇄 버튼 클릭 시 브라우저 프린트 대화상자를 열어 PDF 저장이 가능하다.
 * - @media print CSS로 모달 UI를 숨기고 견적서만 출력한다.
 */
import React, { useEffect, useRef } from 'react';
import type { QuotePdfData } from '../../lib/quotePdf';
import { ITEM_TYPE_LABEL, QUOTE_NOTES_BY_SERVICE } from '../../lib/quotePdf';
import { renderQuoteTitle, buildDocFileName, escapeHtmlTitle, formatDocNumber } from '../../lib/quoteTitle';

// ─── 숫자 / 날짜 포맷 ────────────────────────────────────────────────────────
const fmt = (n: number) => n.toLocaleString('ko-KR');
const fmtDate = (d: string) => d.replace(/-/g, '.');
const fmtDateRange = (start: string, end: string) => {
  if (!start) return '';
  return (!end || end === start) ? fmtDate(start) : `${fmtDate(start)} ~ ${fmtDate(end)}`;
};

// ─── 색상 ─────────────────────────────────────────────────────────────────────
const BRAND = '#1e3a5f';
const BRAND_LIGHT = '#e8edf5';

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

interface QuotePdfPreviewModalProps {
  data: QuotePdfData;
  quoteTitle?: string;
  onClose: () => void;
}

export default function QuotePdfPreviewModal({ data, quoteTitle, onClose }: QuotePdfPreviewModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // ESC로 닫기
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // 새 창에서 인쇄 → PDF 저장
  const handlePrint = () => {
    const content = contentRef.current;
    if (!content) return;

    const printWin = window.open('', '_blank', 'width=900,height=700');
    if (!printWin) {
      alert('팝업 차단이 활성화되어 있습니다.\n브라우저 설정에서 팝업을 허용해 주세요.');
      return;
    }

    // PDF 파일명 = 견적서명 (없으면 문서번호 기반 fallback). 별도 인쇄창이라 메인 제목 복구 불필요.
    // 호출부가 제목 없을 때 quoteNumber를 넘기므로, 그 경우는 '제목 없음'으로 간주해 fallback을 적용한다.
    const effectiveTitle = quoteTitle && quoteTitle !== data.quoteNumber ? quoteTitle : '';
    const fileName = buildDocFileName(effectiveTitle, { fallback: `${data.quoteNumber}_견적서` });

    printWin.document.write(`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>${escapeHtmlTitle(fileName)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Apple SD Gothic Neo", "Malgun Gothic", "맑은 고딕", "NanumGothic", sans-serif;
    font-size: 12px;
    color: #1a1a2e;
    line-height: 1.6;
    background: #fff;
  }
  @page {
    size: A4 portrait;
    margin: 15mm 18mm;
  }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
  .page {
    width: 100%;
    padding: 0;
    background: #fff;
  }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; }
  .company-logo { font-size: 22px; font-weight: 900; color: #1e3a5f; letter-spacing: -0.5px; }
  .doc-title { text-align: right; }
  .doc-title h1 { font-size: 26px; font-weight: 900; color: #1e3a5f; letter-spacing: 6px; margin-bottom: 4px; }
  .doc-title .quote-num { font-size: 11px; color: #6b7280; font-family: monospace; }
  .divider { height: 2px; background: #1e3a5f; margin-bottom: 20px; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 14px; }
  .info-box { border: 1px solid #d1d5db; border-radius: 6px; padding: 12px 14px; }
  .info-box-title { font-size: 10px; font-weight: 800; color: #1e3a5f; letter-spacing: 1px; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1.5px solid #e8edf5; }
  .info-row { display: flex; align-items: baseline; margin-bottom: 3px; }
  .info-key { font-size: 10px; color: #6b7280; font-weight: 600; min-width: 76px; flex-shrink: 0; }
  .info-val { font-size: 11px; color: #111827; font-weight: 500; min-width: 0; white-space: normal; word-break: keep-all; overflow-wrap: break-word; }
  .quote-info-box { border: 1px solid #d1d5db; border-radius: 6px; padding: 10px 14px; margin-bottom: 14px; }
  .quote-info-inner { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 16px; }
  .total-box { background: #e8edf5; border-radius: 6px; padding: 10px 16px; margin-bottom: 20px; display: flex; justify-content: flex-end; align-items: center; }
  .total-box-right { font-size: 18px; font-weight: 900; color: #1e3a5f; }
  .total-box-right .label { font-size: 10px; font-weight: 600; color: #6b7280; display: block; text-align: right; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th { background: #1e3a5f; color: #fff; font-size: 10px; font-weight: 700; padding: 7px 6px; text-align: center; white-space: nowrap; }
  th.left { text-align: left; }
  td { font-size: 10px; padding: 6px 6px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  td.center { text-align: center; }
  td.right { text-align: right; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.detail { white-space: pre-line; word-break: break-word; max-width: 200px; }
  td.name { word-break: break-word; max-width: 120px; font-weight: 600; }
  tr:nth-child(even) td { background: #f9fafb; }
  .summary { margin-left: auto; width: 260px; }
  .summary-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 11px; border-bottom: 1px solid #f1f5f9; }
  .summary-row .sk { color: #6b7280; font-weight: 600; }
  .summary-row .sv { color: #111827; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
  .summary-total { display: flex; justify-content: space-between; padding: 8px 12px; background: #1e3a5f; border-radius: 6px; margin-top: 6px; }
  .summary-total .sk { color: #bfdbfe; font-size: 11px; font-weight: 700; }
  .summary-total .sv { color: #fff; font-size: 14px; font-weight: 900; font-variant-numeric: tabular-nums; }
  .footer { margin-top: 28px; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .footer-box { border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 14px; }
  .footer-box-title { font-size: 10px; font-weight: 800; color: #1e3a5f; letter-spacing: 0.5px; margin-bottom: 8px; }
  .footer-note { font-size: 10px; color: #374151; white-space: pre-line; line-height: 1.7; }
  .signature-area { display: flex; justify-content: flex-end; margin-top: 24px; }
  .signature-box { text-align: center; min-width: 100px; }
  .signature-label { font-size: 10px; color: #6b7280; margin-bottom: 4px; }
  .signature-img { width: 80px; height: 80px; object-fit: contain; }
  .signature-placeholder { width: 80px; height: 80px; border: 1px dashed #d1d5db; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; color: #9ca3af; border-radius: 4px; }
</style>
</head>
<body>
<div class="page">
  ${content.innerHTML}
</div>
<script>window.onload = function() { window.print(); }<\/script>
</body>
</html>`);
    printWin.document.close();
  };

  const hasItems = data.items.length > 0;
  const hasBankInfo = data.bankAccount.bankName || data.bankAccount.accountNumber;
  const hasSupplierInfo = data.supplier.companyName || data.supplier.businessNumber;
  const hasCustomer = !!(data.customer.companyName || data.customer.contactName);

  // 안내문: 설정값 우선, 없으면 서비스 유형별 기본값
  const defaultNotes = QUOTE_NOTES_BY_SERVICE[data.serviceType] ?? QUOTE_NOTES_BY_SERVICE['mixed'];
  const notesText = data.quoteNotes || defaultNotes;

  return (
    <>
      {/* 인쇄 전용 스타일 — 모달 UI 숨김 */}
      <style>{`
        @media print {
          body > *:not(#quote-print-only) { display: none !important; }
          #quote-print-only { display: block !important; }
        }
        #quote-print-only { display: none; }
      `}</style>

      {/* 오버레이 */}
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 2000,
          background: 'rgba(15,23,42,0.6)',
          display: 'flex', flexDirection: 'column',
          overflowY: 'auto',
        }}
        onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      >
        {/* 툴바 */}
        <div style={{
          position: 'sticky', top: 0, zIndex: 10,
          background: '#1e293b', padding: '12px 24px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>
              견적서 미리보기
            </span>
            <span style={{ color: '#94a3b8', fontSize: 12 }}>
              {(formatDocNumber('Q', data.quoteNumber, data.quoteDate) || data.quoteNumber)} · {renderQuoteTitle(quoteTitle)}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handlePrint}
              style={{
                padding: '8px 20px', borderRadius: 7, border: 'none',
                background: '#2563eb', color: '#fff',
                fontWeight: 700, fontSize: 13, cursor: 'pointer',
              }}
              data-testid="btn-pdf-print"
              aria-label="PDF 다운로드 (인쇄)"
            >
              🖨 인쇄 / PDF 저장
            </button>
            <button
              onClick={onClose}
              style={{
                padding: '8px 16px', borderRadius: 7, border: '1px solid #475569',
                background: 'transparent', color: '#cbd5e1',
                fontWeight: 600, fontSize: 13, cursor: 'pointer',
              }}
              data-testid="btn-pdf-close"
              aria-label="미리보기 닫기"
            >
              닫기
            </button>
          </div>
        </div>

        {/* A4 용지 영역 */}
        <div style={{ flex: 1, padding: '32px 24px', display: 'flex', justifyContent: 'center' }}>
          <div
            ref={contentRef}
            id="quote-pdf-content"
            style={{ ...PAGE_STYLE, boxShadow: '0 4px 24px rgba(0,0,0,0.25)' }}
          >
            {/* ── 문서 헤더 ──────────────────────────────────────────────── */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
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
                <div style={{ fontSize: 26, fontWeight: 900, color: BRAND, letterSpacing: 6 }}>견  적  서</div>
                <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace', marginTop: 4 }}>
                  {/* 우측 상단도 견적정보와 동일한 공식 견적번호(formatDocNumber) 사용 — 문서 내 번호 통일 */}
                  {formatDocNumber('Q', data.quoteNumber, data.quoteDate) || data.quoteNumber}
                </div>
              </div>
            </div>

            {/* 상단 구분선 */}
            <div style={{ height: 2, background: BRAND, marginBottom: 18 }} />

            {/* ── 공급자 정보 · 수신자 정보 2컬럼 ────────────────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
              {/* 공급자 정보 */}
              <InfoBox title="공급자 정보">
                {hasSupplierInfo ? (
                  <>
                    {data.supplier.companyName    && <InfoRow label="상호"       value={data.supplier.companyName} />}
                    {data.supplier.businessNumber && <InfoRow label="사업자번호" value={data.supplier.businessNumber} />}
                    {data.supplier.ceoName        && <InfoRow label="대표자"     value={data.supplier.ceoName} />}
                    {data.supplier.address        && <InfoRow label="주소"       value={data.supplier.address} />}
                    {data.supplier.phone          && <InfoRow label="전화"       value={data.supplier.phone} />}
                    {data.supplier.email          && <InfoRow label="이메일"     value={data.supplier.email} />}
                  </>
                ) : (
                  <p style={{ fontSize: 10, color: '#9ca3af' }}>설정에서 공급자 정보를 입력해 주세요.</p>
                )}
              </InfoBox>

              {/* 수신자 정보 */}
              <InfoBox title="수신자 정보">
                {!hasCustomer ? (
                  <p style={{ fontSize: 11, color: '#9ca3af' }}>수신자 정보 미입력</p>
                ) : (
                  <>
                    <InfoRow label="상호"     value={data.customer.companyName        || '-'} />
                    {data.customer.brandName && <InfoRow label="브랜드"   value={data.customer.brandName} />}
                    <InfoRow label="대표자"   value={data.customer.representativeName || '-'} />
                    <InfoRow label="담당자"   value={data.customer.contactName        || '-'} />
                    <InfoRow label="연락처"   value={data.customer.contactPhone       || '-'} />
                    <InfoRow label="이메일"   value={data.customer.contactEmail       || '-'} />
                  </>
                )}
              </InfoBox>
            </div>

            {/* ── 견적 정보 (별도 영역) ────────────────────────────────── */}
            <div style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '10px 14px', marginBottom: 14 }}>
              <div style={{
                fontSize: 10, fontWeight: 800, color: BRAND, letterSpacing: 0.5,
                marginBottom: 8, paddingBottom: 5, borderBottom: `1.5px solid ${BRAND_LIGHT}`,
              }}>
                견적 정보
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '3px 16px' }}>
                {/* 견적번호 — 문서 전체(우측 상단·견적정보·미리보기 툴바)가 동일한 플랫폼 공식 문서번호
                    (formatDocNumber: Q+YYMMDD-순번, 견적목록·휴지통과 동일 체계)로 통일. 생성 로직·DB 불변. */}
                <InfoRow label="견적번호"  value={formatDocNumber('Q', data.quoteNumber, data.quoteDate) || data.quoteNumber} mono />
                {data.quoteDate  && <InfoRow label="견적일"    value={data.quoteDate} />}
                {data.quoteType  && <InfoRow label="견적유형"  value={data.quoteType} />}
                {data.manager    && <InfoRow label="담당 PM"   value={data.manager} />}
              </div>
            </div>

            {/* ── 총금액 박스 ─────────────────────────────────────────── */}
            <div style={{
              background: BRAND_LIGHT, borderRadius: 6, padding: '10px 16px',
              marginBottom: 18, display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
            }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600 }}>총 견적금액 (VAT 포함)</div>
                <div style={{ fontSize: 20, fontWeight: 900, color: BRAND }}>
                  ₩{fmt(data.grandTotal)}
                </div>
              </div>
            </div>

            {/* ── 품목 테이블 ──────────────────────────────────────────── */}
            {hasItems ? (
              <table style={{
                width: '100%', borderCollapse: 'collapse', marginBottom: 14,
                fontSize: 11,
              }}>
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
                견적 품목이 없습니다.
              </div>
            )}

            {/* ── 금액 합계 ────────────────────────────────────────────── */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
              <div style={{ width: 280 }}>
                <SummaryRow label="공급가액 합계" value={`${fmt(data.supplyTotal)}원`} />
                <SummaryRow label="부가세 (10%)" value={`${fmt(data.taxTotal)}원`} />
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  padding: '9px 12px', background: BRAND, borderRadius: 6, marginTop: 6,
                }}>
                  <span style={{ color: '#bfdbfe', fontSize: 11, fontWeight: 700 }}>총 견적금액</span>
                  <span style={{ color: '#fff', fontSize: 15, fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>
                    ₩{fmt(data.grandTotal)}
                  </span>
                </div>
              </div>
            </div>

            {/* ── 비고 ─────────────────────────────────────────────────── */}
            {data.note && (
              <div style={{ marginBottom: 16, padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#92400e', marginBottom: 4 }}>비고</div>
                <div style={{ fontSize: 11, color: '#374151', whiteSpace: 'pre-line' }}>{data.note}</div>
              </div>
            )}

            {/* ── 하단 정보 (좌: 입금 계좌 / 우: 견적 조건 + 직인) ─────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
              {/* 입금 계좌 — 좌측 */}
              {hasBankInfo && (
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '12px 14px' }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: BRAND, letterSpacing: 0.5, marginBottom: 8 }}>
                    입금 계좌
                  </div>
                  {data.bankAccount.bankName      && <InfoRow label="은행"     value={data.bankAccount.bankName} />}
                  {data.bankAccount.accountNumber && <InfoRow label="계좌번호" value={data.bankAccount.accountNumber} mono />}
                  {data.bankAccount.accountHolder && <InfoRow label="예금주"   value={data.bankAccount.accountHolder} />}
                </div>
              )}

              {/* 견적 조건 (서비스 유형별) — 우측. 직인을 박스 내부 우측 하단에 포함(공식 발행 인증) */}
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '12px 14px', display: 'flex', flexDirection: 'column' }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: BRAND, letterSpacing: 0.5, marginBottom: 8 }}>
                  견적 조건
                </div>
                <div style={{ fontSize: 10, color: '#374151', lineHeight: 1.8, whiteSpace: 'pre-line' }}>
                  {notesText}
                </div>
                {/* 직인 — 견적 조건 문구 아래 충분한 여백 후 박스 내부 우측 하단. 견적서 전체의 공식 발행을 의미. */}
                <div style={{ marginTop: 'auto', paddingTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 6 }}>
                      {data.supplier.companyName || 'VERITAS'} (인)
                    </div>
                    {data.signatureImageUrl ? (
                      <img
                        src={data.signatureImageUrl}
                        alt="직인"
                        style={{ width: 80, height: 80, objectFit: 'contain', border: '1px solid #f0f0f0', borderRadius: 4 }}
                      />
                    ) : (
                      <div style={{
                        width: 80, height: 80, border: '1px dashed #d1d5db',
                        borderRadius: 4, display: 'flex', alignItems: 'center',
                        justifyContent: 'center', fontSize: 9, color: '#9ca3af',
                      }}>
                        직인
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

          </div>{/* /page */}
        </div>
      </div>
    </>
  );
}

// ─── 서브 컴포넌트 ────────────────────────────────────────────────────────────

function InfoBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '10px 12px' }}>
      <div style={{
        fontSize: 10, fontWeight: 800, color: BRAND, letterSpacing: 0.5,
        marginBottom: 7, paddingBottom: 5, borderBottom: `1.5px solid ${BRAND_LIGHT}`,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 2 }}>
      <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, minWidth: 70, flexShrink: 0 }}>
        {label}
      </span>
      <span style={{
        fontSize: 11, color: '#111827', fontWeight: 500,
        // 인쇄 시 주소·숫자 단위(예: "2406호")가 중간에서 끊기지 않도록:
        // keep-all → 공백 단위로만 줄바꿈(동·호 등 토큰 유지), break-word → 박스 초과 시에만 예외 처리.
        // (break-all 금지 — 숫자 중간 분리의 원인. 지시문 §3·§4)
        minWidth: 0,
        whiteSpace: 'normal',
        wordBreak: 'keep-all',
        overflowWrap: 'break-word',
        ...(mono ? { fontFamily: 'monospace', fontSize: 10 } : {}),
      }}>
        {value}
      </span>
    </div>
  );
}

// 수신자 정보 내 서비스 구분선 (복합 견적 시 [번역] / [통역] 라벨 포함)
function SvcDivider({ label }: { label?: string }) {
  return label
    ? <div style={{ fontSize: 9, fontWeight: 800, color: BRAND, letterSpacing: 0.3, margin: '6px 0 3px' }}>[{label}]</div>
    : <div style={{ height: 1, background: '#e5e7eb', margin: '7px 0 4px' }} />;
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 11, borderBottom: '1px solid #f1f5f9' }}>
      <span style={{ color: '#6b7280', fontWeight: 600 }}>{label}</span>
      <span style={{ color: '#111827', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function ItemTypeBadge({ type }: { type: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    translation:    { bg: '#dbeafe', color: '#1d4ed8' },
    interpretation: { bg: '#dcfce7', color: '#15803d' },
    equipment:      { bg: '#fef3c7', color: '#b45309' },
    expense:        { bg: '#f3f4f6', color: '#6b7280' },
  };
  const c = colors[type] ?? colors.expense;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 5px', borderRadius: 4,
      background: c.bg, color: c.color, fontSize: 9, fontWeight: 700,
    }}>
      {ITEM_TYPE_LABEL[type] ?? type}
    </span>
  );
}
