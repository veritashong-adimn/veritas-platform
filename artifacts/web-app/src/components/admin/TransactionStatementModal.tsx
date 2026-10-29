/**
 * TransactionStatementModal — 거래명세서 출력 모달
 *
 * - 저장된 견적 데이터(QuotePdfData)를 그대로 사용해 거래명세서를 렌더링한다.
 * - 견적서 PDF의 데이터 파이프라인·레이아웃을 공유하되, 거래명세서 전용 문서로 분리한다.
 * - 견적서와의 차이: 제목 "거래명세서", 거래 정보(명세서 번호·작성일·견적번호),
 *   수신자에 사업자등록번호 추가, 견적 조건/유효기간 미표시.
 * - 금액은 견적서에 저장된 값을 그대로 사용하고 재계산하지 않는다(부가세 라벨은 견적서와 같은 vatSummaryLabel).
 * - 공급자·수신자 박스·품목 배지·직인은 견적서와 같은 공통 부품(docParts)을 쓴다. 직인은 공급자 정보 박스 오른쪽 위에만 표시.
 * - 인쇄는 견적서와 같은 인쇄 HTML(buildQuotePrintHtml — 페이지 여백·표 분리 규칙 공통)을 사용한다.
 */
import React, { useEffect, useRef } from 'react';
import type { QuotePdfData } from '../../lib/quotePdf';
import { vatSummaryLabel } from '../../lib/quotePdf';
import { renderQuoteTitle, buildDocFileName, formatDocNumber } from '../../lib/quoteTitle';
import { alertDialog } from '../ui';
import { buildQuotePrintHtml } from '../../lib/quotePrintHtml';
import { BRAND, BRAND_LIGHT, useCompanySeal, SealImage, SealErrorNotice, InfoBox, PartyRows, SummaryRow, ItemTypeBadge } from './docParts';

// ─── 숫자 / 날짜 포맷 ────────────────────────────────────────────────────────
const fmt = (n: number) => n.toLocaleString('ko-KR');

// 오늘 날짜 (YYYY.MM.DD) — 거래명세서 작성일(출력일)
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

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
  onClose: () => void;
}

export default function TransactionStatementModal({ data, quoteTitle, onClose }: TransactionStatementModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  // 회사 직인 — 견적서와 같은 환경설정 직인(R2 비공개, 서버가 data URI 로 제공). 실패·미등록이면 직인 없이 출력
  const { url: sealUrl, error: sealError } = useCompanySeal();

  // 공식 문서번호 — 견적서와 동일한 formatDocNumber 규칙 사용(표시 전용, 내부 Raw 번호 미노출).
  // 거래명세서 T260716-008 / 견적번호 Q260716-008. 발행일(quoteDate) 기반 순번 파생.
  const statementNo = formatDocNumber('T', data.quoteNumber, data.quoteDate);
  const quoteNo     = formatDocNumber('Q', data.quoteNumber, data.quoteDate);
  const writtenDate = todayStr();

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

    // PDF 파일명 = '[견적서명]_거래명세서' (없으면 명세서번호 기반 fallback). 별도 인쇄창이라 메인 제목 복구 불필요.
    // 호출부가 제목 없을 때 quoteNumber를 넘기므로, 그 경우는 '제목 없음'으로 간주해 fallback을 적용한다.
    const effectiveTitle = quoteTitle && quoteTitle !== data.quoteNumber ? quoteTitle : '';
    const fileName = buildDocFileName(effectiveTitle, { suffix: '거래명세서', fallback: `${statementNo}_거래명세서` });

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
              거래명세서 미리보기
            </span>
            <span style={{ color: '#94a3b8', fontSize: 12 }}>
              {statementNo} · {renderQuoteTitle(quoteTitle)}
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
              data-testid="btn-statement-print"
              aria-label="거래명세서 인쇄 / PDF 저장"
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
              data-testid="btn-statement-close"
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
                <DealField label="작성일"          value={writtenDate} testId="ts-deal-date" />
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
      </div>
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
