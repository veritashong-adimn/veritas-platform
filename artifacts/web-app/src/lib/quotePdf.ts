/**
 * quotePdf.ts — 견적서 PDF 출력용 DTO 빌더
 *
 * DB에서 불러온 견적 데이터를 PDF 템플릿에 전달하는 구조체로 변환한다.
 * 번역·통역·장비·기타 서비스별 상세 텍스트를 생성하고, 언어 코드를 한국어 이름으로 치환한다.
 */

// ─── FM장비 단위 표시 정규화 ─────────────────────────────────────────────────
/**
 * FM장비는 송신기·수신기·이어폰 등 구성품을 묶어 제공하는 장비이므로
 * 업무상 단위를 '대'가 아니라 '세트'로 사용한다.
 * 과거에 '대'로 저장된 데이터도 조회·PDF·거래명세서·엑셀 출력 시 '세트'로 표시한다.
 * (다른 장비 상품 및 '대' 이외의 단위는 원본 유지, 수량·금액 계산에는 영향 없음)
 */
export function displayUnit(
  productName: string | null | undefined,
  unit: string | null | undefined,
): string {
  const u = unit ?? '';
  if ((productName ?? '').includes('FM장비') && u === '대') return '세트';
  return u;
}

// ─── 통역 공급가액 계산 (편집 화면·저장·PDF 공통) ────────────────────────────
export function calculateInterpretationAmount(
  peopleCount: number, serviceDays: number, unitPrice: number
): { billingQuantity: number; supplyAmount: number } {
  const billingQuantity = peopleCount * serviceDays;
  const supplyAmount    = Math.round(billingQuantity * unitPrice);
  return { billingQuantity, supplyAmount };
}

// ─── 통역 행 파생 계산 (편집 화면·저장·요약 단일 기준) ────────────────────────
/**
 * 통역 상품의 계산은 항상 아래 원본 입력에서만 파생한다 (파생값을 별도 상태로 저장·참조하지 않음).
 * 화면 '수량' 입력값 등 오래된 상태는 절대 참조하지 않는다.
 *
 *   startDate / endDate → serviceDays  (양끝 포함: 종료일 − 시작일 + 1)
 *   interpreterCount    → 투입 인원
 *   unitPrice           → 통역사 1인 × 1일 단가
 *
 * 반환:
 *   serviceDays        통역 일수 (시작일 없으면 당일 1일 / 종료일<시작일이면 0)
 *   effectiveQuantity  인원 × 일수 (서버 전송 quantity · 화면 '수량' 표시에 공통 사용)
 *   supplyAmount       effectiveQuantity × 단가
 *   invalidDateRange   종료일이 시작일보다 빠름 → 계산 보류, 호출측에서 날짜 확인 메시지 표시
 */
export interface InterpretationInput {
  startDate?:        string | null;
  endDate?:          string | null;
  interpreterCount?: number | string | null;
  unitPrice?:        number | string | null;
}
export interface InterpretationResult {
  serviceDays:       number;
  effectiveQuantity: number;
  supplyAmount:      number;
  invalidDateRange:  boolean;
}

/** 숫자 파싱 — 천단위 콤마 제거, 실패 시 0. */
function parseNum(v: number | string | null | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  return Number(String(v ?? '').replace(/,/g, '')) || 0;
}

/**
 * 통역 일수(양끝 포함) 원시값. 시작일 없으면 당일(1일), 종료일 미입력/동일이면 1일.
 * 종료일이 시작일보다 빠르면 음수를 반환하여 호출측이 오류로 판정하도록 한다.
 */
export function interpretationServiceDays(startDate?: string | null, endDate?: string | null): number {
  if (!startDate) return 1;                         // 시작일 미입력 → 당일 1일
  if (!endDate || endDate === startDate) return 1;  // 종료일 미입력/동일 → 1일
  const s = new Date(startDate).getTime();
  const e = new Date(endDate).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return 1;
  return Math.round((e - s) / 86400000) + 1;        // 음수 가능(종료<시작)
}

/** 통역 행 단일 계산 함수 — 편집 화면·저장·금액 요약이 모두 이 함수를 사용한다. */
export function calcInterpretation(input: InterpretationInput): InterpretationResult {
  const rawDays = interpretationServiceDays(input.startDate, input.endDate);
  if (rawDays < 1) {
    // 종료일 < 시작일 → 계산하지 않음 (지시문 2절)
    return { serviceDays: 0, effectiveQuantity: 0, supplyAmount: 0, invalidDateRange: true };
  }
  const cntNum      = parseNum(input.interpreterCount);
  const peopleCount = cntNum > 0 ? Math.round(cntNum) : 1;  // 미입력 시 1명 기준
  const price       = parseNum(input.unitPrice);
  const { billingQuantity, supplyAmount } = calculateInterpretationAmount(peopleCount, rawDays, price);
  return { serviceDays: rawDays, effectiveQuantity: billingQuantity, supplyAmount, invalidDateRange: false };
}

