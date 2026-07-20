/**
 * VERITAS Design System — Design Tokens & Style Factories
 *
 * Single source of truth for all visual constants in admin-facing UI.
 * All admin components MUST reference these tokens instead of hardcoded values.
 *
 * Usage:
 *   import { C, TYPO, BD, SP, dsInput, dsColH, dsRow, dsAmount } from '@/lib/ds';
 *
 * Scales:
 *   Compact  — Grid/Table rows (13px, h=32, radius=6)
 *   Standard — Modal forms, page-level cards (14px, h=38, radius=8)
 */
import type React from 'react';

// ─── Color Tokens ─────────────────────────────────────────────────────────────

export const C = {
  // Brand — Primary Blue
  primary:       '#2563eb',
  primaryBg:     '#eff6ff',
  primaryBorder: '#bfdbfe',
  primaryText:   '#1d4ed8',
  primaryHover:  '#1d4ed8',

  // Status — Success (Green)
  success:       '#16a34a',
  successBg:     '#f0fdf4',
  successBorder: '#bbf7d0',
  successText:   '#15803d',

  // Status — Warning (Amber)
  warning:         '#d97706',
  warningBg:       '#fffbeb',
  warningBorder:   '#fde68a',
  warningText:     '#92400e',
  warningTextDeep: '#78350f',  // validation panel body text

  // Status — Danger (Red)
  danger:         '#dc2626',
  dangerBg:       '#fee2e2',
  dangerBgPanel:  '#fff5f5',  // validation panel bg (lighter)
  dangerBorder:   '#fca5a5',
  dangerText:     '#991b1b',
  dangerTextDeep: '#7f1d1d',  // validation panel body text
  dangerHover:    '#b91c1c',

  // AI — Violet
  ai:            '#7c3aed',
  aiBg:          '#f5f3ff',
  aiBorder:      '#ddd6fe',
  aiText:        '#5b21b6',
  aiHover:       '#6d28d9',

  // Gray scale
  g50:  '#f9fafb',
  g100: '#f3f4f6',
  g200: '#e5e7eb',
  g300: '#d1d5db',
  g400: '#9ca3af',
  g500: '#6b7280',
  g600: '#4b5563',
  g700: '#374151',
  g800: '#1f2937',
  g900: '#111827',

  // Semantic Text
  textPrimary:     '#111827',
  textSecondary:   '#374151',
  textMuted:       '#6b7280',
  textDisabled:    '#9ca3af',
  textPlaceholder: '#9ca3af',
  white:           '#ffffff',

  // Semantic Surface
  border:      '#e5e7eb',
  borderFocus: '#2563eb',
  bgPage:      '#f8fafc',
  bgCard:      '#ffffff',
  bgHover:     '#f8fafc',
  bgInput:     '#ffffff',

  // Financial / Amount
  amount:      '#1e3a5f',
  amountEmpty: '#d1d5db',
} as const;

// ─── Typography Tokens ─────────────────────────────────────────────────────────

// Level 2/3 공통 레이블 토큰 — Form 필드 레이블과 Grid 컬럼 헤더는 같은 정보 계층
// 위치가 달라도 동일한 역할이므로 하나의 토큰을 공유한다
const _label = {
  fontSize:      12,
  fontWeight:    600,
  color:         C.g700,    // #374151
  letterSpacing: '0.01em',
  lineHeight:    1.4,
} as const;

