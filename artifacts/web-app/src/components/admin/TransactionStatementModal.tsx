/**
 * TransactionStatementModal — 거래명세서 출력 모달
 *
 * - 저장된 견적 데이터(QuotePdfData)를 그대로 사용해 거래명세서를 렌더링한다.
 * - 견적서 PDF의 데이터 파이프라인·레이아웃을 공유하되, 거래명세서 전용 문서로 분리한다.
 * - 견적서와의 차이: 제목 "거래명세서", 거래 정보(명세서 번호·작성일·견적번호),
 *   수신자에 사업자등록번호 추가, 견적 조건/유효기간 미표시.
 * - 금액은 견적서에 저장된 값을 그대로 사용하고 재계산하지 않는다.
 * - 인쇄 버튼 클릭 시 브라우저 프린트 대화상자를 열어 PDF 저장이 가능하다.
 */
import React, { useEffect, useRef } from 'react';
import type { QuotePdfData } from '../../lib/quotePdf';
import { ITEM_TYPE_LABEL } from '../../lib/quotePdf';

// ─── 숫자 / 날짜 포맷 ────────────────────────────────────────────────────────
const fmt = (n: number) => n.toLocaleString('ko-KR');
const fmtDate = (d: string) => d.replace(/-/g, '.');

// 오늘 날짜 (YYYY.MM.DD) — 거래명세서 작성일(출력일)
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

// 거래명세서 번호 — 견적번호 기반 파생 (Q000001 → T000001)
function statementNumberFrom(quoteNumber: string): string {
  if (!quoteNumber) return '';
  return /^Q\d+$/.test(quoteNumber) ? quoteNumber.replace(/^Q/, 'T') : `T-${quoteNumber}`;
}

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

interface TransactionStatementModalProps {
  data: QuotePdfData;
  quoteTitle?: string;
  onClose: () => void;
}

export default function TransactionStatementModal({ data, quoteTitle, onClose }: TransactionStatementModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  const statementNo = statementNumberFrom(data.quoteNumber);
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
      alert('팝업 차단이 활성화되어 있습니다.\n브라우저 설정에서 팝업을 허용해 주세요.');
      return;
    }

    printWin.document.write(`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>${statementNo} 거래명세서</title>
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
              {statementNo} · {quoteTitle}
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
                <div style={{ fontSize: 24, fontWeight: 900, color: BRAND, letterSpacing: 4 }}>거 래 명 세 서</div>
                <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace', marginTop: 4 }}>
                  {statementNo}
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

              {/* 수신자 정보 — 사업자등록번호 포함, 값 없으면 '-' */}
              <InfoBox title="수신자 정보">
                {!hasCustomer ? (
                  <p style={{ fontSize: 11, color: '#9ca3af' }}>수신자 정보 미입력</p>
                ) : (
                  <>
                    <InfoRow label="거래처명"   value={data.customer.companyName        || '-'} />
                    <InfoRow label="사업자번호" value={data.customer.businessNumber     || '-'} />
                    <InfoRow label="대표자명"   value={data.customer.representativeName || '-'} />
                    <InfoRow label="담당자명"   value={data.customer.contactName        || '-'} />
                    <InfoRow label="연락처"     value={data.customer.contactPhone       || '-'} />
                    <InfoRow label="이메일"     value={data.customer.contactEmail       || '-'} />
                  </>
                )}
              </InfoBox>
            </div>

            {/* ── 거래 정보 ────────────────────────────────────────────── */}
            <div style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '10px 14px', marginBottom: 14 }}>
              <div style={{
                fontSize: 10, fontWeight: 800, color: BRAND, letterSpacing: 0.5,
                marginBottom: 8, paddingBottom: 5, borderBottom: `1.5px solid ${BRAND_LIGHT}`,
              }}>
                거래 정보
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '3px 16px' }}>
                <InfoRow label="거래명세서 번호" value={statementNo} mono />
                <InfoRow label="작성일"          value={writtenDate} />
                <InfoRow label="견적번호"        value={data.quoteNumber} mono />
              </div>
            </div>

            {/* ── 총금액 박스 ─────────────────────────────────────────── */}
            <div style={{
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
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 14, fontSize: 11 }}>
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
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
              <div style={{ width: 280 }}>
                <SummaryRow label="공급가액 합계" value={`${fmt(data.supplyTotal)}원`} />
                <SummaryRow label="부가세 (10%)" value={`${fmt(data.taxTotal)}원`} />
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

            {/* ── 하단: 입금 계좌 ──────────────────────────────────────── */}
            {hasBankInfo && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '12px 14px' }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: BRAND, letterSpacing: 0.5, marginBottom: 8 }}>
                    입금 계좌
                  </div>
                  {data.bankAccount.bankName      && <InfoRow label="은행"     value={data.bankAccount.bankName} />}
                  {data.bankAccount.accountNumber && <InfoRow label="계좌번호" value={data.bankAccount.accountNumber} mono />}
                  {data.bankAccount.accountHolder && <InfoRow label="예금주"   value={data.bankAccount.accountHolder} />}
                </div>
              </div>
            )}

            {/* ── 직인 / 서명 ──────────────────────────────────────────── */}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
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
        wordBreak: 'break-all',
        ...(mono ? { fontFamily: 'monospace', fontSize: 10 } : {}),
      }}>
        {value}
      </span>
    </div>
  );
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