// ─── 언어 코드 → 한국어 이름 매핑 ────────────────────────────────────────────
const LANG_NAMES: Record<string, string> = {
  ko: '한국어', en: '영어', ja: '일본어',
  'zh-hans': '중국어(간체)', 'zh-hant': '중국어(번체)',
  de: '독일어', fr: '프랑스어', es: '스페인어', it: '이탈리아어',
  pt: '포르투갈어', ru: '러시아어', nl: '네덜란드어', pl: '폴란드어',
  cs: '체코어', uk: '우크라이나어', vi: '베트남어', th: '태국어',
  id: '인도네시아어', ms: '말레이어', ar: '아랍어', tr: '터키어',
};
function langName(code: string | null | undefined): string {
  if (!code) return '';
  return LANG_NAMES[code] ?? code;
}

// ─── 타입 ─────────────────────────────────────────────────────────────────────

export interface QuoteDetailItem {
  id: number;
  productName: string;
  itemType: string | null;
  quantity: string;
  unit: string;
  unitPrice: string;
  supplyAmount: string;
  taxAmount: string;
  totalAmount: string;
  memo: string | null;
  languagePair: string | null;
  interpretDate: string | null;
  interpretPlace: string | null;
  interpretDuration: string | null;
  operationHours?: string | null;   // 운영시간(행사 운영시간) — 안내 정보
  eventStartDate: string | null;
  eventEndDate: string | null;
  itemLocation: string | null;
  usagePeriod: string | null;
  interpretType: string | null;
  // 투입 인원(통역). NULL = 레거시(quantity에 인원×일수 포함 → 역산).
  interpreterCount?: number | null;
}

export interface QuoteDetailSettings {
  companyName: string | null;
  businessNumber: string | null;
  ceoName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  bankName: string | null;
  accountNumber: string | null;
  accountHolder: string | null;
  signatureImageUrl: string | null;
  quoteNotes: string | null;
  quoteValidityDays: number;
}

export interface QuoteDetail {
  id: number;
  quoteNumber: string | null;
  title: string | null;
  price: string;
  status: string;
  quoteType: string;
  note: string | null;
  issueDate: string | null;
  validUntil: string | null;
  projectId: number | null;
  companyName: string | null;
  companyBusinessNumber: string | null;
  representativeName: string | null;
  divisionName: string | null;   // 브랜드(Division) — projects.requestingDivisionId 기준
  contactName: string | null;
  contactDivision: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  adminName: string | null;
  items: QuoteDetailItem[];
  settings: QuoteDetailSettings;
}

export interface QuotePdfItem {
  index: number;
  productType: string;
  productName: string;
  detailText: string;       // 서비스 상세 — 여러 줄 가능
  quantity: string;
  unit: string;
  quantityLabel: string;    // PDF 표시용 "수량 × 인원" 등 설명
  unitPrice: number;
  supplyAmount: number;
  taxAmount: number;
  totalAmount: number;
  memo: string;             // 사용자 비고 (서비스 정보 제외)
}

// 수신자 영역 서비스별 요약 (buildQuotePdfData가 자동 집계)
export interface QuoteSummary {
  translation: {
    languagePairs: string[];   // ["한국어 → 영어"]
    fileCount: number;
    totalWordCount: number;
    totalCharCount: number;
  } | null;
  interpretation: {
    languagePairs: string[];   // ["광동어 ↔ 한국어"]
    startDate: string;         // "2026-07-20"
    endDate: string;           // "2026-07-21"
    places: string[];
  } | null;
  equipment: {
    startDate: string;
    endDate: string;
    places: string[];
  } | null;
}

export interface QuotePdfData {
  quoteNumber: string;
  quoteDate: string;
  validUntil: string;
  quoteType: string;
  note: string;
  serviceType: string; // 'translation' | 'interpretation' | 'equipment' | 'mixed'
  // 공급자
  supplier: {
    companyName: string;
    businessNumber: string;
    ceoName: string;
    address: string;
    phone: string;
    email: string;
  };
  // 고객
  customer: {
    companyName: string;
    businessNumber: string;
    representativeName: string;
    brandName: string;   // 브랜드(Division) — 있을 때만 표시
    contactName: string;
    contactDivision: string;
    contactPhone: string;
    contactEmail: string;
  };
  manager: string;
  // 수신자 영역 서비스 요약
  summary: QuoteSummary;
  // 품목
  items: QuotePdfItem[];
  // 금액
  supplyTotal: number;
  taxTotal: number;
  grandTotal: number;
  // 계좌
  bankAccount: {
    bankName: string;
    accountNumber: string;
    accountHolder: string;
  };
  signatureImageUrl: string;
  quoteNotes: string;
}

