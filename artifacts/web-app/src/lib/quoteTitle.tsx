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

// ─── 견적서명(프로젝트명) 표준 자동 생성 ────────────────────────────────────

/** 상품 역할(Role) — 대표상품 후보 판정의 기준. */
export type ProductRole = 'primary' | 'addon' | 'equipment' | 'expense';

/**
 * 통역 productType 중 '부가상품'으로 분류할 mainCategory 집합.
 * (통역 연장료·야간/휴일 할증 = '할증/연장', 통역 출장비 = '출장/이동')
 * 상품명 문자열이 아니라 상품 카탈로그의 카테고리로 판정한다.
 * 향후 부가 카테고리가 늘면 이 한 곳만 확장한다. (역할 기반, 확장 가능)
 */
export const INTERPRETATION_ADDON_CATEGORIES = new Set<string>(['할증/연장', '출장/이동']);

/**
 * 상품 역할 판정 (문자열 비교 아님 — productType + mainCategory 기반):
 *  - equipment       → 'equipment' (FM장비·부스·리시버·송신기·장비류)
 *  - expense         → 'expense'   (교통비·숙박·부가비용)
 *  - interpretation  → 부가 카테고리면 'addon', 아니면 'primary'(일반 통역)
 *  - translation·combined·기타 서비스 → 'primary'
 */
export function productRole(productType: string, mainCategory?: string | null): ProductRole {
  if (productType === 'equipment') return 'equipment';
  if (productType === 'expense')   return 'expense';
  if (productType === 'interpretation') {
    return mainCategory && INTERPRETATION_ADDON_CATEGORIES.has(mainCategory) ? 'addon' : 'primary';
  }
  return 'primary';
}

/**
 * '통역장비'로 분류되는 장비 mainCategory 집합 (대표상품 판정 시 통역 서비스 금액에 합산).
 * 현재 카탈로그의 장비(equipment) 대분류는 모두 통역 수행용 장비이므로 포함한다.
 * 향후 통역과 무관한 '일반장비/번역장비' 등이 추가되면 이 집합에 넣지 않으면 자동 제외된다. (allowlist 방식 → 지시문 6절)
 */
export const INTERPRETATION_EQUIPMENT_CATEGORIES = new Set<string>([
  '동시통역장비', '가이드장비', '위스퍼링장비', '마이크장비', '음향장비', '부스장비', '운영장비', '기타장비',
  // 레거시/직접입력 표기 호환
  '통역장비', 'FM장비', '적외선장비',
]);

/**
 * 통역 서비스 금액에 합산할 '통역장비'인지 판정.
 *  - equipment 타입이 아니면 false
 *  - mainCategory 미지정(null) 장비는 현재 카탈로그 기준 통역장비로 취급 (equipment 타입 라벨 자체가 '통역장비')
 *  - 지정된 경우 allowlist(INTERPRETATION_EQUIPMENT_CATEGORIES)에 포함될 때만 통역장비
 */
export function isInterpretationEquipment(productType: string, mainCategory?: string | null): boolean {
  if (productType !== 'equipment') return false;
  if (!mainCategory) return true;
  return INTERPRETATION_EQUIPMENT_CATEGORIES.has(mainCategory);
}

/**
 * 견적서명 생성 입력 상품. 공급가액과 역할(productType+mainCategory)로 대표상품을 선정한다.
 * mainCategory는 상품 카탈로그 대분류(있으면). 없으면 productType만으로 역할 판정.
 */
export interface QuoteTitleItem {
  productName: string;
  productType: string;
  mainCategory?: string | null;
  supplyAmount: number;
}

/**
 * 대표상품 선정 규칙 (서비스 단위 공급가액 비교 — 상품 종류 우선순위 아님):
 *  ① 번역은 하나의 서비스, '통역 + 통역장비'는 하나의 통역 서비스로 묶는다.
 *       번역 서비스 금액   = Σ 번역 공급가액
 *       통역 서비스 금액   = Σ 통역(본상품) 공급가액 + Σ 통역장비 공급가액   (지시문 3·5·7절)
 *       기타 서비스        = 각 기타(expense) 항목을 개별 비교
 *  ② 서비스 금액이 가장 큰 서비스를 대표로 선정하고, 그 서비스의 대표상품명을 사용한다.
 *       - 통역 서비스가 대표면 이름은 '통역 본상품' 중 최대 공급가액 (통역장비는 이름 후보가 아님 → 지시문 4절)
 *       - 번역 서비스가 대표면 이름은 번역 상품 중 최대 공급가액
 *  ③ 대표 후보 서비스가 하나도 없으면(장비만/보조만 존재) 전체 상품 중 최대 공급가액으로 대체한다.
 *  ④ 통역장비·통역 보조(addon)는 단독 대표상품이 될 수 없다. (합산 대상 or 제외)
 *  ※ 서비스 금액 동률이면 먼저 평가된(번역 → 통역 → 기타 순, 배열 앞선) 서비스를 유지한다.
 */