export const TYPO = {
  // ── Level 1 — 섹션 구분자 (기본정보 / 상품정보 / 금액 요약 / 비고)
  // 가장 크고 가장 선명하게 — 화면 내 최상위 구조를 즉시 인식시킨다
  sectionTitle: {
    fontSize:      14,
    fontWeight:    700,
    color:         C.g900,         // #111827 — maximum contrast
    letterSpacing: '0.02em',
    lineHeight:    1.3,
  },

  // Card / modal main title
  cardTitle: { fontSize: 14, fontWeight: 600, color: C.g900 },

  // ── Level 2 — Form 필드 레이블 (견적유형 / 견적일 / 부가세 / 거래처…)
  fieldLabel: _label,

  // ── Level 2 — Grid 컬럼 헤더 (행 제어 / 유형 / 상품 / 단가 / 공급가액…)
  // fieldLabel과 동일한 계층 — _label 토큰 공유 (의도적 동일 스타일)
  gridHeader: _label,

  // Compact label — grid 안의 보조 레이블
  compactLabel: {
    fontSize:   11,
    fontWeight: 500,
    color:      C.textMuted,
    lineHeight: 1.3,
  },

  // ── Level 4 — 입력값 (사용자가 입력하는 실제 데이터)
  // 레이블보다 크지만 굵기는 낮아 '데이터'임을 구분한다
  inputValue: {
    fontSize:   13,
    fontWeight: 400,
    color:      C.textPrimary,     // #111827 — full readability
    lineHeight: 1.4,
  },
  formValue: {
    fontSize:   14,
    fontWeight: 400,
    color:      C.textPrimary,
    lineHeight: 1.4,
  },

  // Financial amounts
  amount: {
    fontSize: 13, fontWeight: 600, color: C.amount, whiteSpace: 'nowrap' as const,
  },
  summaryAmount: {
    fontSize: 15, fontWeight: 700, color: C.amount,
  },

  // ── Level 5 — Placeholder / Helper Text
  // 가장 연한 색상으로 입력값과 명확히 구분한다
  helper: {
    fontSize:   11,
    fontWeight: 400,
    color:      C.g400,            // #9ca3af — lightest
    lineHeight: 1.4,
  },

  badge:  { fontSize: 11, fontWeight: 700 },
} as const;

// ─── Spacing Scale (4px base) ─────────────────────────────────────────────────

export const SP = {
  1:  2,
  2:  4,
  3:  6,
  4:  8,
  5:  12,
  6:  16,
  7:  20,
  8:  24,
  9:  32,
  10: 40,
  11: 48,
} as const;

// ─── Border / Radius / Shadow ─────────────────────────────────────────────────

export const BD = {
  input:      `1px solid ${C.border}`,
  inputFocus: `1px solid ${C.borderFocus}`,
  card:       `1px solid ${C.g200}`,
  grid:       `1.5px solid ${C.g200}`,
  divider:    `1px solid ${C.g100}`,

  radius: {
    sm:  4,   // tags, badges
    md:  6,   // compact inputs, grid rows
    lg:  8,   // standard forms, standard buttons
    xl:  10,  // cards, modals
    xxl: 14,  // large cards
  } as const,

  shadow: {
    card:    '0 1px 3px rgba(0,0,0,0.07)',
    raised:  '0 2px 8px rgba(0,0,0,0.10)',
    popover: '0 8px 24px rgba(0,0,0,0.14)',
    modal:   '0 4px 20px rgba(0,0,0,0.18)',
  } as const,
} as const;

// ─── Form Tokens ──────────────────────────────────────────────────────────────
// Two scales: compact (grid rows) and standard (modal forms)

export const FORM = {
  compact: {
    h:        32,   // input height (px)
    paddingY:  5,   // vertical padding
    paddingX:  7,   // horizontal padding
    radius:    6,   // border-radius
    fontSize: 13,
    gap:       4,   // gap between inline fields
    rowGap:   12,   // gap between field rows
  },
  standard: {
    h:        38,   // input height (px)
    paddingY:  9,   // vertical padding
    paddingX: 12,   // horizontal padding
    radius:    8,   // border-radius
    fontSize: 14,
    gap:       8,   // gap between inline fields
    rowGap:   16,   // gap between field rows
  },
} as const;

// ─── VERITAS 관리자 표준 입력 필드 ─────────────────────────────────────────────
// 견적서 작성 화면에서 확립한 공통 입력 높이/여백 기준.
// 향후 거래처·담당자·판매·프로젝트·정산 등 모든 관리자 입력 화면이 동일 기준을 사용한다.
// (기존 FORM.standard 는 유지 — 이미 사용 중인 모달/폼에 영향을 주지 않기 위함)
export const FIELD = {
  h:        32,   // 입력박스 높이 기준 (거래처 검색박스 높이)
  paddingY:  7,   // vertical padding
  paddingX: 10,   // horizontal padding
  radius:    7,   // border-radius
  fontSize: 13,
  labelGap:  3,   // 라벨 → 입력박스 간격
  rowGap:   12,   // 필드 행 간격
} as const;