// ─── 통역 서비스일수 계산 ────────────────────────────────────────────────────
function calcServiceDays(startDate: string | null | undefined, endDate: string | null | undefined): number {
  if (!startDate) return 0;
  if (!endDate || endDate === startDate) return 1;
  const start = new Date(startDate);
  const end   = new Date(endDate);
  const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  return Math.max(1, diffDays + 1);
}

// ─── 서비스별 상세 텍스트 생성 ────────────────────────────────────────────────

export function parseMemoInfo(memo: string | null): { fields: Record<string, string>; userMemo: string } {
  if (!memo) return { fields: {}, userMemo: '' };
  // 번역 항목 메모 파싱: "user memo / 파일: foo.docx | 형식: DOCX | 단어수: 500 | 글자수: 2000"
  // 또는 역순: "파일: foo.docx | 형식: DOCX | 단어수: 500 | 글자수: 2000"
  const KEYS = ['파일', '형식', '단어수', '글자수'];
  const fields: Record<string, string> = {};

  // " / " 구분자로 분리 후, 각 세그먼트에서 "키: 값" 파싱
  const segments = memo.split(' / ');
  const userParts: string[] = [];

  for (const seg of segments) {
    const parts = seg.split(' | ');
    let isInfoSeg = false;
    for (const p of parts) {
      const colonIdx = p.indexOf(': ');
      if (colonIdx > 0) {
        const k = p.slice(0, colonIdx).trim();
        const v = p.slice(colonIdx + 2).trim();
        if (KEYS.includes(k)) {
          fields[k] = v;
          isInfoSeg = true;
        }
      }
    }
    if (!isInfoSeg) {
      userParts.push(seg);
    }
  }
  // 투입인원 파싱 (통역 아이템 메모에서)
  const countMatch = memo.match(/투입인원:\s*(\d+)명/);
  if (countMatch) fields['투입인원'] = countMatch[1];

  return { fields, userMemo: userParts.filter(Boolean).join(' / ') };
}

function buildDetailText(item: QuoteDetailItem): string {
  const { fields, userMemo: _userMemo } = parseMemoInfo(item.memo);
  const type = item.itemType ?? 'translation';
  const lines: string[] = [];

  if (type === 'translation') {
    // 파일명 먼저
    if (fields['파일']) lines.push(fields['파일'] + (fields['형식'] ? ` (${fields['형식']})` : ''));
    else if (fields['형식']) lines.push(fields['형식']);
    // 언어쌍
    if (item.languagePair) {
      const [src, tgt] = item.languagePair.split('-');
      const pair = [langName(src), langName(tgt)].filter(Boolean).join(' → ');
      if (pair) lines.push(pair);
    }
    // 분량 (라벨 없이 값 + 단위만: "55,700단어" / "70,000글자")
    if (fields['단어수']) lines.push(`${Number(fields['단어수']).toLocaleString()}단어`);
    if (fields['글자수']) lines.push(`${Number(fields['글자수']).toLocaleString()}글자`);
  } else if (type === 'interpretation') {
    // 언어방향 (↔)
    if (item.languagePair) {
      const [src, tgt] = item.languagePair.split('-');
      const pair = [langName(src), langName(tgt)].filter(Boolean).join(' ↔ ');
      if (pair) lines.push(pair);
    }
    // 행사기간 (날짜 범위)
    if (item.interpretDate) {
      lines.push(item.eventEndDate && item.eventEndDate !== item.interpretDate
        ? `${item.interpretDate} ~ ${item.eventEndDate}`
        : item.interpretDate);
    }
    // 운영시간 (행사 운영시간 — 기간 다음. 지시문 6절 순서: 기간→운영시간→통역시간→장소→인원)
    if (item.operationHours) lines.push(`운영시간 ${item.operationHours}`);
    // 통역시간 (계약 기준 안내 정보)
    if (item.interpretDuration) lines.push(`통역시간 ${item.interpretDuration}`);
    // 장소
    if (item.interpretPlace) lines.push(item.interpretPlace);
    // 투입인원 (일수는 수량/단위 컬럼에 이미 표시됨)
    //  - 신규: interpreterCount 컬럼 사용 (quantity = 진행일수)
    //  - 레거시: interpreterCount 없음 → quantity(=인원×일수) ÷ 일수 역산
    const svcDays  = calcServiceDays(item.interpretDate, item.eventEndDate);
    const qty      = Number(item.quantity) || 0;
    const pplCount = item.interpreterCount != null
      ? Number(item.interpreterCount)
      : (svcDays > 0 ? Math.round(qty / svcDays) : qty);
    if (pplCount > 0) {
      lines.push(`통역사 ${pplCount}명`);
    }
  } else if (type === 'equipment') {
    // 기간
    if (item.eventStartDate) {
      lines.push(item.eventEndDate && item.eventEndDate !== item.eventStartDate
        ? `${item.eventStartDate} ~ ${item.eventEndDate}`
        : item.eventStartDate);
    }
    // 장소
    if (item.itemLocation) lines.push(item.itemLocation);
    // 사용일수
    const days = Number(item.usagePeriod);
    if (days > 0) lines.push(`${days}일 사용`);
  } else if (type === 'expense') {
    if (item.interpretType) lines.push(item.interpretType);
  }

  return lines.join('\n');
}

