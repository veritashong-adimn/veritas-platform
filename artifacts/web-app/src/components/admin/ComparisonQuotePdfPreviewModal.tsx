/**
 * ComparisonQuotePdfPreviewModal — 비교견적 전용 PDF 미리보기/인쇄.
 *
 * VERITAS 견적서(QuotePdfPreviewModal)와 명확히 다른 별도 템플릿(§7):
 *  · 상단 중앙 제목 + 얇은 이중선, 우측 업체 카드, 연한 청록 테이블 헤더, 박스형 합계.
 *  · settings/VERITAS 정보를 절대 사용하지 않는다(§8). 비어 있는 항목은 표시하지 않는다.
 */
import React, { useEffect, useRef } from 'react';
import type { ComparisonQuotePdfData } from '../../lib/comparisonQuotePdf';
import { buildComparisonFileName } from '../../lib/comparisonQuotePdf';
import { alertDialog } from '../ui';

const fmt = (n: number) => (Number(n) || 0).toLocaleString('ko-KR');
const ACCENT = '#0f766e';      // teal — VERITAS(#1e3a5f, navy)와 구분
const ACCENT_SOFT = '#ccfbf1';
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const PAGE: React.CSSProperties = {
  width: 794, minHeight: 1123, margin: '0 auto', padding: '52px 56px', background: '#fff',
  boxSizing: 'border-box', fontFamily: '"Apple SD Gothic Neo", "Malgun Gothic", "맑은 고딕", sans-serif',
  fontSize: 12, color: '#1f2937', lineHeight: 1.6,
};

