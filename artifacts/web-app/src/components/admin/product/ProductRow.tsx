import React from 'react';
import { Product, PRODUCT_TYPES_META } from '../../../lib/constants';
import { TYPE_COLORS, LANG_LABEL } from './productShared';

// 공통 read-table 규격에 맞춘 상품 1행. 셀 배경은 두지 않아(투명) tr 레벨 zebra/hover/선택색이 그대로 비친다.
const td: React.CSSProperties = {
  padding: '9px 12px', fontSize: 13, color: '#374151',
  borderBottom: '1px solid #edf0f3', verticalAlign: 'middle',
};

interface ProductRowProps {
  p: Product;
  selectable: boolean;
  selected: boolean;
  onToggleSelect: (id: number) => void;
  onOpen: (p: Product) => void;
}

/** 상품 행(카드형 대체) — 표시 정보/유형 badge/상태는 기존 ProductCard 와 동일 데이터. */
export function ProductRow({ p, selectable, selected, onToggleSelect, onOpen }: ProductRowProps) {
  const typeInfo = PRODUCT_TYPES_META[p.productType];
  const tc = TYPE_COLORS[p.productType] ?? { bg: '#f9fafb', color: '#374151', icon: '📦' };
  const typeLabel = typeInfo?.label ?? p.productType;

  // 언어쌍(언어형 유형만) — ProductCard 와 동일 규칙.
  const srcLabel = p.sourceLanguage ? (LANG_LABEL[p.sourceLanguage] ?? p.sourceLanguage) : null;
  const tgtLabel = p.targetLanguage ? (LANG_LABEL[p.targetLanguage] ?? p.targetLanguage) : null;
  const hasLang = typeInfo?.hasLanguage ?? false;
  const langText = hasLang && srcLabel && tgtLabel
    ? ((p.productType === 'interpretation' || p.productType === 'combined')
        ? (p.interpretationDirection === 'B→A'
            ? `${tgtLabel} → ${srcLabel}`
            : p.interpretationDirection === 'A→B'
              ? `${srcLabel} → ${tgtLabel}`
              : `${srcLabel} ↔ ${tgtLabel}`)
        : `${srcLabel} → ${tgtLabel}`)
    : null;
  // 세부유형(중분류 우선, 없으면 대분류) — 대표 유형 label 과 중복이면 생략.
  const rawDetail = p.subCategory || p.mainCategory || null;
  const detailText = rawDetail && rawDetail !== typeLabel ? rawDetail : null;
  const infoParts = [langText, detailText].filter(Boolean) as string[];

  return (
    <tr
      onClick={() => { if (selectable) onOpen(p); }}
      data-testid={`product-row-${p.id}`}
      style={{ cursor: selectable ? 'pointer' : 'default', background: selected ? '#eff6ff' : undefined, opacity: p.active ? 1 : 0.6 }}
    >
      {selectable && (
        // 체크박스 클릭은 선택만 — 행 클릭(수정 진입)과 분리(stopPropagation).
        <td style={{ ...td, textAlign: 'center', width: 34 }} onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(p.id)}
            aria-label={`상품 선택: ${p.name}`}
            data-testid={`product-select-${p.id}`}
            style={{ width: 16, height: 16, cursor: 'pointer' }}
          />
        </td>
      )}
      <td style={{ ...td, fontFamily: 'monospace', color: '#6b7280', whiteSpace: 'nowrap' }}>{p.code}</td>
      <td style={{ ...td, fontWeight: 600, color: '#111827', minWidth: 200 }}>{p.name}</td>
      <td style={{ ...td, textAlign: 'center', whiteSpace: 'nowrap' }}>
        <span style={{ fontSize: 11, borderRadius: 5, padding: '2px 8px', fontWeight: 700, background: tc.bg, color: tc.color, whiteSpace: 'nowrap' }}>
          {tc.icon} {typeLabel}
        </span>
      </td>
      <td style={{ ...td, color: '#6b7280' }}>
        {infoParts.length ? infoParts.join(' · ') : <span style={{ color: '#c0c4cc' }}>—</span>}
      </td>
      <td style={{ ...td, textAlign: 'center', whiteSpace: 'nowrap' }}>
        {p.active
          ? <span style={{ fontSize: 11, background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', borderRadius: 4, padding: '1px 8px', fontWeight: 600 }}>활성</span>
          : <span style={{ fontSize: 11, background: '#f3f4f6', color: '#9ca3af', borderRadius: 4, padding: '1px 8px', fontWeight: 600 }}>비활성</span>}
      </td>
    </tr>
  );
}