function pickRepresentativeProduct(items: QuoteTitleItem[]): string {
  const largest = (arr: QuoteTitleItem[]) =>
    arr.reduce((a, b) => ((b.supplyAmount || 0) > (a.supplyAmount || 0) ? b : a), arr[0]);
  const sumSupply = (arr: QuoteTitleItem[]) => arr.reduce((s, it) => s + (it.supplyAmount || 0), 0);

  // 역할별 분류
  const translations   = items.filter(it => it.productType === 'translation'   && productRole(it.productType, it.mainCategory) === 'primary');
  const interpretations = items.filter(it => it.productType === 'interpretation' && productRole(it.productType, it.mainCategory) === 'primary'); // 통역 본상품(할증/출장 addon 제외)
  const interpEquip    = items.filter(it => isInterpretationEquipment(it.productType, it.mainCategory));                                          // 통역장비(합산 대상)
  const expenses       = items.filter(it => productRole(it.productType, it.mainCategory) === 'expense');                                          // 기타 서비스

  // 비교 대상 서비스 목록 {비교 금액, 대표상품명}
  const services: { value: number; name: string }[] = [];
  if (translations.length > 0)    services.push({ value: sumSupply(translations),                        name: largest(translations).productName.trim() });
  if (interpretations.length > 0) services.push({ value: sumSupply(interpretations) + sumSupply(interpEquip), name: largest(interpretations).productName.trim() });
  for (const it of expenses)      services.push({ value: it.supplyAmount || 0,                           name: it.productName.trim() });

  if (services.length > 0) {
    return services.reduce((a, b) => (b.value > a.value ? b : a), services[0]).name;
  }
  return largest(items).productName.trim();  // 후보 서비스 없음(장비만 등) → 전체 최대 공급가액
}

/**
 * VERITAS 표준 견적서명(프로젝트명) 생성 — 플랫폼 전 화면 공통 사용.
 * 형식: VERITAS│회사명_[브랜드명_]대표상품명[ 외 N건]_YYYYMMDD
 *  - 브랜드 없으면 브랜드 구간 생략
 *  - 상품 2개 이상이면 대표상품 뒤에 ' 외 N건' (N = 상품수 − 1)
 *  - 날짜는 항상 YYYYMMDD
 * 회사명이 없거나 유효 상품(상품명 존재)이 0개면 빈 문자열을 반환한다.
 */
export function generateQuoteTitle(params: {
  companyName: string | null | undefined;
  brandName?: string | null;
  items: QuoteTitleItem[];
  issueDate: string; // 'YYYY-MM-DD' 등 (구분자 제거 후 앞 8자리 사용)
}): string {
  const companyName = (params.companyName ?? '').trim();
  const valid = params.items.filter(it => it.productName.trim());
  if (!companyName || valid.length === 0) return '';

  const rep = pickRepresentativeProduct(valid);
  const extra = valid.length > 1 ? ` 외 ${valid.length - 1}건` : '';
  const brandPart = params.brandName && params.brandName.trim() ? `${params.brandName.trim()}_` : '';
  const dateStr = (params.issueDate ?? '').replace(/[^0-9]/g, '').slice(0, 8);
  return `VERITAS│${companyName}_${brandPart}${rep}${extra}_${dateStr}`;
}

// ─── VERITAS 공통 문서번호 표시 형식 ─────────────────────────────────────────
/**
 * 표시 전용 문서번호: `{PREFIX}{YYMMDD}-{순번(3자리)}`
 *   견적 Q260716-008 · 판매 S260716-008 · 거래명세서 I260716-008 · 프로젝트 P260716-008 · 정산 SET260716-008
 *
 * DB PK·내부 저장 번호(quoteNumber 등 식별자)는 변경하지 않는다 — 화면 표시 문자열만 생성한다.
 * @param prefix    문서종류 접두어 (Q / S / I / P / SET …)
 * @param docNumber 기존 저장 번호(예: "Q000008") 또는 순번 — 숫자만 추출해 당일 순번으로 사용
 * @param issueDate 발행일 (YYYY-MM-DD 등). 정보 부족 시 원본 docNumber를 그대로 반환한다.
 */
export function formatDocNumber(
  prefix: string,
  docNumber: string | null | undefined,
  issueDate: string | null | undefined,
): string {
  const seqDigits = String(docNumber ?? '').replace(/\D/g, '');
  const ymd = String(issueDate ?? '').replace(/\D/g, '').slice(2, 8); // YYYYMMDD → YYMMDD
  if (!seqDigits || ymd.length < 6) return String(docNumber ?? '');
  const seq = String(Number(seqDigits)).padStart(3, '0');
  return `${prefix}${ymd}-${seq}`;
}

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