function extractUserMemo(item: QuoteDetailItem): string {
  const { userMemo } = parseMemoInfo(item.memo);
  // 통역 아이템에서 "투입인원: Xmyg" 부분 제거
  return userMemo.replace(/투입인원:\s*\d+명\s*\/?/g, '').replace(/^\s*\/\s*|\s*\/\s*$/g, '').trim();
}

// ─── 서비스 유형 판별 ────────────────────────────────────────────────────────

function detectServiceType(items: QuoteDetailItem[]): string {
  if (items.length === 0) return 'mixed';
  const types = new Set(items.map(it => it.itemType ?? 'translation').filter(t => t !== 'expense'));
  if (types.size === 1) {
    const t = [...types][0];
    if (t === 'translation' || t === 'interpretation' || t === 'equipment') return t;
  }
  return 'mixed';
}

// ─── buildQuotePdfData ────────────────────────────────────────────────────────

export function buildQuotePdfData(detail: QuoteDetail): QuotePdfData {
  const s = detail.settings;

  const items: QuotePdfItem[] = detail.items.map((it, idx) => {
    let supplyAmount = Number(it.supplyAmount);
    let taxAmount    = Number(it.taxAmount);
    let totalAmount  = Number(it.totalAmount);

    return {
      index:        idx + 1,
      productType:  it.itemType ?? 'translation',
      productName:  it.productName,
      detailText:   buildDetailText(it),
      quantity:     it.quantity,
      unit:         displayUnit(it.productName, it.unit),
      quantityLabel: '',
      unitPrice:    Number(it.unitPrice),
      supplyAmount,
      taxAmount,
      totalAmount,
      memo:         extractUserMemo(it),
    };
  });

  const supplyTotal = items.reduce((a, it) => a + it.supplyAmount, 0);
  const taxTotal    = items.reduce((a, it) => a + it.taxAmount, 0);
  const grandTotal  = supplyTotal + taxTotal;

  // ─── 서비스별 수신자 요약 집계 ────────────────────────────────────────────
  const trItems = detail.items.filter(it => (it.itemType ?? 'translation') === 'translation');
  const inItems = detail.items.filter(it => it.itemType === 'interpretation');
  const eqItems = detail.items.filter(it => it.itemType === 'equipment');

  const uniq = <T,>(arr: (T | null | undefined)[]): T[] =>
    [...new Set(arr.filter((v): v is T => v != null && v !== ''))];

  let translationSummary: QuoteSummary['translation'] = null;
  if (trItems.length > 0) {
    const pairs = uniq(trItems.map(it => {
      if (!it.languagePair) return null;
      const [src, tgt] = it.languagePair.split('-');
      return [langName(src), langName(tgt)].filter(Boolean).join(' → ') || null;
    }));
    let totalWord = 0, totalChar = 0;
    for (const it of trItems) {
      const { fields } = parseMemoInfo(it.memo);
      totalWord += Number(fields['단어수'] || 0);
      totalChar += Number(fields['글자수'] || 0);
    }
    translationSummary = { languagePairs: pairs, fileCount: trItems.length, totalWordCount: totalWord, totalCharCount: totalChar };
  }

  let interpretationSummary: QuoteSummary['interpretation'] = null;
  if (inItems.length > 0) {
    const pairs = uniq(inItems.map(it => {
      if (!it.languagePair) return null;
      const [src, tgt] = it.languagePair.split('-');
      return [langName(src), langName(tgt)].filter(Boolean).join(' ↔ ') || null;
    }));
    const allDates = [...inItems.map(it => it.interpretDate), ...inItems.map(it => it.eventEndDate ?? it.interpretDate)]
      .filter((d): d is string => !!d).sort();
    const places = uniq(inItems.map(it => it.interpretPlace));
    interpretationSummary = { languagePairs: pairs, startDate: allDates[0] ?? '', endDate: allDates[allDates.length - 1] ?? '', places };
  }

  let equipmentSummary: QuoteSummary['equipment'] = null;
  if (eqItems.length > 0) {
    const allDates = [...eqItems.map(it => it.eventStartDate), ...eqItems.map(it => it.eventEndDate ?? it.eventStartDate)]
      .filter((d): d is string => !!d).sort();
    const places = uniq(eqItems.map(it => it.itemLocation));
    equipmentSummary = { startDate: allDates[0] ?? '', endDate: allDates[allDates.length - 1] ?? '', places };
  }

  const summary: QuoteSummary = { translation: translationSummary, interpretation: interpretationSummary, equipment: equipmentSummary };

  const QUOTE_TYPE_LABEL: Record<string, string> = {
    b2b_standard: '일반 견적서', b2c_prepaid: '차감 견적서', accumulated_batch: '누적 견적서',
  };

  return {
    quoteNumber:   detail.quoteNumber ?? `#${detail.id}`,
    quoteDate:     detail.issueDate   ?? '',
    validUntil:    detail.validUntil  ?? '',
    quoteType:     QUOTE_TYPE_LABEL[detail.quoteType] ?? detail.quoteType,
    note:          detail.note        ?? '',
    serviceType:   detectServiceType(detail.items),
    supplier: {
      companyName:    s.companyName    ?? '',
      businessNumber: s.businessNumber ?? '',
      ceoName:        s.ceoName        ?? '',
      address:        s.address        ?? '',
      phone:          s.phone          ?? '',
      email:          s.email          ?? '',
    },
    customer: {
      companyName:         detail.companyName            ?? '',
      businessNumber:      detail.companyBusinessNumber  ?? '',
      representativeName:  detail.representativeName     ?? '',
      brandName:           detail.divisionName          ?? '',
      contactName:         detail.contactName         ?? '',
      contactDivision:     detail.contactDivision     ?? '',
      contactPhone:        detail.contactPhone        ?? '',
      contactEmail:        detail.contactEmail        ?? '',
    },
    manager:      detail.adminName ?? '',
    summary,
    items,
    supplyTotal,
    taxTotal,
    grandTotal,
    bankAccount: {
      bankName:      s.bankName      ?? '',
      accountNumber: s.accountNumber ?? '',
      accountHolder: s.accountHolder ?? '',
    },
    signatureImageUrl: s.signatureImageUrl ?? '',
    quoteNotes:        s.quoteNotes        ?? '',
  };
}

