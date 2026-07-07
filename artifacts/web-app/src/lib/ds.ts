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
