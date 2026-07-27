// ─────────────────────────────────────────────────────────────────────────────
// QuoteItemsView — 판매관리 "판매정보" 읽기전용 뷰
//
// 견적관리 편집기(QuoteEditorWorkspace)의 상품정보 그리드와 동일한 레이아웃·컬럼·
// 유형 배지·행 높이를 그대로 재사용하되, 입력/추가/삭제/이동 컨트롤이 없는 조회 전용
// 컴포넌트. 편집 로직·입력 컴포넌트·저장 로직을 포함하지 않는다 (견적=Edit / 판매=View).
//
// 데이터: 판매전환된 견적의 저장 품목을 그대로 표시한다.
//  · 유형별 상세필드는 convertToFormItem 으로 정규화(견적 편집 진입과 동일 해석)
//  · 금액(공급가액 등)은 견적에 저장된 값(supplyAmount)을 재계산 없이 그대로 표시
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react';
import { C, TYPO, BD, dsAmount } from '../../lib/ds';
import { displayUnit, type QuoteDetailItem } from '../../lib/quotePdf';
import { convertToFormItem } from '../../lib/quoteItemForm';
import type { QuoteItemForm } from './QuoteEditorWorkspace';
import { tblRow, COL_H, SVC_CFG, SVC_FIELD_HINTS } from './quoteItemsShared';

// 판매정보 입력 원본 — 견적 품목(QuoteDetailItem) + 저장 금액 컬럼
export type SaleItem = QuoteDetailItem & {
  productId?: number | null;
  taxType?: string | null;
  supplyAmount?: string | number | null;
  taxAmount?: string | number | null;
  totalAmount?: string | number | null;
};

const fmt = (n: unknown) => Number(n ?? 0).toLocaleString();
const DASH = <span style={{ color: C.g400 }}>—</span>;

// ── 유형 배지 (편집기 ServiceTypeSelector의 배지 부분과 동일 스타일, 읽기전용) ──
function TypeBadge({ type }: { type: QuoteItemForm['productType'] }) {
  const cfg = SVC_CFG[type];
  return (
    <span style={{ ...TYPO.badge, color: cfg.color, background: C.bgCard, border: `1.5px solid ${cfg.border}`, borderRadius: 6, padding: '3px 8px', fontWeight: 700, whiteSpace: 'nowrap' }}>
      {cfg.label}
    </span>
  );
}

// ── 읽기전용 값 셀 — 편집기 rinp(입력칸)과 동일 높이감의 정적 텍스트 ──
function RoCell({ w, flex, value, align = 'left', suffix, title }: {
  w?: number; flex?: number; value?: string | number | null;
  align?: 'left' | 'right' | 'center'; suffix?: string; title?: string;
}) {
  const has = value !== '' && value != null;
  return (
    <div title={title} style={{
      ...TYPO.inputValue,
      width: w, flex, minWidth: flex ? 0 : undefined,
      padding: '5px 4px', textAlign: align,
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      color: has ? C.textPrimary : C.g400,
    }}>
      {has ? <>{value}{suffix ? <span style={{ color: C.textMuted }}> {suffix}</span> : null}</> : '—'}
    </div>
  );
}

// ── ④ 유형별 동적필드 (읽기전용) — 편집기 ServiceFields의 텍스트 미러 ──
function ReadOnlyServiceFields({ f }: { f: QuoteItemForm }) {
  switch (f.productType) {
    case 'translation':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <RoCell flex={1} value={f.fileName} title="원본 파일명" />
          <RoCell w={90} value={f.fileFormat} />
          <RoCell w={88} value={f.wordCount ? Number(f.wordCount).toLocaleString() : ''} suffix="단어" align="right" />
          <RoCell w={88} value={f.charCount ? Number(f.charCount).toLocaleString() : ''} suffix="글자" align="right" />
        </div>
      );
    case 'interpretation': {
      const period = f.interpretDate
        ? (f.interpretEndDate && f.interpretEndDate !== f.interpretDate ? `${f.interpretDate} ~ ${f.interpretEndDate}` : f.interpretDate)
        : '';
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <RoCell w={174} value={period} title="행사 기간" />
          <RoCell w={132} value={f.operationHours} title="운영시간" />
          <RoCell w={86} value={f.interpretHours} suffix="시간/일" align="right" />
          <RoCell w={56} value={f.interpreterCount} suffix="명" align="right" title="투입 인원" />
          <RoCell flex={1} value={f.interpretPlace} title="행사 장소" />
        </div>
      );
    }
    case 'equipment': {
      const period = f.eventStartDate
        ? (f.eventEndDate && f.eventEndDate !== f.eventStartDate ? `${f.eventStartDate} ~ ${f.eventEndDate}` : f.eventStartDate)
        : '';
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <RoCell w={174} value={period} title="사용 기간" />
          <RoCell w={200} value={f.operationHours ? `설치 ${f.operationHours}` : ''} title="설치일시" />
          <RoCell w={72} value={f.usagePeriod} suffix="일" align="right" title="사용일수" />
          <RoCell flex={1} value={f.itemLocation} title="장비 사용 장소" />
        </div>
      );
    }
    case 'expense':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <RoCell flex={1} value={f.expenseType} title="서비스 유형" />
        </div>
      );
    default:
      return <div />;
  }
}

