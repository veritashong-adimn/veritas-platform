/**
 * VERITAS Excel Kit — 공통 엑셀 빌딩 블록
 *
 * 모든 엑셀 출력(견적, 판매관리, 정산, Invoice 등)이 동일한
 * 디자인 시스템을 사용하도록 공통 상수·헬퍼를 정의한다.
 *
 * 회사정보 변경 → COMPANY_INFO 만 수정
 * 색상/스타일 변경 → XC, XST 만 수정
 */

// ─── 회사정보 ─────────────────────────────────────────────────────────────────

export const COMPANY_INFO = {
  name:    'VERITAS',
  tagline: '전문 번역·통역 서비스',
  addr:    '서울특별시 강남구',
  tel:     '02-000-0000',
  email:   'info@veritas.co.kr',
  web:     'www.veritas.co.kr',
  bizNo:   '000-00-00000',
};

// ─── 브랜드 색상 팔레트 ───────────────────────────────────────────────────────
// RGB hex (no #), xlsx-js-style 셀 스타일 형식

export const XC = {
  brand:      '1E3A5F',   // VERITAS 딥 블루
  brandText:  'FFFFFF',   // 브랜드 배경 위 텍스트
  brandMid:   '2563EB',   // 중간 파란 (강조)
  light:      'EFF6FF',   // 연한 파란 배경
  sumBg:      'DBEAFE',   // 소계 행 배경
  totalBg:    '1E3A5F',   // 총액 행 배경 (= brand)
  totalText:  'FFFFFF',   // 총액 텍스트
  labelBg:    'F1F5F9',   // 기본정보 레이블 배경
  border:     'CBD5E1',   // 표준 border
  borderLt:   'E2E8F0',   // 연한 border
  muted:      '94A3B8',   // 흐린 텍스트 (footer)
};

// ─── Border 팩토리 ────────────────────────────────────────────────────────────

const _bl = (s: string, rgb: string) => ({ style: s, color: { rgb } });

export const xBorder = {
  allThin:  (c: string) => ({ top: _bl('thin', c),   bottom: _bl('thin', c),   left: _bl('thin', c),   right: _bl('thin', c)   }),
  allMed:   (c: string) => ({ top: _bl('medium', c), bottom: _bl('medium', c), left: _bl('medium', c), right: _bl('medium', c) }),
  botMed:   (c: string) => ({ bottom: _bl('medium', c) }),
  topMed:   (c: string) => ({ top:    _bl('medium', c) }),
  botThin:  (c: string) => ({ bottom: _bl('thin', c)   }),
};

// ─── 공통 스타일 토큰 ─────────────────────────────────────────────────────────
// 각 스타일은 xlsx-js-style 셀 s 프로퍼티에 직접 사용

export const XST = {
  // ── Document header
  brand: {
    font:      { bold: true, sz: 22, color: { rgb: XC.brand } },
    alignment: { horizontal: 'left', vertical: 'center' },
  },
  tagline: {
    font:      { sz: 9, color: { rgb: XC.muted } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border:    xBorder.botMed(XC.border),
  },
  docTitle: {
    font:      { bold: true, sz: 18, color: { rgb: XC.brand } },
    alignment: { horizontal: 'right', vertical: 'center' },
  },
  docSub: {
    font:      { sz: 10, color: { rgb: XC.muted }, italic: true },
    alignment: { horizontal: 'right', vertical: 'center' },
    border:    xBorder.botMed(XC.border),
  },

  // ── 기본정보 레이블 / 값
  infoLbl: {
    font:      { bold: true, sz: 10, color: { rgb: XC.brand } },
    fill:      { patternType: 'solid', fgColor: { rgb: XC.labelBg } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border:    xBorder.allThin(XC.border),
  },
  infoVal: {
    font:      { sz: 10 },
    alignment: { horizontal: 'left', vertical: 'center' },
    border:    xBorder.allThin(XC.border),
  },

  // ── 테이블 헤더
  thC: {
    font:      { bold: true, sz: 10, color: { rgb: XC.brandText } },
    fill:      { patternType: 'solid', fgColor: { rgb: XC.brand } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border:    xBorder.allThin(XC.border),
  },
  thL: {
    font:      { bold: true, sz: 10, color: { rgb: XC.brandText } },
    fill:      { patternType: 'solid', fgColor: { rgb: XC.brand } },
    alignment: { horizontal: 'left',   vertical: 'center' },
    border:    xBorder.allThin(XC.border),
  },
  thR: {
    font:      { bold: true, sz: 10, color: { rgb: XC.brandText } },
    fill:      { patternType: 'solid', fgColor: { rgb: XC.brand } },
    alignment: { horizontal: 'right',  vertical: 'center' },
    border:    xBorder.allThin(XC.border),
  },

  // ── 테이블 데이터
  td: {
    font:      { sz: 10 },
    alignment: { vertical: 'top', wrapText: true },
    border:    xBorder.allThin(XC.borderLt),
  },
  tdC: {
    font:      { sz: 10 },
    alignment: { horizontal: 'center', vertical: 'top' },
    border:    xBorder.allThin(XC.borderLt),
  },
  tdR: {
    font:      { sz: 10 },
    alignment: { horizontal: 'right', vertical: 'top' },
    border:    xBorder.allThin(XC.borderLt),
  },
  tdNum: {
    font:      { sz: 10 },
    numFmt:    '#,##0',
    alignment: { horizontal: 'right', vertical: 'top' },
    border:    xBorder.allThin(XC.borderLt),
  },

  // ── 금액 요약
  sumLbl: {
    font:      { bold: true, sz: 10 },
    fill:      { patternType: 'solid', fgColor: { rgb: XC.sumBg } },
    alignment: { horizontal: 'right', vertical: 'center' },
    border:    xBorder.allThin(XC.border),
  },
  sumVal: {
    font:      { bold: true, sz: 10 },
    numFmt:    '#,##0',
    fill:      { patternType: 'solid', fgColor: { rgb: XC.sumBg } },
    alignment: { horizontal: 'right', vertical: 'center' },
    border:    xBorder.allThin(XC.border),
  },
  totalLbl: {
    font:      { bold: true, sz: 12, color: { rgb: XC.totalText } },
    fill:      { patternType: 'solid', fgColor: { rgb: XC.totalBg } },
    alignment: { horizontal: 'right', vertical: 'center' },
    border:    xBorder.allMed(XC.brand),
  },
  totalVal: {
    font:      { bold: true, sz: 12, color: { rgb: XC.totalText } },
    numFmt:    '#,##0',
    fill:      { patternType: 'solid', fgColor: { rgb: XC.totalBg } },
    alignment: { horizontal: 'right', vertical: 'center' },
    border:    xBorder.allMed(XC.brand),
  },

  // ── 섹션 레이블 (비고 등)
  secLbl: {
    font:      { bold: true, sz: 10, color: { rgb: XC.brand } },
    fill:      { patternType: 'solid', fgColor: { rgb: XC.labelBg } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border:    xBorder.allThin(XC.border),
  },
  noteVal: {
    font:      { sz: 10 },
    alignment: { vertical: 'top', wrapText: true },
    border:    xBorder.allThin(XC.borderLt),
  },

  // ── Footer
  footer: {
    font:      { sz: 9, color: { rgb: XC.muted } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border:    xBorder.topMed(XC.border),
  },

  // ── 빈 셀 (border 유지용)
  empty: (border: object) => ({ font: { sz: 10 }, border }),
};
