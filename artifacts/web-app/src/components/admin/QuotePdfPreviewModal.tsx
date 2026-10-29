/**
 * QuotePdfPreviewModal — 견적서 PDF 미리보기 모달
 *
 * - HTML/CSS A4 템플릿으로 견적서를 렌더링한다.
 * - 인쇄 버튼 클릭 시 브라우저 프린트 대화상자를 열어 PDF 저장이 가능하다.
 * - @media print CSS로 모달 UI를 숨기고 견적서만 출력한다.
 */
import React, { useEffect, useRef } from 'react';
import type { QuotePdfData } from '../../lib/quotePdf';
import { QUOTE_NOTES_BY_SERVICE, vatSummaryLabel } from '../../lib/quotePdf';
import { renderQuoteTitle, buildDocFileName, formatDocNumber } from '../../lib/quoteTitle';
import { formatDisplayDate, formatScheduleRange } from '../../lib/dateFormat';
import { alertDialog } from '../ui';
import { buildQuotePrintHtml } from '../../lib/quotePrintHtml';
import { buildQuoteNotices, type NoticeSection, type NoticeRate } from '../../lib/quoteNotices';
import { BRAND, BRAND_LIGHT, useCompanySeal, SealImage, SealErrorNotice, InfoBox, PartyRows, InfoRow, SummaryRow, ItemTypeBadge } from './docParts';

