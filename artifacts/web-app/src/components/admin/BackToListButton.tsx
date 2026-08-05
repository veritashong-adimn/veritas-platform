import React from 'react';
import { C } from '../../lib/ds';

/**
 * BackToListButton — 상세 화면 공통 "목록으로" 네비게이션 버튼.
 *
 * 견적상세·판매상세·(향후) 프로젝트/통번역사/거래처 상세 등 모든 상세화면에서 재사용한다.
 * onClick 은 항상 해당 목록 화면으로 이동하도록 연결한다 (history.back() 사용 금지).
 *
 * 디자인: 목록 이동용 보조 버튼 수준(Primary 아님).
 *   - 좌측 화살표 + 명칭, 넉넉한 클릭 영역(높이 36 / 좌우 패딩 16)
 *   - 연한 회색 배경 + 테두리, Hover 시 브랜드 컬러 계열로 강조
 */
export function BackToListButton({
  onClick, label = '목록으로', testId = 'btn-back-to-list', style,
}: {
  onClick: () => void;
  label?: string;
  testId?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-label={label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        height: 36, padding: '0 16px', borderRadius: 8, flexShrink: 0,
        background: C.g50, border: `1px solid ${C.border}`, color: C.textSecondary,
        fontSize: 14, fontWeight: 600, cursor: 'pointer',
        transition: 'background 0.12s, border-color 0.12s, color 0.12s',
        ...style,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = C.primaryBg;
        e.currentTarget.style.borderColor = C.primary;
        e.currentTarget.style.color = C.primaryText;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = (style?.background as string) ?? C.g50;
        e.currentTarget.style.borderColor = C.border;
        e.currentTarget.style.color = C.textSecondary;
      }}
    >
      <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>←</span>
      {label}
    </button>
  );
}
