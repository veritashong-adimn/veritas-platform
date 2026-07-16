/**
 * quoteTitle.tsx — 견적서명 표시 헬퍼
 *
 * 저장 문자열은 'VERITAS│[거래처명]_[대표상품명]_[YYYYMMDD]' 규칙으로 생성된다.
 * 화면에서는 브랜드(VERITAS) 부분만 별도 span으로 분리해
 *   - 영문 Semi-Condensed 폰트 + weight 600 + 좁은 letter-spacing 으로 가로폭을 줄이고,
 *   - 구분자 '│'는 연한 회색(#9CA3AF)으로,
 *   - 나머지 견적명은 부모의 한글 폰트를 그대로 상속(폰트 변경 금지)
 * 하여 렌더링한다.
 *
 * 반응형: 전체를 inline-flex로 구성하고
 *   - VERITAS 영역: flex-shrink 0 (잘리지 않음)
 *   - 구분자: flex-shrink 0
 *   - 견적명 영역: flex 1 + min-width 0 + 말줄임(ellipsis)
 * 로 두어, 부모 셀의 가용 폭이 넓으면 견적명이 더 길게, 좁으면 말줄임으로 표시된다.
 *
 * ※ 표시(UI)만 담당한다. 저장·검색·파일명·API 로직은 변경하지 않는다.
 *   레거시 'VERITAS_...' 접두어도 동일하게 처리하고, 접두어가 없으면 견적명 그대로 표시한다.
 */
import React from 'react';

const BRAND = 'VERITAS';

// 전체 래퍼 — inline-flex 로 주변 텍스트와 자연스럽게 배치되며 부모 폭을 넘지 않는다.
const wrapStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'baseline',
  flex: '1 1 auto',
  minWidth: 0,
  maxWidth: '100%',
  overflow: 'hidden',
  verticalAlign: 'bottom',
};

// VERITAS 브랜드 — 가로폭을 줄이기 위한 Semi-Condensed 스타일 (잘리지 않음)
const brandStyle: React.CSSProperties = {
  fontFamily: "'Arial Narrow', 'Roboto Condensed', 'Helvetica Neue', Arial, sans-serif",
  fontStretch: 'condensed',
  fontWeight: 600,
  letterSpacing: '-0.3px',
  padding: 0,
  flexShrink: 0,
  whiteSpace: 'nowrap',
};

// 구분자 '│' — 연한 회색, 좌우 여백 최소 (잘리지 않음)
const dividerStyle: React.CSSProperties = {
  color: '#9CA3AF',
  margin: '0 5px',
  flexShrink: 0,
};

// 견적명 — 남는 공간을 우선 사용하고, 부족하면 말줄임
const nameStyle: React.CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

// ─── PDF 다운로드/인쇄 파일명(문서 제목) 생성 ───────────────────────────────
/**
 * 파일 시스템에서 문제되는 OS 예약 문자만 안전 치환한다.
 * 브랜드 구분자 '│'(U+2502)는 파일명 허용 문자이므로 그대로 둔다.
 * (ASCII 파이프 '|'(U+007C)는 예약 문자라 치환 대상에 포함)
 */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

/**
 * 견적서/거래명세서 PDF 다운로드·인쇄용 공통 파일명 생성.
 * 저장된 견적서명(quoteTitle)을 그대로 사용하되, OS 예약 문자만 안전 치환한다.
 * 화면·DB의 견적서명 자체는 변경하지 않는다.
 *
 *  - 견적서:     buildDocFileName(title, { fallback: 'Q000004_견적서' })
 *      → 값 있으면 '[견적서명]', 비었으면 문서번호 기반 fallback
 *  - 거래명세서: buildDocFileName(title, { suffix: '거래명세서', fallback: 'T000005_거래명세서' })
 *      → 값 있으면 '[견적서명]_거래명세서', 비었으면 fallback
 *
 * fallback 은 접미어(문서 종류)를 이미 포함하므로 suffix 를 덧붙이지 않는다.
 */
export function buildDocFileName(
  quoteTitle: string | null | undefined,
  opts: { suffix?: string; fallback: string },
): string {
  const raw = (quoteTitle ?? '').trim();
  if (!raw) return sanitizeFileName(opts.fallback);
  const withSuffix = opts.suffix ? `${raw}_${opts.suffix}` : raw;
  return sanitizeFileName(withSuffix);
}

/** 인쇄창 <title> 주입용 HTML 이스케이프 (파일명 표시에는 영향 없음) */
export function escapeHtmlTitle(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 견적서명을 'VERITAS │ 견적명' 형태로 스타일링해 렌더링한다. */
export function renderQuoteTitle(title?: string | null): React.ReactNode {
  const t = title ?? '';
  // 'VERITAS│' 또는 레거시 'VERITAS_' 접두어 분리 (구분자·언더바 모두 1글자)
  const hasBrand = t.startsWith(BRAND + '│') || t.startsWith(BRAND + '_');
  if (!hasBrand) {
    // 접두어 없음 → 견적명 그대로 (동일한 말줄임 처리)
    return <span style={nameStyle}>{t}</span>;
  }

  const rest = t.slice(BRAND.length + 1);
  return (
    <span style={wrapStyle}>
      <span style={brandStyle}>{BRAND}</span>
      <span style={dividerStyle}>│</span>
      <span style={nameStyle}>{rest}</span>
    </span>
  );
}