// ─── 숫자 / 날짜 포맷 ────────────────────────────────────────────────────────
const fmt = (n: number) => n.toLocaleString('ko-KR');
const fmtDate = (d: string) => formatDisplayDate(d);
const fmtDateRange = (start: string, end: string) => formatScheduleRange(start, end);

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
  // 회사 직인 — 서버가 권한 확인 후 data URI 로 내려준다(R2 원본 URL 미노출). 미등록·표시 안 함·오류면 직인 없이 출력.
  //   undefined = 불러오는 중(인쇄 버튼 잠시 대기 — 직인 없이 인쇄되는 것 방지)
  const { url: sealUrl, error: sealError } = useCompanySeal();

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
      void alertDialog({ title: '팝업 차단됨', message: '팝업 차단이 활성화되어 있습니다.\n브라우저 설정에서 팝업을 허용해 주세요.', variant: 'warning' });
      return;
    }

    // PDF 파일명 = 견적서명 (없으면 문서번호 기반 fallback). 별도 인쇄창이라 메인 제목 복구 불필요.
    // 호출부가 제목 없을 때 quoteNumber를 넘기므로, 그 경우는 '제목 없음'으로 간주해 fallback을 적용한다.
    const effectiveTitle = quoteTitle && quoteTitle !== data.quoteNumber ? quoteTitle : '';
    const fileName = buildDocFileName(effectiveTitle, { fallback: `${data.quoteNumber}_견적서` });

    printWin.document.write(buildQuotePrintHtml(fileName, content.innerHTML));
    printWin.document.close();
  };

  const hasItems = data.items.length > 0;
  const hasBankInfo = data.bankAccount.bankName || data.bankAccount.accountNumber;
  const hasSupplierInfo = data.supplier.companyName || data.supplier.businessNumber;

  // 안내문: 설정값 우선, 없으면 서비스 유형별 기본값
  const defaultNotes = QUOTE_NOTES_BY_SERVICE[data.serviceType] ?? QUOTE_NOTES_BY_SERVICE['mixed'];
  const notesText = data.quoteNotes || defaultNotes;
  // 안내말씀 — 품목 서비스 유형별 고지사항(발행일 기준 템플릿 버전). 통역·번역·장비 품목이 없으면 null(미표시)
  const notices = buildQuoteNotices(data.items, data.quoteDate);

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
            <SealErrorNotice error={sealError} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handlePrint}
              disabled={sealUrl === undefined}
              style={{
                padding: '8px 20px', borderRadius: 7, border: 'none',
                background: '#2563eb', color: '#fff',
                fontWeight: 700, fontSize: 13, cursor: sealUrl === undefined ? 'wait' : 'pointer', opacity: sealUrl === undefined ? 0.7 : 1,
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
                <div style={{ fontSize: 26, fontWeight: 900, color: BRAND, letterSpacing: 6 }}>견  적  서</div>
                <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace', marginTop: 4 }}>
                  {/* 우측 상단도 견적정보와 동일한 공식 견적번호(formatDocNumber) 사용 — 문서 내 번호 통일 */}
                  {formatDocNumber('Q', data.quoteNumber, data.quoteDate) || data.quoteNumber}
                </div>
              </div>
            </div>

            {/* 상단 구분선 */}
            <div className="qp-rule" style={{ height: 2, background: BRAND, marginBottom: 18 }} />

            {/* ── 공급자 정보 · 수신자 정보 2컬럼 ────────────────────── */}
            <div className="qp-keep qp-gap" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
              {/* 공급자 정보 */}
              {/* 공급자·수신자 공통 항목·순서(PartyRows). 값이 없으면 행은 유지하고 공란 — 임의 값으로 채우지 않는다.
                  공급자: 상호→사업자번호→대표자→연락처→이메일→주소 / 수신자: 상호→사업자번호→대표자→담당자→연락처→이메일→주소
                  두 박스는 그리드 셀 높이(stretch)를 공유하므로 행 수가 달라도 박스 높이는 같다. */}
              <InfoBox title="공급자 정보" aside={sealUrl ? (
                /* 직인 — 상호 행 오른쪽(박스 우측). 절대 위치라 박스 높이를 늘리지 않고, 짧은 값(상호·사업자번호·대표자) 오른쪽 빈 공간에 놓인다.
                   첫 페이지 상단 블록에만 있으므로 여러 페이지 견적서에서도 한 번만 출력된다. */
                <SealImage src={sealUrl} testId="qp-seal" />
              ) : null}>
                <PartyRows
                  companyName={data.supplier.companyName}
                  businessNumber={data.supplier.businessNumber}
                  representative={data.supplier.ceoName}
                  showContact={false}   /* 공급자 박스는 담당자 행을 출력하지 않음(데이터는 그대로) */
                  phone={data.supplier.phone}
                  email={data.supplier.email}
                  address={data.supplier.address}
                />
                {!hasSupplierInfo && (
                  <p style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>설정에서 공급자 정보를 입력해 주세요.</p>
                )}
              </InfoBox>

              {/* 수신자 정보 — 사업자번호·대표자·주소는 연결 거래처 Master, 없으면 공란 */}
              <InfoBox title="수신자 정보">
                <PartyRows
                  companyName={data.customer.brandName ? `${data.customer.companyName} (${data.customer.brandName})` : data.customer.companyName}
                  businessNumber={data.customer.businessNumber}
                  representative={data.customer.representativeName}
                  contactName={data.customer.contactName}
                  phone={data.customer.contactPhone}
                  email={data.customer.contactEmail}
                  address={data.customer.address}
                />
              </InfoBox>
            </div>

            {/* ── 견적 정보 (별도 영역) ────────────────────────────────── */}
            <div className="qp-keep qp-gap" style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '10px 14px', marginBottom: 14 }}>
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
                {data.quoteDate  && <InfoRow label="견적일"    value={fmtDate(data.quoteDate)} />}
                {data.quoteType  && <InfoRow label="견적유형"  value={data.quoteType} />}
                {data.manager    && <InfoRow label="담당 PM"   value={data.manager} />}
              </div>
            </div>

            {/* ── 총금액 박스 ─────────────────────────────────────────── */}
            <div className="qp-keep qp-gap" style={{
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

            {/* ── 품목 테이블 + 금액 합계 (일반/누적 견적서 전용) ─────────── */}
            {!data.prepaid && (<>
            {hasItems ? (
              <table className="qp-items" style={{
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
            <div className="qp-keep qp-gap" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
              <div style={{ width: 280 }}>
                <SummaryRow label="공급가액 합계" value={`${fmt(data.supplyTotal)}원`} />
                <SummaryRow label={vatSummaryLabel(data.items, data.taxTotal)} value={`${fmt(data.taxTotal)}원`} />
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

            </>)}

            {/* ── 차감 견적서 전용: 선입금/이월 → 진행 및 차감내역 → 차감 잔액 ── */}
            {data.prepaid && (() => {
              const p = data.prepaid;
              const hdrStyle: React.CSSProperties = {
                fontSize: 12, fontWeight: 800, color: BRAND, letterSpacing: 0.5,
                marginBottom: 8, paddingBottom: 5, borderBottom: `1.5px solid ${BRAND_LIGHT}`,
              };
              const th = (h: string, align: 'left' | 'center' | 'right', last: boolean): React.CSSProperties => ({
                padding: '7px 6px', color: '#fff', fontSize: 10, fontWeight: 700,
                textAlign: align, whiteSpace: 'nowrap', borderRight: last ? 'none' : '1px solid rgba(255,255,255,0.15)',
              });
              const bd = '1px solid #f1f5f9';
              return (
                <>
                  {/* [선입금 / 이월 내역] — 언제 얼마를 선입/이월했는지 */}
                  <div className="qp-heading" style={hdrStyle}>선입금 / 이월 내역</div>
                  {p.lines.length > 0 ? (
                    <table className="qp-items" style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 18, fontSize: 11 }}>
                      <thead>
                        <tr style={{ background: BRAND }}>
                          <th style={th(p.dateLabel, 'center', false)}>{p.dateLabel}</th>
                          <th style={th('구분', 'center', false)}>구분</th>
                          <th style={th('금액', 'right', false)}>금액</th>
                          <th style={th('비고', 'left', true)}>비고</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.lines.map((l, idx) => (
                          <tr key={idx} style={{ background: idx % 2 === 1 ? '#f9fafb' : '#fff' }}>
                            <td style={{ padding: '6px', textAlign: 'center', fontSize: 10, borderBottom: bd, whiteSpace: 'nowrap' }}>{l.date || '-'}</td>
                            <td style={{ padding: '6px', textAlign: 'center', fontSize: 10, borderBottom: bd, whiteSpace: 'nowrap', fontWeight: 600 }}>{l.typeLabel}</td>
                            <td style={{ padding: '6px', textAlign: 'right', fontSize: 10, fontWeight: 700, borderBottom: bd, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: BRAND }}>{fmt(l.amount)}원</td>
                            <td style={{ padding: '6px', fontSize: 10, borderBottom: bd, color: '#6b7280', wordBreak: 'break-word' }}>{l.note || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div style={{ padding: '16px', textAlign: 'center', color: '#9ca3af', fontSize: 11, border: '1px dashed #e5e7eb', borderRadius: 6, marginBottom: 18 }}>선입/이월 내역이 없습니다.</div>
                  )}

                  {/* [진행 및 차감내역] — 언제 어떤 업무를 진행했고 얼마가 차감되는지 */}
                  <div className="qp-heading" style={hdrStyle}>진행 및 차감내역</div>
                  <table className="qp-items" style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 18, fontSize: 11 }}>
                    <thead>
                      <tr style={{ background: BRAND }}>
                        <th style={th('일자', 'center', false)}>일자</th>
                        <th style={th('유형', 'center', false)}>유형</th>
                        <th style={th('상품명', 'left', false)}>상품명</th>
                        <th style={th('서비스 상세', 'left', false)}>서비스 상세</th>
                        <th style={th('수량', 'center', false)}>수량</th>
                        <th style={th('단위', 'center', false)}>단위</th>
                        <th style={th('단가', 'right', false)}>단가</th>
                        <th style={th('공급가액', 'right', false)}>공급가액</th>
                        <th style={th('차감액', 'right', true)}>차감액</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((item, idx) => (
                        <tr key={idx} style={{ background: idx % 2 === 1 ? '#f9fafb' : '#fff' }}>
                          <td style={{ padding: '6px', textAlign: 'center', fontSize: 9, borderBottom: bd, whiteSpace: 'normal', wordBreak: 'keep-all', color: '#374151', minWidth: 62, maxWidth: 74 }}>{item.serviceDate || '-'}</td>
                          <td style={{ padding: '6px', textAlign: 'center', fontSize: 10, borderBottom: bd, whiteSpace: 'nowrap' }}><ItemTypeBadge type={item.productType} /></td>
                          <td style={{ padding: '6px', borderBottom: bd, fontWeight: 600, fontSize: 10, wordBreak: 'break-word', maxWidth: 96, minWidth: 70 }}>{item.productName}</td>
                          <td style={{ padding: '6px', borderBottom: bd, fontSize: 10, whiteSpace: 'pre-line', wordBreak: 'break-word', maxWidth: 170, minWidth: 90, color: '#374151' }}>{item.detailText || '—'}</td>
                          <td style={{ padding: '6px', textAlign: 'center', borderBottom: bd, fontSize: 10, whiteSpace: 'nowrap' }}>{Number(item.quantity).toLocaleString()}</td>
                          <td style={{ padding: '6px', textAlign: 'center', borderBottom: bd, fontSize: 10, whiteSpace: 'nowrap' }}>{item.unit}</td>
                          <td style={{ padding: '6px', textAlign: 'right', borderBottom: bd, fontSize: 10, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmt(item.unitPrice)}</td>
                          <td style={{ padding: '6px', textAlign: 'right', borderBottom: bd, fontSize: 10, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: '#374151' }}>{fmt(item.supplyAmount)}</td>
                          <td style={{ padding: '6px', textAlign: 'right', borderBottom: bd, fontSize: 10, fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: BRAND }}>{fmt(item.totalAmount)}원</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: BRAND_LIGHT }}>
                        <td colSpan={7} style={{ padding: '7px 6px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: BRAND }}>합계</td>
                        <td style={{ padding: '7px 6px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: '#374151', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmt(data.supplyTotal)}</td>
                        <td style={{ padding: '7px 6px', textAlign: 'right', fontSize: 11, fontWeight: 900, color: BRAND, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmt(data.grandTotal)}원</td>
                      </tr>
                    </tfoot>
                  </table>

                  {/* [차감 잔액] — 최종적으로 얼마가 남았는지 */}
                  <div className="qp-heading" style={hdrStyle}>차감 잔액</div>
                  <div className="qp-keep qp-gap" style={{ display: 'flex', justifyContent: 'flex-end', pageBreakInside: 'avoid', marginBottom: 20 }}>
                    <div style={{ width: 300 }}>
                      <PrepaidSummaryRow label="이전 가용잔액"     value={`${fmt(p.previousAvailable)}원`} />
                      <PrepaidSummaryRow label="이번 선입/이월액"   value={`${fmt(p.incoming)}원`} />
                      {/* 총 가용잔액: 이전 가용잔액과 이번 선입/이월이 모두 있을 때만 표시(재선입 사례) */}
                      {p.previousAvailable > 0 && p.incoming > 0 && (
                        <PrepaidSummaryRow label="총 가용잔액"       value={`${fmt(p.totalAvailable)}원`} strong />
                      )}
                      <PrepaidSummaryRow label="이번 총 차감액"     value={`-${fmt(p.appliedDeduction)}원`} accent="#dc2626" />
                      <PrepaidSummaryRow label="추가 청구액"       value={`${fmt(p.additionalCharge)}원`} accent={p.additionalCharge > 0 ? '#dc2626' : undefined} />
                      <div style={{
                        display: 'flex', justifyContent: 'space-between',
                        padding: '9px 12px', background: BRAND, borderRadius: 6, marginTop: 6,
                      }}>
                        <span style={{ color: '#bfdbfe', fontSize: 11, fontWeight: 700 }}>차감 후 예상잔액</span>
                        <span style={{ color: '#fff', fontSize: 15, fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>₩{fmt(p.remainingAfter)}</span>
                      </div>
                      <div style={{ marginTop: 6, fontSize: 9, color: '#9ca3af', textAlign: 'right' }}>
                        ※ 발행 당시 기준 예상잔액입니다. (판매전환 확정 시 실제 잔액에 반영)
                      </div>
                    </div>
                  </div>
                </>
              );
            })()}

            {/* ── 비고 ─────────────────────────────────────────────────── */}
            {data.note && (
              <div className="qp-note qp-gap" style={{ marginBottom: 16, padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#92400e', marginBottom: 4 }}>비고</div>
                <div style={{ fontSize: 11, color: '#374151', whiteSpace: 'pre-line' }}>{data.note}</div>
              </div>
            )}

            {/* ── 안내말씀 (공통 운영조건 + 서비스별 고지사항) ─────────────
                비고(프로젝트별 요청)·견적 조건(유효기간·문의)과 겹치지 않는 고정 고지. 금액에 합산하지 않는다. */}
            {/* 인쇄: 연속 배치 — 안내말씀은 앞 영역이 끝난 자리에서 시작해 조항 단위로 페이지를 넘긴다(전체를 한 덩어리로 묶지 않음).
                하단 정보(입금 계좌·견적 조건)만 한 덩어리로 유지한다. */}
            <div className="qp-tail">
            {notices && (
              <div className="qp-gap qp-notice" data-notice-version={notices.version} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '12px 14px', marginBottom: 14 }}>
                <div className="qp-heading" style={{
                  fontSize: 10, fontWeight: 800, color: BRAND, letterSpacing: 0.5,
                  marginBottom: 8, paddingBottom: 5, borderBottom: `1.5px solid ${BRAND_LIGHT}`,
                }}>
                  안내말씀
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 18px' }}>
                  {notices.sections.map(sec => <NoticeBlock key={sec.key} section={sec} />)}
                </div>
              </div>
            )}

            {/* ── 하단 정보 (좌: 입금 계좌 / 우: 견적 조건) ─────────── */}
            <div className="qp-keep qp-footer" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
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

              {/* 견적 조건 (서비스 유형별) — 우측. (직인은 첫 페이지 공급자 정보 박스로 이동) */}
              <div className="qp-cond" style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '12px 14px', display: 'flex', flexDirection: 'column' }}>
                <div className="qp-cond-title" style={{ fontSize: 10, fontWeight: 800, color: BRAND, letterSpacing: 0.5, marginBottom: 8 }}>
                  견적 조건
                </div>
                <div style={{ fontSize: 10, color: '#374151', lineHeight: 1.8, whiteSpace: 'pre-line' }}>
                  {notesText}
                </div>
              </div>
            </div>

            </div>{/* /qp-tail */}

          </div>{/* /page */}
        </div>
      </div>
    </>
  );
}

// ─── 서브 컴포넌트 ────────────────────────────────────────────────────────────

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];

// 안내말씀 소제목 + 본문 한 단위(인쇄 시 중간 분리 없음)
function NoticeBlock({ section }: { section: NoticeSection }) {
  const text: React.CSSProperties = { fontSize: 10, color: '#374151', lineHeight: 1.65, wordBreak: 'keep-all', overflowWrap: 'break-word' };
  const numbered = (t: string, n: number, key: React.Key) => (
    <div key={key} className="qp-keep" style={{ ...text, display: 'flex', gap: 3 }}>
      <span style={{ flexShrink: 0 }}>{CIRCLED[n] ?? `${n + 1}.`}</span><span>{t}</span>
    </div>
  );
  const rateTable = (rates: NoticeRate[], key: React.Key) => (
    <div key={key} className="qp-keep" style={{ margin: '4px 0', border: '1px solid #e5e7eb', borderRadius: 4, overflow: 'hidden' }}>
      {rates.map((r, i) => (
        <div key={i} style={{
          display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 8px', fontSize: 10, lineHeight: 1.6,
          background: i % 2 === 1 ? '#f9fafb' : '#fff', borderTop: i ? '1px solid #f1f5f9' : 'none',
        }}>
          <span style={{ color: '#374151' }}>{r.label}</span>
          <span style={{ color: BRAND, whiteSpace: 'nowrap' }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
  return (
    // 인쇄 분할 단위: 소제목은 첫 조항과 붙여 두고(qp-heading), 조항·문단·요율표는 각각 중간에서 자르지 않는다(qp-keep)
    <div data-notice={section.key}>
      <div className="qp-heading" style={{ fontSize: 10, fontWeight: 700, color: BRAND, marginBottom: 3 }}>[{section.title}]</div>
      {section.items?.map((t, i) => numbered(t, i, i))}
      {section.intro?.map((t, i) => <div key={i} className="qp-keep" style={text}>{t}</div>)}
      {section.rates && rateTable(section.rates, 'rates')}
      {section.outro?.map((t, i) => <div key={i} className="qp-keep" style={{ ...text, color: '#4b5563' }}>{t}</div>)}
      {/* 번호 항목과 요율표가 섞인 영역(통역장비 취소보상비) — 번호는 항목만 이어서 매긴다 */}
      {section.blocks?.map((b, i) => 'rates' in b
        ? rateTable(b.rates, `b${i}`)
        : numbered(b.item, section.blocks!.slice(0, i).filter(x => 'item' in x).length, `b${i}`))}
    </div>
  );
}





// 수신자 정보 내 서비스 구분선 (복합 견적 시 [번역] / [통역] 라벨 포함)
function SvcDivider({ label }: { label?: string }) {
  return label
    ? <div style={{ fontSize: 9, fontWeight: 800, color: BRAND, letterSpacing: 0.3, margin: '6px 0 3px' }}>[{label}]</div>
    : <div style={{ height: 1, background: '#e5e7eb', margin: '7px 0 4px' }} />;
}


// 차감 요약 행 — 강조(strong)/색상(accent) 옵션. 과한 강조 없이 문서 톤 유지.
function PrepaidSummaryRow({ label, value, accent, strong }: { label: string; value: string; accent?: string; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 11, borderBottom: '1px solid #f1f5f9' }}>
      <span style={{ color: '#6b7280', fontWeight: strong ? 700 : 600 }}>{label}</span>
      <span style={{ color: accent ?? '#111827', fontWeight: strong ? 800 : 600, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

