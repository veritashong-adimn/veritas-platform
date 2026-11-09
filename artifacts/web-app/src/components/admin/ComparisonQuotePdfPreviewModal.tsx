/**
 * ComparisonQuotePdfPreviewModal — 비교견적 전용 PDF 미리보기/인쇄.
 *
 * VERITAS 견적서(QuotePdfPreviewModal)와 분리된 독립 템플릿(lib/comparisonQuoteDocument).
 *  · 미리보기와 인쇄가 같은 렌더러(renderComparisonQuoteBody)를 사용 → 화면 = PDF.
 *  · settings/VERITAS 정보를 절대 사용하지 않는다. 비어 있는 항목은 표시하지 않는다.
 *  · 발행 구분(실제 업체 견적 / 내부 비교용)을 툴바와 문서에 명확히 표시한다.
 */
import React, { useEffect, useMemo } from 'react';
import type { ComparisonQuotePdfData } from '../../lib/comparisonQuotePdf';
import { buildComparisonFileName } from '../../lib/comparisonQuotePdf';
import { COMPARISON_DOC_CSS, renderComparisonQuoteBody, buildComparisonQuotePrintHtml } from '../../lib/comparisonQuoteDocument';
import { alertDialog } from '../ui';

const PAGE: React.CSSProperties = {
  width: 794, minHeight: 1123, margin: '0 auto', padding: '45px 57px', background: '#fff', boxSizing: 'border-box',
};

export default function ComparisonQuotePdfPreviewModal({ data, onClose, imageError }: { data: ComparisonQuotePdfData; onClose: () => void; imageError?: string | null }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const bodyHtml = useMemo(() => renderComparisonQuoteBody(data), [data]);
  const sim = data.issueType === 'internal_simulation';

  const handlePrint = () => {
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { void alertDialog({ title: '팝업 차단됨', message: '팝업 차단을 해제해 주세요.', variant: 'warning' }); return; }
    const fileName = buildComparisonFileName(data.company.name, data.issueDate, data.issueType);
    win.document.write(buildComparisonQuotePrintHtml(fileName, data, { autoPrint: true }));
    win.document.close();
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(15,23,42,0.6)', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <style>{COMPARISON_DOC_CSS}</style>
      {/* 툴바 */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: '#134e4a', padding: '12px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>비교견적 미리보기</span>
          <span data-testid="cq-pdf-issue-badge"
            style={{ fontSize: 11, fontWeight: 800, borderRadius: 999, padding: '3px 10px', background: sim ? '#fef3c7' : '#dcfce7', color: sim ? '#92400e' : '#166534' }}>
            {sim ? (data.issueTypeUnset ? '내부 비교용 (발행 구분 미지정)' : '내부 비교용 시뮬레이션') : '실제 업체 견적'}
          </span>
          <span style={{ color: '#99f6e4', fontSize: 12 }}>{data.company.name}{data.displayNumber ? ` · ${data.displayNumber}` : ''}</span>
          {imageError && <span style={{ color: '#fbbf24', fontSize: 12, fontWeight: 600 }} title={imageError}>⚠ {imageError}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#99f6e4', fontSize: 11 }}>인쇄 시 A4 페이지 단위로 자동 분할 · 머리글/바닥글 없음</span>
          <button onClick={handlePrint} data-testid="btn-comparison-pdf-print" aria-label="비교견적 PDF 저장(인쇄)"
            style={{ padding: '8px 20px', borderRadius: 7, border: 'none', background: '#0f766e', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            🖨 인쇄 / PDF 저장
          </button>
          <button onClick={onClose} data-testid="btn-comparison-pdf-close" aria-label="닫기"
            style={{ padding: '8px 16px', borderRadius: 7, border: '1px solid #475569', background: 'transparent', color: '#cbd5e1', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
            닫기
          </button>
        </div>
      </div>

      {/* A4 미리보기 — 인쇄와 동일한 렌더러 */}
      <div style={{ flex: 1, padding: '32px 24px', display: 'flex', justifyContent: 'center' }}>
        <div style={{ ...PAGE, boxShadow: '0 4px 24px rgba(0,0,0,0.25)', overflow: 'hidden' }} data-testid="cq-pdf-page"
          dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      </div>
    </div>
  );
}
