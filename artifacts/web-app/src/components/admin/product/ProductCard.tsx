import { Product, PRODUCT_TYPES_META } from '../../../lib/constants';
import { Card } from '../../ui';
import { TYPE_COLORS, LANG_LABEL, selectedCardStyle } from './productShared';

interface ProductCardProps {
  p: Product;
  /** 관리 권한이 있어 선택/수정이 가능한지 */
  selectable: boolean;
  selected: boolean;
  onToggleSelect: (id: number) => void;
  /** 카드 클릭 시 수정 화면 진입 */
  onOpen: (p: Product) => void;
}

/** 상품 카드 — 정보 표시 + 좌측 체크박스. 개별 관리 버튼은 없다(상단 공통 버튼에서 관리). */
export function ProductCard({ p, selectable, selected, onToggleSelect, onOpen }: ProductCardProps) {
  const typeInfo = PRODUCT_TYPES_META[p.productType];
  const tc = TYPE_COLORS[p.productType] ?? { bg: "#f9fafb", color: "#374151", icon: "📦" };
  const srcLabel = p.sourceLanguage ? (LANG_LABEL[p.sourceLanguage] ?? p.sourceLanguage) : null;
  const tgtLabel = p.targetLanguage ? (LANG_LABEL[p.targetLanguage] ?? p.targetLanguage) : null;
  const hasLang = typeInfo?.hasLanguage ?? false;

  // 목록은 '상품을 찾는 화면' — 언어는 상품명을 방해하지 않도록 작은 회색 텍스트로만 표시.
  const langText = hasLang && srcLabel && tgtLabel
    ? ((p.productType === "interpretation" || p.productType === "combined")
        ? (p.interpretationDirection === "B→A"
            ? `${tgtLabel} → ${srcLabel}`
            : p.interpretationDirection === "A→B"
              ? `${srcLabel} → ${tgtLabel}`
              : `${srcLabel} ↔ ${tgtLabel}`)
        : `${srcLabel} → ${tgtLabel}`)
    : null;
  // 세부유형: 필요 시만 대표태그보다 약한 작은 회색 텍스트로 (중분류 우선, 없으면 대분류)
  // 단, 대표태그(유형 label)와 동일하면 중복이므로 생략 (예: 유형 [번역] + 대분류 "번역")
  const typeLabel = typeInfo?.label ?? p.productType;
  const rawDetail = p.subCategory || p.mainCategory || null;
  const detailText = rawDetail && rawDetail !== typeLabel ? rawDetail : null;

  return (
    <div
      onClick={() => { if (selectable) onOpen(p); }}
      data-testid={`product-card-${p.id}`}
      style={{ display: "flex", alignItems: "stretch", gap: 10, cursor: selectable ? "pointer" : "default" }}
    >
      {selectable && (
        <div onClick={e => e.stopPropagation()} style={{ display: "flex", alignItems: "center", paddingLeft: 2 }}>
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(p.id)}
            aria-label={`상품 선택: ${p.name}`}
            data-testid={`product-select-${p.id}`}
            style={{ width: 16, height: 16, cursor: "pointer" }}
          />
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <Card style={{ padding: "12px 18px", opacity: p.active ? 1 : 0.6, ...selectedCardStyle(selected) }}>
          <div style={{ minWidth: 0 }}>
            {/* 1행: 상품명 — 다른 목록(판매·견적·거래처)과 동일한 14/700, Bold만으로 강조 */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: "#111827" }}>{p.name}</span>
              <span style={{ fontSize: 11, borderRadius: 5, padding: "2px 8px", fontWeight: 700, background: tc.bg, color: tc.color }}>
                {tc.icon} {typeLabel}
              </span>
              {!p.active && <span style={{ fontSize: 11, background: "#f3f4f6", color: "#9ca3af", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>비활성</span>}
            </div>
            {/* 2행: 보조정보 — 상품코드 · 언어 · 세부유형 (작고 연하게) */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 5, fontSize: 11.5, color: "#9ca3af" }}>
              <span style={{ fontFamily: "monospace", color: "#c0c4cc" }}>{p.code}</span>
              {langText && <span>{langText}</span>}
              {detailText && <span style={{ color: "#b0b4bc" }}>{detailText}</span>}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