// ─── 기본정보 CRM 행 공통 컬럼 비율 ────────────────────────────────────────────
// 거래처·브랜드·담당자·담당 PM 입력칸을 한 줄에 균형 배치하는 Grid 컬럼 기준.
// fr 단위 + minmax(0,…) 로 컬럼 gap(20px)을 제외한 "잔여 폭"에서 비율을 분배한다.
// → 퍼센트(%) 합계 100% + gap 이 더해져 카드 밖으로 넘치던(가로 스크롤·검색 아이콘
//   잘림) 문제를 방지한다. 동일 구조(거래처/브랜드/담당자/PM)를 쓰는 화면은 이 값을 공용한다.
export const CRM_FIELD_COLS = {
  // 거래처 34 · 브랜드 26 · 담당자 20 · 담당 PM 20
  full:    'minmax(0, 34fr) minmax(0, 26fr) minmax(0, 20fr) minmax(0, 20fr)',
  // 브랜드 없음 — 거래처 40 · 담당자 30 · 담당 PM 30
  noBrand: 'minmax(0, 40fr) minmax(0, 30fr) minmax(0, 30fr)',
  // 프로젝트 내장 모드 — 담당 PM 단독
  pmOnly:  'minmax(200px, 25%)',
} as const;

// ─── Grid / Table Tokens ──────────────────────────────────────────────────────

export const TBL = {
  rowMinH:  42,   // minimum body row height (px)
  colGap:    5,   // column gap (px)
  paddingX:  8,   // row horizontal padding
  paddingY:  4,   // row top/bottom padding
} as const;

// ─── Button Tokens ─────────────────────────────────────────────────────────────

export type BtnVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'ai';
export type BtnSize    = 'sm' | 'md' | 'lg';

export const BTN = {
  base: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    fontWeight: 600, cursor: 'pointer', border: 'none',
    transition: 'background 0.15s, color 0.15s, border-color 0.15s',
    userSelect: 'none' as const,
  },
  size: {
    sm: { height: 28, padding: '0 10px', fontSize: 12, borderRadius: BD.radius.md },
    md: { height: 32, padding: '0 14px', fontSize: 13, borderRadius: BD.radius.md },
    lg: { height: 38, padding: '0 20px', fontSize: 14, borderRadius: BD.radius.lg },
  } as const,
  variant: {
    primary:   { background: C.primary,   color: C.white,          border: 'none' },
    secondary: { background: C.g100,      color: C.textSecondary,  border: `1px solid ${C.g300}` },
    outline:   { background: 'transparent', color: C.primary,      border: `1px solid ${C.primary}` },
    ghost:     { background: 'transparent', color: C.textMuted,    border: 'none' },
    danger:    { background: C.danger,    color: C.white,           border: 'none' },
    ai:        { background: C.ai,        color: C.white,           border: 'none' },
  } as const,
  hover: {
    primary:   { background: C.primaryHover },
    secondary: { background: C.g200 },
    outline:   { background: C.primaryBg, borderColor: C.primaryText },
    ghost:     { background: C.g100,      color: C.textSecondary },
    danger:    { background: C.dangerHover },
    ai:        { background: C.aiHover },
  } as const,
} as const;

// ─── Style Factories ──────────────────────────────────────────────────────────

/**
 * Compact input style — for Grid rows and dense forms.
 * Font 13px, height 32px, radius 6px.
 */
export function dsInput(
  w: number | string = '100%',
  extra: React.CSSProperties = {},
): React.CSSProperties {
  return {
    width: w,
    boxSizing: 'border-box',
    border: BD.input,
    borderRadius: FORM.compact.radius,
    padding: `${FORM.compact.paddingY}px ${FORM.compact.paddingX}px`,
    fontSize: FORM.compact.fontSize,
    color: C.textPrimary,
    background: C.bgInput,
    outline: 'none',
    minWidth: 0,
    ...extra,
  };
}

/**
 * Standard input style — for Modal forms and page-level inputs.
 * Font 14px, padding 9px/12px, radius 8px.
 */
export function dsInputStd(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    border: BD.input,
    borderRadius: FORM.standard.radius,
    padding: `${FORM.standard.paddingY}px ${FORM.standard.paddingX}px`,
    fontSize: FORM.standard.fontSize,
    color: C.textPrimary,
    background: C.bgInput,
    outline: 'none',
    ...extra,
  };
}