// ─── 유형 레이블 ──────────────────────────────────────────────────────────────
export const ITEM_TYPE_LABEL: Record<string, string> = {
  translation:    '번역',
  interpretation: '통역',
  equipment:      '장비',
  expense:        '기타',
};

export const SERVICE_TYPE_LABEL: Record<string, string> = {
  translation:    '번역',
  interpretation: '통역',
  equipment:      '장비',
  mixed:          '복합견적',
};

// 서비스 유형별 안내문
export const QUOTE_NOTES_BY_SERVICE: Record<string, string> = {
  translation: [
    '· 본 견적은 견적일로부터 유효기간 내에만 유효합니다.',
    '· 번역 분량은 최종 번역 완료 후 실제 글자수/단어수 기준으로 조정될 수 있습니다.',
    '· 추가 수정 및 재번역 요청은 별도 견적이 발생할 수 있습니다.',
    '· 납품 파일은 원본 파일 형식과 동일하게 제공됩니다.',
    '· 발주 후 계약서 또는 발주서를 요청드립니다.',
  ].join('\n'),
  interpretation: [
    '· 본 견적은 견적일로부터 유효기간 내에만 유효합니다.',
    '· 통역 일정 변경 또는 취소 시 최소 3영업일 전에 통보해 주시기 바랍니다.',
    '· 장시간 통역(4시간 이상)의 경우 통역사 2인 이상 투입을 권장합니다.',
    '· 식사, 대기 시간은 통역 가능 시간에서 제외됩니다.',
    '· 발주 후 계약서 또는 발주서를 요청드립니다.',
  ].join('\n'),
  mixed: [
    '· 본 견적은 견적일로부터 유효기간 내에만 유효합니다.',
    '· 견적 금액은 부가세(VAT) 별도 기준입니다.',
    '· 발주 후 계약서 또는 발주서를 요청드립니다.',
  ].join('\n'),
};