export default function ComparisonQuotePdfPreviewModal({ data, onClose }: { data: ComparisonQuotePdfData; onClose: () => void }) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const handlePrint = () => {
    const content = contentRef.current;
    if (!content) return;
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { void alertDialog({ title: '팝업 차단됨', message: '팝업 차단을 해제해 주세요.', variant: 'warning' }); return; }
    const fileName = buildComparisonFileName(data.company.name, data.quoteDate);
    win.document.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>${escapeHtml(fileName)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Apple SD Gothic Neo", "Malgun Gothic", "맑은 고딕", "NanumGothic", sans-serif; font-size: 12px; color: #1f2937; line-height: 1.6; background: #fff; }
  @page { size: A4 portrait; margin: 15mm 16mm; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head><body>${content.innerHTML}<script>window.onload=function(){window.print();}<\/script></body></html>`);
    win.document.close();
  };

  const c = data.company;
  const companyRows: Array<[string, string | null | undefined]> = [
    ['대표자', c.representativeName],
    ['사업자등록번호', c.businessNumber],
    ['주소', c.address],
    ['TEL', c.phone],
    ['E-MAIL', c.email],
    ['홈페이지', c.website],
    ['담당', c.contactName],
  ];

  // 수신처(고객) — 생성 시점 스냅샷. 값이 있는 항목만 표시.
  const cust = data.customer;
  const customerRows: Array<[string, string | null | undefined]> = [
    ['대표자', cust.representativeName],
    ['담당자', cust.contactName],
    ['연락처', cust.phone],
    ['이메일', cust.email],
  ];
  const hasCustomer = !!(cust.companyName || cust.representativeName || cust.contactName || cust.phone || cust.email);

  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(15,23,42,0.6)', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        {/* 툴바 */}
        <div style={{ position: 'sticky', top: 0, zIndex: 10, background: '#134e4a', padding: '12px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>비교견적 미리보기</span>
            <span style={{ color: '#99f6e4', fontSize: 12 }}>{c.name}{data.displayNumber ? ` · ${data.displayNumber}` : ''}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handlePrint} data-testid="btn-comparison-pdf-print" aria-label="비교견적 PDF 저장(인쇄)"
              style={{ padding: '8px 20px', borderRadius: 7, border: 'none', background: ACCENT, color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
              🖨 인쇄 / PDF 저장
            </button>
            <button onClick={onClose} data-testid="btn-comparison-pdf-close" aria-label="닫기"
              style={{ padding: '8px 16px', borderRadius: 7, border: '1px solid #475569', background: 'transparent', color: '#cbd5e1', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
              닫기
            </button>
          </div>
        </div>

        {/* A4 */}
        <div style={{ flex: 1, padding: '32px 24px', display: 'flex', justifyContent: 'center' }}>
          <div ref={contentRef} style={{ ...PAGE, boxShadow: '0 4px 24px rgba(0,0,0,0.25)' }}>
            {/* ── 중앙 제목 + 이중선 (VERITAS 와 다른 헤더 구조) ── */}
            <div style={{ textAlign: 'center', marginBottom: 6 }}>
              <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 14, color: '#111827' }}>견 적 서</div>
            </div>
            <div style={{ borderTop: `2px solid ${ACCENT}`, borderBottom: `1px solid ${ACCENT}`, height: 4, marginBottom: 22 }} />

            {/* ── 좌: 수신처(고객) + 문서정보 / 우: 공급자 카드 ── */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, marginBottom: 24 }}>
              <div style={{ paddingTop: 2, minWidth: 250, maxWidth: 330 }}>
                {/* 수신처(TO) — 공급자 카드(청록 좌측바)와 구분되는 상단 라벨형 박스 */}
                {hasCustomer && (
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px', marginBottom: 12 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: ACCENT, letterSpacing: 1, marginBottom: 6 }}>수신 · TO</div>
                    {cust.companyName && (
                      <div style={{ fontSize: 15, fontWeight: 800, color: '#111827', marginBottom: cust.representativeName || cust.contactName || cust.phone || cust.email ? 6 : 0 }}>
                        {cust.companyName} <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>귀중</span>
                      </div>
                    )}
                    {customerRows.filter(([, v]) => v && String(v).trim()).map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', alignItems: 'baseline', marginBottom: 2 }}>
                        <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, minWidth: 52, flexShrink: 0 }}>{k}</span>
                        <span style={{ fontSize: 11, color: '#111827', wordBreak: 'keep-all' }}>{v}</span>
                      </div>
                    ))}
                  </div>
                )}
                {data.quoteDate && (
                  <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, minWidth: 60 }}>견적일자</span>
                    <span style={{ fontSize: 12, color: '#111827' }}>{data.quoteDate}</span>
                  </div>
                )}
                {data.displayNumber && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, minWidth: 60 }}>견적번호</span>
                    <span style={{ fontSize: 12, color: '#111827', fontFamily: 'monospace' }}>{data.displayNumber}</span>
                  </div>
                )}
              </div>
              {/* 공급자 카드 — 우측 정렬, 청록 좌측 바 */}
              <div style={{ minWidth: 300, maxWidth: 360, borderLeft: `3px solid ${ACCENT}`, background: '#f8fafc', borderRadius: '0 8px 8px 0', padding: '12px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  {c.logoUrl ? <img src={c.logoUrl} alt="" style={{ width: 34, height: 34, objectFit: 'contain' }} /> : null}
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#111827', letterSpacing: -0.3 }}>{c.name}</div>
                </div>
                {companyRows.filter(([, v]) => v && String(v).trim()).map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', alignItems: 'baseline', marginBottom: 2 }}>
                    <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, minWidth: 84, flexShrink: 0 }}>{k}</span>
                    <span style={{ fontSize: 11, color: '#111827', wordBreak: 'keep-all' }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── 품목 테이블 (연한 청록 헤더 · 얇은 구분선) ── */}
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 18 }}>
              <thead>
                <tr>
                  {[['No', 46, 'center'], ['품목 / 내역', undefined, 'left'], ['수량', 60, 'right'], ['단위', 52, 'center'], ['단가', 92, 'right'], ['금액', 104, 'right']].map(([label, w, al]) => (
                    <th key={String(label)} style={{ width: w as number | undefined, textAlign: al as 'left' | 'right' | 'center', background: ACCENT_SOFT, color: '#134e4a', fontSize: 10.5, fontWeight: 700, padding: '8px 8px', borderTop: `1.5px solid ${ACCENT}`, borderBottom: `1.5px solid ${ACCENT}` }}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((it, i) => (
                  <tr key={i}>
                    <td style={{ textAlign: 'center', fontSize: 10.5, padding: '7px 8px', borderBottom: '1px solid #e5e7eb', color: '#6b7280' }}>{i + 1}</td>
                    <td style={{ fontSize: 11, padding: '7px 8px', borderBottom: '1px solid #e5e7eb' }}>
                      <div style={{ fontWeight: 600, color: '#111827' }}>{it.description}</div>
                      {(it.languagePair || it.memo) && (
                        <div style={{ fontSize: 10, color: '#6b7280', marginTop: 1 }}>
                          {[it.languagePair, it.memo].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', fontSize: 10.5, padding: '7px 8px', borderBottom: '1px solid #e5e7eb', fontVariantNumeric: 'tabular-nums' }}>{fmt(it.quantity)}</td>
                    <td style={{ textAlign: 'center', fontSize: 10.5, padding: '7px 8px', borderBottom: '1px solid #e5e7eb', color: '#6b7280' }}>{it.unit}</td>
                    <td style={{ textAlign: 'right', fontSize: 10.5, padding: '7px 8px', borderBottom: '1px solid #e5e7eb', fontVariantNumeric: 'tabular-nums' }}>{fmt(it.unitPrice)}</td>
                    <td style={{ textAlign: 'right', fontSize: 11, padding: '7px 8px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmt(it.amount)}</td>
                  </tr>
                ))}
                {data.items.length === 0 && (
                  <tr><td colSpan={6} style={{ textAlign: 'center', color: '#9ca3af', fontSize: 11, padding: '16px 8px', borderBottom: '1px solid #e5e7eb' }}>품목 없음</td></tr>
                )}
              </tbody>
            </table>

            {/* ── 합계 (우측 박스) ── */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 22 }}>
              <div style={{ width: 260 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 2px', fontSize: 11, borderBottom: '1px solid #f1f5f9' }}>
                  <span style={{ color: '#6b7280', fontWeight: 600 }}>공급가액</span>
                  <span style={{ color: '#111827', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmt(data.totals.supply)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 2px', fontSize: 11, borderBottom: '1px solid #f1f5f9' }}>
                  <span style={{ color: '#6b7280', fontWeight: 600 }}>부가세{data.vatMode === 'none' ? ' (없음)' : ' (10%)'}</span>
                  <span style={{ color: '#111827', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmt(data.totals.tax)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 12px', marginTop: 6, background: ACCENT, borderRadius: 6 }}>
                  <span style={{ color: '#99f6e4', fontSize: 11, fontWeight: 700 }}>합계금액</span>
                  <span style={{ color: '#fff', fontSize: 15, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmt(data.totals.total)} 원</span>
                </div>
              </div>
            </div>

            {/* ── 비고 / 서명 ── */}
            {data.memo && (
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '10px 14px', marginBottom: 18 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: ACCENT, marginBottom: 4 }}>비고</div>
                <div style={{ fontSize: 10.5, color: '#374151', whiteSpace: 'pre-line', lineHeight: 1.7 }}>{data.memo}</div>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 26 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{c.name} <span style={{ color: '#6b7280', fontWeight: 500 }}>(인)</span></div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
