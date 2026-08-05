import { Product, ProductOption, PRODUCT_TYPES_META } from '../../../lib/constants';
import { Card } from '../../ui';
import { displayUnit } from '../../../lib/quotePdf';
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
        <Card style={{ padding: "14px 18px", opacity: p.active ? 1 : 0.6, ...selectedCardStyle(selected) }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
              <span style={{ fontFamily: "monospace", fontSize: 11, color: "#9ca3af", background: "#f3f4f6", padding: "1px 6px", borderRadius: 4 }}>{p.code}</span>
              <span style={{ fontWeight: 700, fontSize: 14, color: "#111827" }}>{p.name}</span>
              <span style={{ fontSize: 11, borderRadius: 5, padding: "2px 8px", fontWeight: 700, background: tc.bg, color: tc.color }}>
                {tc.icon} {typeInfo?.label ?? p.productType}
              </span>
              {!p.active && <span style={{ fontSize: 11, background: "#f3f4f6", color: "#9ca3af", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>비활성</span>}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
              {hasLang && srcLabel && tgtLabel && (
                <span style={{ fontSize: 11, background: "#dbeafe", color: "#1d4ed8", borderRadius: 5, padding: "2px 8px", fontWeight: 600 }}>
                  {(p.productType === "interpretation" || p.productType === "combined")
                    ? (p.interpretationDirection === "B→A"
                        ? `${tgtLabel} → ${srcLabel}`
                        : p.interpretationDirection === "A→B"
                          ? `${srcLabel} → ${tgtLabel}`
                          : `${srcLabel} ↔ ${tgtLabel}`)
                    : `${srcLabel} → ${tgtLabel}`
                  }
                </span>
              )}
              {p.mainCategory && (
                <span style={{ fontSize: 11, background: "#ede9fe", color: "#5b21b6", borderRadius: 5, padding: "2px 8px", fontWeight: 600 }}>
                  {p.mainCategory}
                </span>
              )}
              {p.subCategory && (
                <span style={{ fontSize: 11, background: "#f5f3ff", color: "#7c3aed", borderRadius: 5, padding: "2px 8px" }}>
                  {p.subCategory}
                </span>
              )}
              {(p.productType === "equipment" || p.productType === "translation") ? (
                <span style={{ fontSize: 11, background: "#f3f4f6", color: "#6b7280", borderRadius: 5, padding: "2px 8px", fontWeight: 600 }}>
                  견적서에서 입력
                </span>
              ) : (
                <span style={{ fontSize: 11, background: p.basePrice != null ? "#f0fdf4" : "#f9fafb", color: p.basePrice != null ? "#059669" : "#9ca3af", borderRadius: 5, padding: "2px 8px", fontWeight: 600 }}>
                  {p.basePrice != null ? `${Number(p.basePrice).toLocaleString()}원 / ${displayUnit(p.name, p.unit)}` : `미설정 / ${displayUnit(p.name, p.unit)}`}
                </span>
              )}
              {p.interpretationDuration && (
                <span style={{ fontSize: 11, background: "#faf5ff", color: "#7c3aed", borderRadius: 5, padding: "2px 8px" }}>기본 {p.interpretationDuration}</span>
              )}
              {p.overtimePrice != null && (
                <span style={{ fontSize: 11, background: "#fff7ed", color: "#c2410c", borderRadius: 5, padding: "2px 8px" }}>초과 {Number(p.overtimePrice).toLocaleString()}원/h</span>
              )}
              {!p.active && p.deactivationReason && (
                <span style={{ fontSize: 11, background: "#fef2f2", color: "#991b1b", borderRadius: 5, padding: "2px 8px" }}>사유: {p.deactivationReason}</span>
              )}
            </div>
            {p.description && <p style={{ margin: "0 0 6px", fontSize: 12, color: "#6b7280" }}>{p.description}</p>}
            {p.options && p.options.length > 0 && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {p.options.map((o: ProductOption) => (
                  <span key={o.id} style={{ fontSize: 11, background: "#eff6ff", color: "#1d4ed8", borderRadius: 5, padding: "2px 8px", border: "1px solid #bfdbfe" }}>
                    {o.optionType}: {o.optionValue}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