/**
 * VERITAS 관리자 표준 입력 필드 스타일.
 * 견적·거래처·담당자·판매·프로젝트·정산 등 모든 관리자 입력 화면 공용.
 * 높이 기준은 거래처 검색박스와 동일 (font 13px, padding 7/10, radius 7).
 */
export function dsField(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    border: BD.input,
    borderRadius: FIELD.radius,
    padding: `${FIELD.paddingY}px ${FIELD.paddingX}px`,
    fontSize: FIELD.fontSize,
    color: C.textPrimary,
    background: C.bgInput,
    outline: 'none',
    ...extra,
  };
}

// ─── 관리자 본문 레이아웃 토큰 ─────────────────────────────────────────────────
// AdminDashboard 스크롤 컨테이너(pages/AdminDashboard.tsx)의 본문 패딩 기준값.
// full-bleed sticky 헤더가 이 패딩을 음수 offset 으로 상쇄하는 계산의 "단일 출처".
// 이 값을 바꾸면 스크롤 패딩·헤더 offset(dsStickyPageHeader)이 함께 따라간다.
// ⚠ 화면에서 top:-24px 같은 하드코딩 대신 반드시 이 상수를 기준으로 계산할 것.
export const ADMIN_SCROLL_PADDING_TOP = 24;
export const ADMIN_SCROLL_PADDING_X   = 28;

/**
 * VERITAS 관리자 상세(asPage) 화면의 full-bleed sticky 헤더 컨테이너 스타일.
 *
 * AdminDashboard 스크롤 컨테이너의 본문 패딩(ADMIN_SCROLL_PADDING_*)을
 * 음수 margin/top 으로 상쇄하여, 별도의 음수 margin wrapper 없이 헤더 하나만으로
 *   · 좌우: 스크롤 영역 가장자리까지 확장(full-bleed)
 *   · 상단: 정지 상태·스크롤 밀착 상태 모두 뷰포트 최상단에 밀착
 * 을 동시에 보장한다.
 *
 * top 오프셋은 스크롤 컨테이너 상단 패딩만큼 음수(-ADMIN_SCROLL_PADDING_TOP)를 준다.
 * (하드코딩 top:-24px 금지 — 토큰 기준 계산)
 *
 * PageHeader 의 style prop 에 그대로 넘겨 공통 헤더로 통일한다:
 *   <PageHeader ... style={dsStickyPageHeader()} />
 */
export function dsStickyPageHeader(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    position: 'sticky',
    top: -ADMIN_SCROLL_PADDING_TOP,                     // 밀착 시 컨테이너 상단 패딩 상쇄
    zIndex: 20,
    margin: `-${ADMIN_SCROLL_PADDING_TOP}px -${ADMIN_SCROLL_PADDING_X}px 0`, // 정지 시 상단 밀착 + 좌우 full-bleed
    padding: `0 ${ADMIN_SCROLL_PADDING_X}px`,           // 내부 콘텐츠는 표준 좌우 여백 복원
    background: C.bgCard,
    borderBottom: BD.card,
    boxShadow: BD.shadow.card,
    ...extra,
  };
}

/**
 * Grid column header cell style.
 * Center by default; pass 'left' or 'right' for financial/content columns.
 */
export function dsColH(
  align: 'left' | 'center' | 'right' = 'center',
  extra: React.CSSProperties = {},
): React.CSSProperties {
  return { ...TYPO.gridHeader, textAlign: align, ...extra };
}

/**
 * Grid row layout — shared by header and body rows.
 * Pass the same gridTemplateColumns string to both header and data rows.
 */
export function dsRow(
  cols: string,
  extra: React.CSSProperties = {},
): React.CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: cols,
    columnGap: TBL.colGap,
    padding: `${TBL.paddingY}px ${TBL.paddingX}px`,
    alignItems: 'center',
    ...extra,
  };
}

/**
 * Amount display style — right-aligned, formatted number + 원.
 * hasValue: false → uses amountEmpty (gray placeholder color).
 */
export function dsAmount(
  hasValue: boolean,
  extra: React.CSSProperties = {},
): React.CSSProperties {
  return {
    ...TYPO.amount,
    textAlign: 'right',
    color: hasValue ? C.amount : C.amountEmpty,
    ...extra,
  };
}