// ── 항목 행 (읽기전용) ─────────────────────────────────────────────────────────
function ReadOnlyRow({ raw }: { raw: SaleItem }) {
  const f = convertToFormItem(raw);
  const supply = Number(raw.supplyAmount ?? 0);

  // 할인 행 — 편집기 할인 Row와 동일(공급가액 음수·빨강)
  if (f.productType === 'discount') {
    const dcAbs = Math.abs(supply);
    return (
      <div style={{ ...tblRow, borderBottom: `1px solid ${C.g100}`, minHeight: 42, background: C.dangerBg }}>
        <div />
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}><TypeBadge type="discount" /></div>
        <div style={{ ...TYPO.inputValue, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {f.productName || 'Special D.C'}
        </div>
        <div style={{ minWidth: 0, display: 'flex', gap: 4, alignItems: 'center' }}>
          <RoCell w={64} value={f.discountType === 'percent' ? '비율(%)' : '금액'} title="할인방식" />
          <RoCell w={130} value={f.discountValue ? Number(f.discountValue).toLocaleString() : ''}
            suffix={f.discountType === 'percent' ? '%' : '원'} align="right" title="할인값" />
          <RoCell flex={1} value={f.discountReason} title="할인 사유 (내부용)" />
        </div>
        <div />
        <div style={{ textAlign: 'center', color: C.g400 }}>—</div>
        <div style={{ textAlign: 'center', color: C.g400 }}>—</div>
        <div style={{ textAlign: 'right', color: C.g400, paddingRight: 6 }}>—</div>
        <div style={dsAmount(dcAbs > 0, { paddingRight: 6, color: dcAbs > 0 ? C.danger : C.amountEmpty })}>
          {dcAbs > 0 ? `-${dcAbs.toLocaleString()}원` : '—'}
        </div>
        <div style={{ borderLeft: '2px solid #e5e7eb', paddingLeft: 14, ...TYPO.inputValue, color: C.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {f.memo || DASH}
        </div>
      </div>
    );
  }

  // 일반 행 (번역/통역/장비/기타)
  return (
    <div style={{ ...tblRow, borderBottom: `1px solid ${C.g100}`, minHeight: 42 }}>
      <div />
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}><TypeBadge type={f.productType} /></div>
      <div style={{ ...TYPO.inputValue, fontWeight: 600, minWidth: 0, overflow: 'hidden' }}>
        <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.productName || DASH}</div>
        {raw.languagePair && <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>{raw.languagePair}</div>}
      </div>
      <div style={{ minWidth: 0 }}><ReadOnlyServiceFields f={f} /></div>
      <div />
      <div style={{ ...TYPO.inputValue, textAlign: 'center' }}>{fmt(f.quantity)}</div>
      <div style={{ ...TYPO.inputValue, textAlign: 'center' }}>{displayUnit(f.productName, f.unit) || DASH}</div>
      <div style={{ ...TYPO.inputValue, textAlign: 'right', paddingRight: 6, fontVariantNumeric: 'tabular-nums' }}>{fmt(f.unitPrice)}원</div>
      <div style={dsAmount(supply > 0, { paddingRight: 6 })}>{supply > 0 ? `${supply.toLocaleString()}원` : '—'}</div>
      <div style={{ borderLeft: '2px solid #e5e7eb', paddingLeft: 14, ...TYPO.inputValue, color: C.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {f.memo || DASH}
      </div>
    </div>
  );
}

// ── 판매금액 합계 행 — 판매정보 테이블의 마지막 3개 "합계 행"(엑셀 합계 행 방식) ──
// 별도 요약 박스가 아니라 동일 TABLE_COLS 그리드로 렌더 → 금액이 상품별 '공급가액'(9번째 컬럼)
// 바로 아래에 정확히 정렬된다(§2·§3·§8). 레이블은 공급가액 왼쪽(1~8열)에 우측정렬(§4).
// 비고(10번째) 컬럼은 사용하지 않는다(§5). 총 판매금액만 Primary·Bold·+1단계 강조(§6).
// 이 컴포넌트는 항목 행과 동일한 overflow/grid 컨텍스트 안에 렌더되어야 정렬이 맞는다.
export function SaleTotalsRows({ supply, tax, total }: { supply: number; tax: number; total: number }) {
  const won = (n: number) => Math.round(n).toLocaleString();
  // 컴팩트 합계 행 — 그리드 템플릿·컬럼갭·가로 padding(8)은 상품 행과 동일(정렬 유지),
  // 세로 padding·행 높이·lineHeight만 최소화하여 3줄을 하나의 묶음처럼 압축(§1·§2).
  // 3줄(공급가액 합계·부가세·총 판매금액) 사이 세로 간격만 아주 미세하게 늘려 답답함만 해소(원본 1px → 3px)
  const rowBase:   React.CSSProperties = { ...tblRow, padding: '3px 8px', minHeight: 0, lineHeight: 1.2 };
  // 구분선과 숫자/레이블 사이에 아주 약간의 여백을 줘서 값이 윗줄(구분선)에 붙어 보이지 않게 함
  const hair:      React.CSSProperties = { borderTop: BD.card, paddingTop: 3 };     // 할인 행 아래 구분선(§7)
  const hairTotal: React.CSSProperties = { borderTop: BD.divider, paddingTop: 3 };  // 총 판매금액 위 구분선(§7)
  // 레이블 = 1~8열(단가까지) 우측정렬, 금액 = 9열(공급가액) 우측정렬(상품 행 공급가액과 paddingRight 동일)
  const labelCell: React.CSSProperties = { gridColumn: '1 / 9', textAlign: 'right', paddingRight: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
  const amtCell:   React.CSSProperties = { gridColumn: '9 / 10', textAlign: 'right', paddingRight: 6, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
  const infoLabel = { ...labelCell, fontSize: 12, fontWeight: 400, color: C.textMuted };
  const infoAmt   = { ...amtCell,   fontSize: 13, fontWeight: 700, color: C.g900 };
  return (
    <div data-testid="sales-totals-rows">
      {/* 공급가액 합계 — 할인 행 아래 얇은 구분선(비고 컬럼은 미포함) */}
      <div style={rowBase}>
        <div style={{ ...infoLabel, ...hair }}>공급가액 합계</div>
        <div style={{ ...infoAmt, ...hair }} data-testid="sales-amount-supply">{won(supply)}원</div>
      </div>
      {/* 부가세 */}
      <div style={rowBase}>
        <div style={infoLabel}>부가세</div>
        <div style={infoAmt} data-testid="sales-amount-tax">{won(tax)}원</div>
      </div>
      {/* 총 판매금액 — 위 구분선 + Primary 강조 */}
      <div style={rowBase}>
        <div style={{ ...labelCell, ...hairTotal, fontSize: 13, fontWeight: 700, color: C.textSecondary }}>총 판매금액</div>
        <div style={{ ...amtCell, ...hairTotal, fontSize: 15, fontWeight: 800, color: C.primaryText }} data-testid="sales-amount-total">{won(total)}원</div>
      </div>
    </div>
  );
}

// ── 판매정보 그리드 (읽기전용) ─────────────────────────────────────────────────
export default function QuoteItemsView({ items }: { items: SaleItem[] }) {
  // ④ 동적필드 헤더 힌트 — 편집기와 동일 규칙(단일 유형이면 해당 힌트)
  const types = [...new Set(items.map(it => (it.itemType ?? 'translation') as QuoteItemForm['productType']))];
  const fieldHint = types.length === 1 ? SVC_FIELD_HINTS[types[0]] : '서비스별 상세 정보';

  // 판매금액 요약 — 저장값(각 행에 표시되는 supplyAmount) 합산으로 테이블과 정확히 일치
  const totals = items.reduce(
    (a, it) => ({
      supply: a.supply + Number(it.supplyAmount ?? 0),
      tax:    a.tax    + Number(it.taxAmount ?? 0),
      total:  a.total  + Number(it.totalAmount ?? 0),
    }),
    { supply: 0, tax: 0, total: 0 },
  );

  return (
    <div>
      <div style={{ overflowX: 'auto', scrollbarWidth: 'thin' }}>
        {/* 컬럼 헤더 — 편집기와 동일 TABLE_COLS 그리드. 편집 전용(행 제어·AI)은 읽기전용이라 빈 헤더 */}
        <div style={{ ...tblRow, padding: '0 8px 7px', borderBottom: BD.grid, marginBottom: 3 }}>
          <div style={{ ...COL_H }} />
          <div style={{ ...COL_H }}>유형</div>
          <div style={{ ...COL_H, textAlign: 'left' }}>상품</div>
          <div style={{ ...COL_H, textAlign: 'left' }}>{fieldHint}</div>
          <div style={{ ...COL_H }} />
          <div style={{ ...COL_H }}>수량</div>
          <div style={{ ...COL_H }}>단위</div>
          <div style={{ ...COL_H, textAlign: 'right' }}>단가</div>
          <div style={{ ...COL_H, textAlign: 'right', paddingRight: 6 }}>공급가액</div>
          <div style={{ ...COL_H, textAlign: 'left', borderLeft: BD.grid, paddingLeft: 14 }}>비고</div>
        </div>

        {/* 항목 행 */}
        <div>
          {items.map((it, idx) => <ReadOnlyRow key={idx} raw={it} />)}
          {items.length === 0 && (
            <div style={{ ...tblRow, padding: '18px 8px', justifyContent: 'center' }}>
              <div style={{ ...TYPO.inputValue, gridColumn: '1 / -1', textAlign: 'center', color: C.g400 }}>
                등록된 품목이 없습니다.
              </div>
            </div>
          )}
        </div>

        {/* 합계 행 — 동일 overflow/grid 안에서 렌더되어 상품별 공급가액 컬럼과 정확히 정렬(§2·§3·§8) */}
        {items.length > 0 && <SaleTotalsRows supply={totals.supply} tax={totals.tax} total={totals.total} />}
      </div>
    </div>
  );
}
