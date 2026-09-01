/**
 * QuoteEditorWorkspace — VERITAS 표준 Workspace (4차 개편)
 *
 * asPage=true : AdminDashboard 스크롤 영역 안에 인라인 렌더링 → 사이드바 유지.
 * asPage=false: 기존 position:fixed 오버레이 (ProjectDetailModal 등 모달 내 사용).
 *
 * Version Engine 및 저장 로직 100% 유지.
 */
import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { formatWon } from "@/lib/utils";
import { api, Product } from '../../lib/constants';
import { registerUnsavedChecker } from '../../lib/unsavedGuard';
import { readQuoteHandoff, clearQuoteHandoff } from '../../lib/inquiryHandoff';
import { Card, DsButton, ClickSelect, NumericInput } from '../ui';
import { dsInput, dsInputStd, dsField, dsAmount, dsStickyPageHeader, C, BD, TBL, TYPO, SP, FORM, FIELD, CRM_FIELD_COLS } from '../../lib/ds';
import { SVC_CFG, COL_H, SVC_FIELD_HINTS, tblRow } from './quoteItemsShared';
import RowControls from './RowControls';
import {
  getPolicy, validateCounts, calcPagesFromStr,
  type ValidationResult,
} from '../../lib/languagePagePolicy';
import AiQuoteModal, { type AiDraftRow } from './AiQuoteModal';
import { PrepaidLinesSection, PrepaidSummarySection, prepaidLinesToApi, makeEmptyPrepaidLine, sumPrepaidLines, type PrepaidLine } from './PrepaidDeductionSection';
import { calcInterpretation, displayUnit, buildQuotePdfData } from '../../lib/quotePdf';
import { generateQuoteTitle } from '../../lib/quoteTitle';
import QuotePdfPreviewModal from './QuotePdfPreviewModal';
import { PageHeader } from './PageHeader';

// ─── 타입 ─────────────────────────────────────────────────────────────────────

export type QuoteType    = 'b2b_standard' | 'b2c_prepaid' | 'accumulated_batch';
export type VatType      = 'taxable' | 'exempt' | 'zero_rate';
export type ServiceType  = 'translation' | 'interpretation' | 'equipment' | 'expense' | 'discount';
export type DiscountType  = 'amount' | 'percent';

export interface QuoteItemForm {
  productId:    number | null;
  productName:  string;
  productType:  ServiceType;
  quantity:     string;
  unit:         string;
  unitPrice:    string;
  taxType:      VatType;
  memo:         string;
  // 번역 전용
  sourceLanguage: string;  // Language Policy 조회 키 (ko, en, ja, zh-hans …)
  fileName:     string;
  fileFormat:   string;
  wordCount:    string;
  charCount:    string;
  // 통역 전용
  interpretDate:    string;  // 행사 시작일
  interpretEndDate: string;  // 행사 종료일 (기간 행사)
  startTime:        string;
  endTime:          string;
  interpretHours:   string;  // 통역시간(계약 기준) — 하루 기준 시간 숫자. "N시간/일"로 저장·표시. 계산 미사용
  operationHours:   string;  // 운영시간(행사 실제 운영시간) — 자유입력 (예: "09:00~18:00"). 계산 미사용
  interpretPlace:   string;
  interpreterCount: string;  // 투입 인원
  // 장비 전용
  eventStartDate: string;  // 사용 시작일
  eventEndDate:   string;  // 사용 종료일 (기간 사용)
  itemLocation:   string;
  usagePeriod:    string;  // 사용일수 (숫자, "일" 표시는 UI에서만)
  // 기타 전용
  expenseType:    string;  // 서비스 유형 (공증/속기/녹취 등)
  // 할인 전용 (productType='discount') — 하나의 품목 행으로 저장(공급가액 음수)
  discountType?:   DiscountType;  // 'amount' | 'percent' (기본 amount)
  discountValue?:  string;        // 입력값(금액 또는 %)
  discountReason?: string;        // 내부 사유 (PDF 미출력)
}

interface Company   { id: number; name: string; divisionNames?: string[] }
interface Division  { id: number; name: string }
interface Contact   { id: number; name: string; companyId: number | null; divisionId?: number | null; divisionName?: string | null }
interface AdminUser { id: number; name?: string | null; email: string }

// ─── 서비스 유형 설정 ─────────────────────────────────────────────────────────
// SVC_CFG(유형 배지 라벨·색상)는 quoteItemsShared 로 이관되어 판매관리 뷰와 공유한다.

const SVC_DEFAULT_UNIT: Record<ServiceType, string> = {
  translation: '페이지', interpretation: '일', equipment: '세트', expense: '건', discount: '건',
};

// 상품 마스터 product_type 은 카탈로그 확장 유형(project·proofreading·operations·combined 등)을 포함할 수 있다.
// 견적 상품행이 지원하는 서비스 유형(번역/통역/장비/기타) 외의 값은 '기타(expense)'로 정규화한다.
//  (감수·프로젝트 등 = 기타 서비스로 취급 — SVC_FIELD_HINTS 기타 항목에 '감수·DTP 등' 명시)
//  → SVC_CFG[productType] 미존재로 인한 렌더 크래시(undefined.border) 방지, 데이터는 변경하지 않음.
const PRODUCT_SERVICE_TYPES: readonly ServiceType[] = ['translation', 'interpretation', 'equipment', 'expense'];
function normalizeServiceType(pt: string | null | undefined): ServiceType {
  return pt && (PRODUCT_SERVICE_TYPES as readonly string[]).includes(pt) ? (pt as ServiceType) : 'expense';
}
const SVC_UNITS: Record<ServiceType, string[]> = {
  translation:    ['페이지', '단어', '글자', '건', '개'],
  interpretation: ['일', '시간', '회', '건'],
  equipment:      ['세트', '개', '일', '회', '건'],
  expense:        ['건', '회', '시간', '일', '페이지', '부', '권', '개', '세트'],
  discount:       ['건'],
};
function getUnitOptions(serviceType: ServiceType, v: string): string[] {
  const list = SVC_UNITS[serviceType] ?? SVC_UNITS.expense;   // 미지원 유형 방어(undefined.includes 크래시 방지)
  return list.includes(v) || !v ? list : [v, ...list];
}

// ─── 계산 ─────────────────────────────────────────────────────────────────────

/**
 * 시작일·종료일에서 일수(양끝 포함) 산출 — 장비 사용일수 자동 계산용.
 * 시작일 없으면 0(자동입력 안 함), 종료일 미입력/동일이면 1일, 종료일<시작일이면 0(무효).
 */
function calcSpanDays(start?: string, end?: string): number {
  if (!start) return 0;
  if (!end || end === start) return 1;
  const s = new Date(start).getTime(), e = new Date(end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return 1;
  const d = Math.round((e - s) / 86400000) + 1;
  return d >= 1 ? d : 0;
}

/**
 * 번역 원본 입력값(단어수/글자수)에서 페이지수(수량)를 산출 — 저장·복원·입력변경 공통 기준.
 *  - word 기반 언어(en 등): 단어수 ÷ 표준값
 *  - character 기반 또는 정책 없음(기본 700글자): 글자수 ÷ 표준값
 * 입력이 없으면 null → 저장값 유지(직접 페이지 입력) 또는 초기화는 호출측이 결정한다.
 */
function calcTranslationPages(wordCount: string, charCount: string, sourceLanguage: string): number | null {
  const policy = getPolicy(sourceLanguage);
  if (policy?.calcType === 'word') {
    return wordCount ? calcPagesFromStr(wordCount, policy.standardValue) : null;
  }
  const std = policy?.standardValue ?? 700;
  return charCount ? calcPagesFromStr(charCount, std) : null;
}

// 할인 항목의 실제 할인 금액(양수) — amount: 입력값, percent: 비할인합계 × 값/100.
// 0 ~ 비할인합계 범위로 클램프. 백엔드 computeQuoteItemAmounts와 동일 공식.
function calcDiscountAmount(it: QuoteItemForm, nonDiscountSupply: number): number {
  const v = Number(String(it.discountValue ?? '').replace(/,/g, '') || 0);
  if (v <= 0) return 0;
  const raw = it.discountType === 'percent' ? Math.round(nonDiscountSupply * v / 100) : Math.round(v);
  return Math.max(0, Math.min(raw, nonDiscountSupply));
}
// baseSupply — 할인 항목(%)의 기준이 되는 '비할인 상품 공급가액 합계'. 비할인 항목엔 무영향.
function calcItem(it: QuoteItemForm, vat: VatType, baseSupply = 0) {
  const p = Number(it.unitPrice.replace?.(/,/g, '') || 0);
  let s: number;
  if (it.productType === 'interpretation') {
    // 통역 공급가액은 항상 원본 입력(시작일·종료일·인원·단가)에서 파생한다.
    // 화면 '수량' 입력값(오래된 상태)은 참조하지 않는다. (지시문 5·6절)
    s = calcInterpretation({
      startDate:        it.interpretDate,
      endDate:          it.interpretEndDate,
      interpreterCount: it.interpreterCount,
      unitPrice:        it.unitPrice,
    }).supplyAmount;
  } else if (it.productType === 'equipment') {
    s = Math.round((Number(it.usagePeriod) || 1) * (Number(it.quantity) || 1) * p);
  } else if (it.productType === 'translation') {
    // 번역: 수량(페이지)이 비면 공급가액 0 (단어수/글자수 삭제 시 즉시 0 — 지시문 5절)
    const q = Number(String(it.quantity).replace(/,/g, '') || 0);
    s = Math.round(q * p);
  } else if (it.productType === 'discount') {
    // 할인 항목 — 공급가액은 항상 음수(-)
    s = -calcDiscountAmount(it, baseSupply);
  } else {
    s = Math.round((Number(it.quantity) || 1) * p);
  }
  const tax = vat === 'taxable' ? Math.round(s * 0.1) : 0;  // 할인이면 s<0 → tax도 음수로 상쇄
  return { supply: s, tax, total: s + tax };
}
// 견적·판매 공용 — 폼 항목 배열의 공급가액/부가세/합계 총합(할인 반영). 판매정보 금액 요약에서도 재사용.
export function calcTotals(items: QuoteItemForm[], vat: VatType) {
  // 1) 비할인 상품 공급가 합계(할인 % 기준). 2) 할인 항목 포함 전체 합산.
  const nonDiscountSupply = items.reduce((a, it) => it.productType === 'discount' ? a : a + calcItem(it, vat).supply, 0);
  return items.reduce((a, it) => { const r = calcItem(it, vat, nonDiscountSupply); return { supply: a.supply + r.supply, tax: a.tax + r.tax, total: a.total + r.total }; }, { supply: 0, tax: 0, total: 0 });
}
function dateOffset(d: number) {
  const dt = new Date(); dt.setDate(dt.getDate() + d);
  return dt.toISOString().split('T')[0];
}

// 견적서명 불러오기: 제목이 명확한 _YYYYMMDD(유효 날짜)로 끝나면 현재 견적일의 YYYYMMDD로 교체.
//  마지막이 날짜인지 확실치 않으면(형식/범위 불일치) 원본 그대로 둔다.
function replaceTrailingDate(title: string, issueDate: string): string {
  const m = title.match(/(^|[^\d])(\d{8})$/);
  if (!m) return title;
  const d = m[2];
  const y = +d.slice(0, 4), mo = +d.slice(4, 6), da = +d.slice(6, 8);
  if (y < 2000 || y > 2999 || mo < 1 || mo > 12 || da < 1 || da > 31) return title;
  const cur = (issueDate || '').replace(/-/g, '');
  return cur.length === 8 ? title.slice(0, title.length - 8) + cur : title;
}

const QUOTE_TYPE_SHORT: Record<string, string> = {
  b2b_standard: '일반', b2c_prepaid: '차감', prepaid_deduction: '차감', accumulated_batch: '누적',
};

function defaultItem(): QuoteItemForm {
  return {
    productId: null, productName: '', productType: 'translation',
    quantity: '1', unit: SVC_DEFAULT_UNIT['translation'], unitPrice: '', taxType: 'taxable', memo: '',
    sourceLanguage: 'ko',
    fileName: '', fileFormat: '', wordCount: '', charCount: '',
    interpretDate: '', interpretEndDate: '', startTime: '', endTime: '', interpretHours: '', operationHours: '', interpretPlace: '', interpreterCount: '',
    eventStartDate: '', eventEndDate: '', itemLocation: '', usagePeriod: '',
    expenseType: '',
  };
}
function defaultItemForType(t: ServiceType): Partial<QuoteItemForm> {
  if (t === 'discount') {
    // 할인 항목 기본값 — 상품명 'Special D.C'(수정 가능), 금액 방식, 단가/수량 미사용
    return { productType: 'discount', unit: '건', productName: 'Special D.C', quantity: '1', unitPrice: '0',
             discountType: 'amount', discountValue: '', discountReason: '' };
  }
  return { productType: t, unit: SVC_DEFAULT_UNIT[t] };
}

// ─── 저장 시 API 항목 변환 ────────────────────────────────────────────────────

function toApiItem(it: QuoteItemForm, vat: VatType) {
  const base = {
    productId:  it.productId ?? undefined,
    productName: it.productName.trim(),
    unit:       it.unit || SVC_DEFAULT_UNIT[it.productType],
    quantity:   Number(it.quantity) || 1,
    unitPrice:  Number(it.unitPrice.replace?.(/,/g, '') || 0),
    taxRate:    (vat === 'taxable' ? 0.1 : 0) as 0 | 0.1,
    taxType:    vat,
    itemType:   it.productType,
  };
  switch (it.productType) {
    case 'translation': {
      const ref = [it.fileName && `파일: ${it.fileName}`, it.fileFormat && `형식: ${it.fileFormat}`, it.wordCount && `단어수: ${it.wordCount}`, it.charCount && `글자수: ${it.charCount}`].filter(Boolean).join(' | ');
      return {
        ...base,
        // 페이지 산정 정책(sourceLanguage) 복원용 — 재수정 진입 시 단어/글자 계산 기준을 정확히 복구한다.
        languagePair: it.sourceLanguage || undefined,
        memo: [it.memo, ref].filter(Boolean).join(' / ') || undefined,
        // 번역 작업기간(§2·§4) — 통역/장비와 동일한 event_start/end_date 컬럼 재사용(스키마 변경 없음).
        //   수행정보 생성 시 performanceStartDate/End 로 자동 복사됨(initialFieldsFromSale). 납품일과는 독립.
        eventStartDate: it.eventStartDate || undefined,
        eventEndDate:   it.eventEndDate   || undefined,
      };
    }
    case 'interpretation': {
      // 통역시간(안내 정보) — 하루 기준 시간 숫자(소수 허용)를 "N시간/일" 형식으로 interpretDuration 컬럼에 저장. 계산 미사용.
      const hours = (it.interpretHours ?? '').replace(/[^\d.]/g, '');
      const dur = hours ? `${hours}시간/일` : '';
      // 통역 저장 모델: 수량 = 진행일수, 인원 = 별도(interpreterCount).
      // 서버 공급가액 = 진행일수 × 인원 × 단가 (편집 화면·요약과 동일 기준).
      const { serviceDays } = calcInterpretation({
        startDate:        it.interpretDate,
        endDate:          it.interpretEndDate,
        interpreterCount: it.interpreterCount,
        unitPrice:        it.unitPrice,
      });
      const peopleCount = Number(it.interpreterCount) > 0 ? Math.round(Number(it.interpreterCount)) : 1;
      return {
        ...base,
        quantity:          serviceDays,   // 진행일수 (종료일 − 시작일 + 1)
        unit:              '일',           // 통역 단위 고정
        interpreterCount:  peopleCount,   // 투입 인원 — 서버가 공급가액에 별도로 곱함
        interpretDate:     it.interpretDate    || undefined,
        interpretPlace:    it.interpretPlace   || undefined,
        interpretDuration: dur                 || undefined,
        operationHours:    it.operationHours?.trim() || undefined,  // 운영시간(안내 정보)
        eventEndDate:      it.interpretEndDate || undefined,
        memo:              it.memo             || undefined,
      };
    }
    case 'equipment': {
      const useDays = Number(it.usagePeriod) || 1;
      return {
        ...base,
        // 서버측 공급가액(quantity × unitPrice) 정합성 유지: 사용일수 × 수량을 quantity로 전송
        quantity:       useDays * (Number(it.quantity) || 1),
        eventStartDate: it.eventStartDate || undefined,
        eventEndDate:   it.eventEndDate   || undefined,
        itemLocation:   it.itemLocation   || undefined,
        usagePeriod:    it.usagePeriod    || undefined,
        // 설치일시(선택) — 사전 설치 일정 관리용 참고정보. 계산·PDF 미반영.
        // 장비는 operationHours 컬럼을 사용하지 않으므로 이를 재활용해 저장(DB 스키마 무변경).
        // (expense가 interpretType 컬럼을 재활용하는 것과 동일한 패턴)
        operationHours: it.operationHours || undefined,
        memo:           it.memo           || undefined,
      };
    }
    case 'expense':
      return {
        ...base,
        interpretType: it.expenseType || undefined,  // 서비스 유형 (interpretType 컬럼 재활용)
        memo:          it.memo        || undefined,
      };
    case 'discount':
      // 할인 항목 — 서버가 discountType/discountValue로 음수 공급가를 재계산한다.
      return {
        ...base,
        productName:    it.productName.trim() || 'Special D.C',
        quantity:       1,
        unitPrice:      0,
        discountType:   it.discountType === 'percent' ? 'percent' : 'amount',
        discountValue:  Number(String(it.discountValue ?? '').replace(/,/g, '') || 0),
        discountReason: it.discountReason?.trim() || undefined,
        memo:           it.memo || undefined,
      };
    default:
      return { ...base, memo: it.memo || undefined };
  }
}

// ─── 공통 인풋 스타일 — DS Compact 스케일 ────────────────────────────────────
// dsInput()의 로컬 alias. 이 파일의 모든 Grid Row 입력칸에 사용.
const rinp = dsInput;

// 상품정보 Grid 레이아웃 상수(TABLE_COLS/TABLE_MIN_W/tblRow)와 유형 배지(SVC_CFG),
// 컬럼 힌트(SVC_FIELD_HINTS), 헤더 스타일(COL_H)은 판매관리 읽기전용 뷰와 공유하기 위해
// quoteItemsShared 로 이관되었다. 여기서는 import 하여 그대로 사용한다.

// ─── 행 내부 드롭다운 앵커 (fixed 포지셔닝) ───────────────────────────────────
// 상품정보 표는 폭이 좁아지면 카드 내부에서 가로 스크롤(overflow-x)이 걸린다.
// overflow 컨테이너는 CSS 규격상 세로로도 클리핑하므로, 그 안에서 아래로 열리는
// 드롭다운을 position:absolute 로 두면 잘린다. position:fixed 는 컨테이닝 블록이
// 뷰포트라 조상 overflow 에 잘리지 않으므로, 트리거(ref) 위치를 기준으로 fixed 좌표를
// 계산해 드롭다운을 띄운다. 스크롤/리사이즈 시 재계산하여 트리거에 계속 붙어 있게 한다.
function useFixedAnchor(ref: React.RefObject<HTMLElement | null>, open: boolean, gap = 3) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !ref.current) { setPos(null); return; }
    const compute = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ top: r.bottom + gap, left: r.left, width: r.width });
    };
    compute();
    window.addEventListener('scroll', compute, true);   // capture — 내부 스크롤 컨테이너 포함
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open, gap, ref]);
  return pos ?? { top: -9999, left: -9999, width: 0 };
}

// ─── 검색 팝업 ────────────────────────────────────────────────────────────────

function SearchPopup({ title, items, value, onSelect, onClose }: {
  title: string; items: { id: number; label: string; sub?: string }[]; value: number | null;
  onSelect: (id: number | null) => void; onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const filtered = q.trim() ? items.filter(i => i.label.toLowerCase().includes(q.toLowerCase()) || (i.sub ?? '').toLowerCase().includes(q.toLowerCase())).slice(0, 40) : items.slice(0, 40);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: C.bgCard, borderRadius: 14, width: 480, maxHeight: '70vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ padding: '14px 18px 10px', borderBottom: '1px solid #f0f2f5', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: C.textPrimary }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, color: C.g400, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ padding: '10px 18px', borderBottom: '1px solid #f0f2f5' }}>
          <input ref={ref} value={q} onChange={e => setQ(e.target.value)} placeholder="검색어를 입력하세요…"
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', fontSize: 14, border: '1.5px solid #6366f1', borderRadius: 8, outline: 'none' }} />
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {value !== null && <div onClick={() => { onSelect(null); onClose(); }} style={{ padding: '10px 18px', fontSize: 13, color: C.g400, cursor: 'pointer', borderBottom: '1px solid #f8f9fa' }} onMouseEnter={e => (e.currentTarget.style.background = C.g50)} onMouseLeave={e => (e.currentTarget.style.background = '')}>선택 해제</div>}
          {filtered.length === 0 && <div style={{ padding: '24px 18px', textAlign: 'center', fontSize: 13, color: C.g400 }}>검색 결과 없습니다.</div>}
          {filtered.map(item => (
            <div key={item.id} onClick={() => { onSelect(item.id); onClose(); }}
              style={{ padding: '10px 18px', cursor: 'pointer', background: item.id === value ? C.primaryBg : undefined, borderBottom: '1px solid #f8f9fa' }}
              onMouseEnter={e => { if (item.id !== value) (e.currentTarget as HTMLDivElement).style.background = C.bgHover; }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = item.id === value ? C.primaryBg : ''; }}>
              <div style={{ fontSize: 14, fontWeight: item.id === value ? 700 : 400, color: C.textPrimary }}>{item.label}</div>
              {item.sub && <div style={{ fontSize: 11, color: C.g400, marginTop: 1 }}>{item.sub}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── 인라인 검색 필드 ─────────────────────────────────────────────────────────

function InlineSearchField({ items, value, onChange, placeholder = '검색…', popupTitle = '검색', accentColor = C.ai, compact = false }: {
  items: { id: number; label: string; sub?: string }[]; value: number | null; onChange: (id: number | null) => void;
  placeholder?: string; popupTitle?: string; accentColor?: string; compact?: boolean;
}) {
  const [open, setOpen]           = useState(false);
  const [q, setQ]                 = useState('');
  const [showPopup, setShowPopup] = useState(false);
  const ref      = useRef<HTMLDivElement>(null);
  const anchor   = useFixedAnchor(ref, open, 2);
  const selected = items.find(i => i.id === value);
  const filtered = q.trim() ? items.filter(i => i.label.toLowerCase().includes(q.toLowerCase()) || (i.sub ?? '').toLowerCase().includes(q.toLowerCase())).slice(0, 12) : items.slice(0, 12);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setQ(''); } };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);

  const pad = compact ? '5px 7px' : '7px 10px';
  const fs  = compact ? 13 : 13;

  return (
    <>
      <div ref={ref} style={{ position: 'relative', display: 'flex', alignItems: 'center', border: `1px solid ${open ? accentColor : C.g300}`, borderRadius: 7, background: C.bgCard, minWidth: 0, flex: 1, transition: 'border-color 0.12s' }}>
        <input value={open ? q : (selected?.label ?? '')} onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => { setOpen(true); if (selected) setQ(''); }} placeholder={placeholder}
          style={{ flex: 1, minWidth: 0, padding: pad, fontSize: fs, border: 'none', outline: 'none', background: 'transparent', color: selected && !open ? C.textPrimary : undefined }} />
        <button type="button" title="전체 검색" onClick={() => { setOpen(false); setShowPopup(true); }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', fontSize: 12, color: C.ai, flexShrink: 0 }}>🔍</button>
        {value !== null && <button type="button" title="초기화" onClick={() => { onChange(null); setQ(''); setOpen(false); }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', fontSize: 12, color: C.g400, flexShrink: 0 }}>🧽</button>}
        {open && (
          <div style={{ position: 'fixed', top: anchor.top, left: anchor.left, width: anchor.width, zIndex: 700, background: C.bgCard, border: `1px solid ${accentColor}`, borderRadius: 9, boxShadow: '0 6px 20px rgba(0,0,0,0.1)', maxHeight: 200, overflowY: 'auto' }}>
            {value !== null && <div onClick={() => { onChange(null); setQ(''); setOpen(false); }} style={{ padding: '6px 10px', fontSize: 12, color: C.g400, cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }} onMouseEnter={e => (e.currentTarget.style.background = C.g50)} onMouseLeave={e => (e.currentTarget.style.background = '')}>선택 해제</div>}
            {filtered.length === 0 && <div style={{ padding: '8px 10px', fontSize: 12, color: C.g400 }}>결과 없음 — <span style={{ color: accentColor, cursor: 'pointer', fontWeight: 600 }} onClick={() => { setOpen(false); setShowPopup(true); }}>전체 검색 🔍</span></div>}
            {filtered.map(item => (
              <div key={item.id} onClick={() => { onChange(item.id); setQ(''); setOpen(false); }}
                style={{ padding: '6px 10px', cursor: 'pointer', background: item.id === value ? C.primaryBg : undefined }}
                onMouseEnter={e => { if (item.id !== value) (e.currentTarget as HTMLDivElement).style.background = C.bgHover; }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = item.id === value ? C.primaryBg : ''; }}>
                <div style={{ fontSize: 12, fontWeight: item.id === value ? 700 : 400, color: C.textPrimary }}>{item.label}</div>
                {item.sub && <div style={{ fontSize: 10, color: C.g400 }}>{item.sub}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
      {showPopup && <SearchPopup title={popupTitle} items={items} value={value} onSelect={onChange} onClose={() => setShowPopup(false)} />}
    </>
  );
}

// ─── Row 제어 버튼 ────────────────────────────────────────────────────────────
// 공용 컴포넌트로 추출 → './RowControls' (판매·수행정보 공용). 동작·스타일 동일.

// ─── 서비스 유형 선택 ─────────────────────────────────────────────────────────

function ServiceTypeSelector({ value, onChange }: { value: ServiceType; onChange: (t: ServiceType) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useFixedAnchor(ref, open, 2);
  const cfg = SVC_CFG[value] ?? SVC_CFG.expense;   // 미지원 유형 방어(배지 undefined 크래시 방지)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" onClick={() => setOpen(v => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 3, background: cfg.bg, color: cfg.color, border: `1.5px solid ${cfg.border}`, borderRadius: 6, padding: '3px 7px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', width: 58 }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.dot, flexShrink: 0 }} />
        {cfg.label}<span style={{ fontSize: 7, marginLeft: 'auto' }}>▼</span>
      </button>
      {open && (
        <div style={{ position: 'fixed', top: anchor.top, left: anchor.left, zIndex: 800, background: C.bgCard, border: BD.card, borderRadius: 9, boxShadow: '0 4px 20px rgba(0,0,0,0.12)', padding: 4, minWidth: 74 }}>
          {/* 할인은 별도 '+ 할인 항목' 버튼으로만 추가 — 유형 드롭다운에서는 제외 */}
          {(Object.entries(SVC_CFG) as [ServiceType, typeof SVC_CFG[ServiceType]][]).filter(([k]) => k !== 'discount').map(([k, c]) => (
            <button key={k} type="button" onClick={() => { onChange(k); setOpen(false); }}
              style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%', textAlign: 'left', padding: '5px 8px', background: value === k ? c.bg : 'transparent', color: c.color, border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: value === k ? 700 : 400 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.dot, flexShrink: 0 }} />{c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 단위 선택 — Popover 기반 커스텀 드롭다운 ──────────────────────────────────
// native <select>는 blur 이벤트로 즉시 닫혀 캡처·검수 불가.
// mousedown 기반으로만 닫기 → 스크린샷/포커스 이동 시 목록 유지.

function UnitSelect({ value, onChange, serviceType }: { value: string; onChange: (v: string) => void; serviceType: ServiceType }) {
  const [open, setOpen] = useState(false);
  const ref  = useRef<HTMLDivElement>(null);
  const anchor = useFixedAnchor(ref, open, 2);
  const opts = getUnitOptions(serviceType, value);

  useEffect(() => {
    if (!open) return;
    const onMD  = (e: MouseEvent)   => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onMD);
    document.addEventListener('keydown',   onKey);
    return () => {
      document.removeEventListener('mousedown', onMD);
      document.removeEventListener('keydown',   onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      <button type="button" onClick={() => setOpen(v => !v)}
        style={{ width: '100%', height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, border: `1px solid ${open ? C.ai : C.g300}`, borderRadius: 6, padding: '0 6px', fontSize: 13, background: C.bgCard, color: value ? C.textPrimary : C.g400, cursor: 'pointer', outline: 'none' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value || '단위'}</span>
        <span style={{ fontSize: 8, color: C.g400, flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ position: 'fixed', top: anchor.top, left: anchor.left, zIndex: 900, background: C.bgCard, border: BD.card, borderRadius: 9, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', minWidth: 72, padding: 4 }}>
          {opts.map(u => (
            <button key={u} type="button" onClick={() => { onChange(u); setOpen(false); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 9px', fontSize: 13, border: 'none', borderRadius: 6, cursor: 'pointer', background: value === u ? C.primaryBg : 'none', color: value === u ? C.primaryText : C.textPrimary, fontWeight: value === u ? 700 : 400 }}
              onMouseEnter={e => { if (value !== u) (e.currentTarget as HTMLButtonElement).style.background = C.bgHover; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = value === u ? C.primaryBg : 'none'; }}>
              {u}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 숫자 + 단위 서식 입력 (단어수/글자수 전용) ─────────────────────────────────

/** 포커스 중: 숫자만 편집 / 포커스 해제: "50,000단어" 형식 표시 */
function CountInput({ value, onChange, unit, placeholder, style, decimal = false }: {
  value:        string;
  onChange:     (raw: string) => void;
  unit:         string;
  placeholder?: string;
  style?:       React.CSSProperties;
  decimal?:     boolean;   // true: 소수점 허용 (예: 통역시간 6.5). 기본 false(정수만)
}) {
  const [focused, setFocused] = useState(false);
  const num = Number(value.replace?.(/,/g, '') || 0);
  const displayVal = focused
    ? value
    : (value ? `${num.toLocaleString()}${unit}` : '');
  return (
    <input
      value={displayVal}
      onChange={e => onChange(e.target.value.replace(decimal ? /[^\d.]/g : /[^\d]/g, ''))}
      onFocus={e => { setFocused(true); e.target.select(); }}
      onBlur={() => setFocused(false)}
      placeholder={placeholder}
      // 단어수·글자수·통역시간·인원·사용일수 등 숫자 입력은 Tabular Numbers 공통 적용 (지시문 §3·§8)
      style={{ fontVariantNumeric: 'tabular-nums', ...style }}
    />
  );
}


// ─── 파일형식 선택 ─────────────────────────────────────────────────────────
// 번역 Row 원문 파일형식 — Popover 기반

const FILE_FORMATS = [
  'Word', '한글(HWP)', 'PDF', 'PPT', 'Excel', 'JPG', 'PNG', '책', '스캔본',
] as const;

const FILE_FORMAT_CUSTOM = '기타(직접입력)';

/** 파일 확장자 → 파일형식 자동 감지 */
function detectFormatFromExt(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    doc: 'Word', docx: 'Word',
    hwp: '한글(HWP)', hwpx: '한글(HWP)',
    pdf: 'PDF',
    ppt: 'PPT', pptx: 'PPT',
    xls: 'Excel', xlsx: 'Excel',
    jpg: 'JPG', jpeg: 'JPG',
    png: 'PNG',
  };
  return map[ext] ?? '';
}

function FileFormatSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useFixedAnchor(ref, open);

  const isCustom = value !== '' && !(FILE_FORMATS as readonly string[]).includes(value);
  const btnLabel = isCustom ? FILE_FORMAT_CUSTOM : (value || '파일형식');

  useEffect(() => {
    if (!open) return;
    const onMD  = (e: MouseEvent)    => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onMD);
    document.addEventListener('keydown',   onKey);
    return () => {
      document.removeEventListener('mousedown', onMD);
      document.removeEventListener('keydown',   onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0, width: 104 }}>
      <button type="button" onClick={() => setOpen(v => !v)}
        style={{ width: '100%', height: 32, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, border: `1px solid ${open ? C.primary : C.g300}`, borderRadius: 6, padding: '0 7px', fontSize: 12, background: C.bgCard, color: value ? C.textPrimary : C.g400, cursor: 'pointer', outline: 'none' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'left' }}>
          {btnLabel}
        </span>
        <span style={{ fontSize: 8, flexShrink: 0, color: C.g400 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ position: 'fixed', top: anchor.top, left: anchor.left, zIndex: 900, background: C.bgCard, border: BD.card, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', minWidth: 114, padding: 4, maxHeight: 300, overflowY: 'auto' }}>
          {value && (
            <button type="button" onClick={() => { onChange(''); setOpen(false); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 9px', fontSize: 11, color: C.g400, background: 'none', border: 'none', borderRadius: 6, cursor: 'pointer', marginBottom: 2, whiteSpace: 'nowrap' }}
              onMouseEnter={e => (e.currentTarget.style.background = C.g100)}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
              선택 해제
            </button>
          )}
          {FILE_FORMATS.map(f => (
            <button key={f} type="button" onClick={() => { onChange(f); setOpen(false); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 9px', fontSize: 12, border: 'none', borderRadius: 6, cursor: 'pointer', background: value === f ? C.primaryBg : 'none', color: value === f ? C.primaryText : C.textSecondary, fontWeight: value === f ? 700 : 400, whiteSpace: 'nowrap' }}
              onMouseEnter={e => { if (value !== f) (e.currentTarget as HTMLButtonElement).style.background = C.bgHover; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = value === f ? C.primaryBg : 'none'; }}>
              {f}
            </button>
          ))}
          <div style={{ height: 1, background: C.g100, margin: '4px 6px' }} />
          <button type="button" onClick={() => { onChange(FILE_FORMAT_CUSTOM); setOpen(false); }}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 9px', fontSize: 12, border: 'none', borderRadius: 6, cursor: 'pointer', background: isCustom ? C.primaryBg : 'none', color: isCustom ? C.primary : C.textMuted, fontWeight: isCustom ? 700 : 400, whiteSpace: 'nowrap' }}
            onMouseEnter={e => { if (!isCustom) (e.currentTarget as HTMLButtonElement).style.background = C.bgHover; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = isCustom ? C.primaryBg : 'none'; }}>
            {FILE_FORMAT_CUSTOM}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── 기타 서비스 유형 선택 ───────────────────────────────────────────────────
// Popover 기반, mousedown 외부 클릭/ESC 시만 닫힘

const EXPENSE_TYPES = [
  '공증', '속기', '녹취', '더빙', '편집', '감수', 'DTP',
  '디자인', '인쇄', '배송', '출장', '실비', '기타',
] as const;

/** 직접 입력 모드를 나타내는 sentinel 값 */
const EXPENSE_CUSTOM = '기타(직접입력)';

function ExpenseTypeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useFixedAnchor(ref, open);

  // 미리 정의된 목록에 없는 비어 있지 않은 값 = 직접 입력 모드
  const isCustom  = value !== '' && !(EXPENSE_TYPES as readonly string[]).includes(value);
  const btnLabel  = isCustom ? EXPENSE_CUSTOM : (value || '서비스유형');

  useEffect(() => {
    if (!open) return;
    const onMD  = (e: MouseEvent)    => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onMD);
    document.addEventListener('keydown',   onKey);
    return () => {
      document.removeEventListener('mousedown', onMD);
      document.removeEventListener('keydown',   onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0, width: 120 }}>
      <button type="button" onClick={() => setOpen(v => !v)}
        style={{ width: '100%', height: 32, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, border: `1px solid ${open ? C.textMuted : C.g300}`, borderRadius: 6, padding: '0 7px', fontSize: 12, background: C.bgCard, color: value ? C.textPrimary : C.g400, cursor: 'pointer', outline: 'none' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'left' }}>
          {btnLabel}
        </span>
        <span style={{ fontSize: 8, flexShrink: 0, color: C.g400 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ position: 'fixed', top: anchor.top, left: anchor.left, zIndex: 900, background: C.bgCard, border: BD.card, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', minWidth: 130, padding: 4, maxHeight: 320, overflowY: 'auto' }}>
          {value && (
            <button type="button" onClick={() => { onChange(''); setOpen(false); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 9px', fontSize: 11, color: C.g400, background: 'none', border: 'none', borderRadius: 6, cursor: 'pointer', marginBottom: 2, whiteSpace: 'nowrap' }}
              onMouseEnter={e => (e.currentTarget.style.background = C.g100)}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
              선택 해제
            </button>
          )}
          {/* 미리 정의된 서비스 유형 */}
          {EXPENSE_TYPES.map(t => (
            <button key={t} type="button" onClick={() => { onChange(t); setOpen(false); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 9px', fontSize: 12, border: 'none', borderRadius: 6, cursor: 'pointer', background: value === t ? C.g50 : 'none', color: value === t ? C.textPrimary : C.textSecondary, fontWeight: value === t ? 700 : 400, whiteSpace: 'nowrap' }}
              onMouseEnter={e => { if (value !== t) (e.currentTarget as HTMLButtonElement).style.background = C.bgHover; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = value === t ? C.g50 : 'none'; }}>
              {t}
            </button>
          ))}
          {/* 구분선 */}
          <div style={{ height: 1, background: C.g100, margin: '4px 6px' }} />
          {/* 직접 입력 옵션 */}
          <button type="button" onClick={() => { onChange(EXPENSE_CUSTOM); setOpen(false); }}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 9px', fontSize: 12, border: 'none', borderRadius: 6, cursor: 'pointer', background: isCustom ? C.successBg : 'none', color: isCustom ? C.successText : C.textMuted, fontWeight: isCustom ? 700 : 400, whiteSpace: 'nowrap' }}
            onMouseEnter={e => { if (!isCustom) (e.currentTarget as HTMLButtonElement).style.background = C.bgHover; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = isCustom ? C.successBg : 'none'; }}>
            {EXPENSE_CUSTOM}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── 운영시간 Time Range Picker ──────────────────────────────────────────────
// 클릭 시 아래로 작은 Popover만 열림(전체 모달 아님). 시작/종료를 30분 간격 목록에서 선택.
// 직접 텍스트 입력도 허용. 저장 형식은 "09:00~13:00". 계산에는 사용하지 않는다.

const TIME_OPTIONS: string[] = (() => {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, '0');
    out.push(`${hh}:00`, `${hh}:30`);
  }
  return out; // 00:00 … 23:30 (30분 간격)
})();

/** "09:00~13:00" → { start:'09:00', end:'13:00' } (형식 불일치 시 빈 값) */
function parseTimeRange(v: string): { start: string; end: string } {
  const m = /^\s*(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})\s*$/.exec(v || '');
  return m ? { start: m[1], end: m[2] } : { start: '', end: '' };
}

/**
 * 운영시간("HH:MM~HH:MM") → 하루 통역시간(시간, 문자열). 종료 − 시작, 30분 단위 정확 계산.
 * 예: "09:00~13:00" → "4", "10:00~16:30" → "6.5". 계산 불가/음수면 빈 값.
 */
function computeHoursPerDay(range: string): string {
  const { start, end } = parseTimeRange(range);
  if (!start || !end) return '';
  const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const diff = toMin(end) - toMin(start);
  if (diff <= 0) return '';
  return String(diff / 60);  // 30분 배수 → .0/.5 정확 (예: 390분 → 6.5)
}

function TimeRangeField({ value, onChange, onConfirm, onReset, boxStyle }: {
  value: string; onChange: (v: string) => void; onConfirm?: (range: string) => void; onReset?: () => void; boxStyle: React.CSSProperties;
}) {
  const [open, setOpen]   = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd]     = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useFixedAnchor(ref, open);

  const openPicker = () => { const p = parseTimeRange(value); setStart(p.start); setEnd(p.end); setOpen(true); };

  useEffect(() => {
    if (!open) return;
    const onMD  = (e: MouseEvent)    => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onMD);
    document.addEventListener('keydown',   onKey);
    return () => { document.removeEventListener('mousedown', onMD); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // "HH:MM" 0-padding 이므로 문자열 비교 = 시간 순서 비교
  const pickStart = (t: string) => { setStart(t); if (end && end <= t) setEnd(''); };  // 종료 < 시작 방지
  const canConfirm = !!start && !!end && end > start;
  const confirm = () => {
    if (!canConfirm) return;
    const range = `${start}~${end}`;
    onChange(range);
    onConfirm?.(range);   // 운영시간 선택 완료(확인) 시에만 자동 계산 트리거 (지시문 6절)
    setOpen(false);
  };
  // 초기화 — 시작/종료/운영시간 입력값 + 통역시간(부모 onReset)까지 함께 비운다.
  // 팝업은 닫지 않아 사용자가 바로 다시 선택할 수 있다.
  const reset = () => {
    setStart('');
    setEnd('');
    onChange('');   // 운영시간(operationHours) 값 삭제
    onReset?.();    // 통역시간(interpretHours) 등 연동 값 삭제 (부모가 결정)
  };

  const column = (label: string, sel: string, onPick: (t: string) => void, opts: string[]) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, textAlign: 'center' }}>{label}</span>
      <div style={{ height: 150, width: 74, overflowY: 'auto', border: BD.card, borderRadius: 6 }}>
        {opts.map(t => (
          <button key={t} type="button" onClick={() => onPick(t)}
            style={{ display: 'block', width: '100%', textAlign: 'center', padding: '4px 0', fontSize: 12, border: 'none',
              background: sel === t ? C.primaryBg : 'none', color: sel === t ? C.primaryText : C.textPrimary,
              fontWeight: sel === t ? 700 : 400, cursor: 'pointer' }}
            onMouseEnter={e => { if (sel !== t) (e.currentTarget as HTMLButtonElement).style.background = C.bgHover; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = sel === t ? C.primaryBg : 'none'; }}>
            {t}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      {/* 입력칸 — 어디를 클릭해도 Popover 열림 + 직접 입력 허용 (기존 입력칸과 동일 크기/디자인) */}
      <div onClick={() => { if (!open) openPicker(); }}
        style={{ ...boxStyle, display: 'flex', alignItems: 'center', gap: 2, padding: 0, overflow: 'hidden', cursor: 'pointer' }}>
        <input value={value} onChange={e => onChange(e.target.value)} placeholder="예: 09:00~13:00"
          style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontSize: 13, padding: '0 5px', height: '100%', cursor: 'pointer' }}
          title="운영시간 (클릭하여 선택 또는 직접 입력, 예: 09:00~18:00). 공급가액 계산에는 사용되지 않습니다." />
        <span aria-hidden style={{ fontSize: 9, color: C.g400, padding: '0 4px', flexShrink: 0, userSelect: 'none' }}>▼</span>
      </div>
      {open && (
        <div style={{ position: 'fixed', top: anchor.top, left: anchor.left, zIndex: 900, background: C.bgCard, border: BD.card, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', padding: 10, width: 190 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textPrimary, marginBottom: 6 }}>운영시간</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            {column('시작', start, pickStart, TIME_OPTIONS)}
            {column('종료', end, setEnd, start ? TIME_OPTIONS.filter(t => t > start) : TIME_OPTIONS)}
          </div>
          <div style={{ fontSize: 11, color: canConfirm ? C.textSecondary : C.g400, textAlign: 'center', marginTop: 8, marginBottom: 6 }}>
            {start && end ? `${start}~${end}` : '시작·종료 선택'}
          </div>
          {/* 하단 버튼 — [초기화](보조·회색) ↔ [확인](주 기능, 기존 디자인 유지) */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <button type="button" onClick={reset} aria-label="운영시간 초기화" data-testid="btn-optime-reset"
              style={{ border: `1px solid ${C.g300}`, borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', background: C.g100, color: C.textSecondary }}>초기화</button>
            <button type="button" onClick={confirm} disabled={!canConfirm} aria-label="운영시간 확인" data-testid="btn-optime-confirm"
              style={{ border: 'none', borderRadius: 6, padding: '4px 14px', fontSize: 12, fontWeight: 700, cursor: canConfirm ? 'pointer' : 'default', background: canConfirm ? C.primary : C.g300, color: '#fff' }}>확인</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 기간(시작일~종료일) Date Range Picker ───────────────────────────────────
// 통역·장비 공통 입력 UI. 화면에는 "단일 기간 필드"만 표시하고, 클릭 시 팝오버에서
// 시작일/종료일(native date)을 선택한다. 저장·계산은 기존과 100% 동일하게
// start/end 2개 값을 그대로 유지한다(DB 구조·로직 불변, 지시문 §1·§3·§9).
//   · 하루(종료 미입력 또는 시작=종료) → "2026-07-17" 단일 표시, end='' 로 저장(당일 규약)
//   · 여러 날 → "2026-07-17 ~ 2026-07-22"
// (calcSpanDays·interpretationServiceDays 모두 end 미입력/동일을 1일로 처리 → 정규화 안전)
function DateRangeField({ start, end, onChange, boxStyle, title = '기간', startTitle, endTitle }: {
  start: string; end: string;
  onChange: (start: string, end: string) => void;
  boxStyle: React.CSSProperties;
  title?: string; startTitle?: string; endTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const [s, setS]       = useState('');
  const [e, setE]       = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useFixedAnchor(ref, open);

  const openPicker = () => { setS(start); setE(end); setOpen(true); };

  useEffect(() => {
    if (!open) return;
    // 바깥 클릭 자동닫기 비활성화(지시문 §8): 네이티브 날짜 피커는 문서 외부 오버레이로 뜨는데,
    // 그 클릭(달력 날짜 선택)이나 캡처/마우스 이동이 '바깥 클릭'으로 잡혀 팝업이 실수로 닫히던 문제 방지.
    // 닫힘은 [확인](confirm) 또는 ESC 로만. (시작/종료 선택·초기화로는 닫지 않는다.)
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [open]);

  // 표시: 없음 → placeholder / 하루(종료 없음·동일) → 시작 / 여러 날 → 시작 ~ 종료.
  //  · 편집화면은 입력 정확성 우선 — 연도 축약 없이 전체 YYYY-MM-DD 표시(읽기화면의 간결 formatter와 혼용 금지, 수행정보 편집과 통일).
  const display       = !start ? '' : (!end || end === start) ? start : `${start} ~ ${end}`;
  const startAfterEnd = !!s && !!e && e < s;   // 종료 < 시작 (수동 입력 방어)

  const confirm = () => {
    let ne = e;
    if (ne && s && ne < s) ne = '';   // 잘못된 역전 → 당일 처리
    if (ne === s) ne = '';            // 시작=종료 → 당일(중복 저장 안 함, end='')
    onChange(s, ne);
    setOpen(false);
  };
  const reset = () => { setS(''); setE(''); onChange('', ''); };

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      {/* 단일 기간 필드 — 클릭 시 팝오버 오픈 (읽기 표시) */}
      <div onClick={() => { if (!open) openPicker(); }}
        data-testid="field-date-range" aria-label={title} title={display || title}
        style={{ ...boxStyle, display: 'flex', alignItems: 'center', gap: 2, padding: 0, overflow: 'hidden', cursor: 'pointer' }}>
        <span style={{ flex: 1, minWidth: 0, padding: '0 6px 0 8px', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          color: display ? C.textPrimary : C.g400 }}>{display || '날짜 선택'}</span>
        {/* 드롭다운 표식 — 우측 내부 여백 축소(0 6px → 0 4px 0 2px). 날짜 텍스트와는 최소 간격 유지 */}
        <span aria-hidden style={{ fontSize: 9, color: C.g400, padding: '0 4px 0 2px', flexShrink: 0, userSelect: 'none' }}>▼</span>
      </div>
      {open && (
        <div style={{ position: 'fixed', top: anchor.top, left: anchor.left, zIndex: 900, background: C.bgCard, border: BD.card, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', padding: 10, width: 236 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textPrimary, marginBottom: 8 }}>{title}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: C.textMuted, fontWeight: 700 }}>
              <span style={{ width: 30, flexShrink: 0 }}>시작</span>
              <input type="date" value={s} onChange={ev => { const v = ev.target.value; setS(v); if (e && e < v) setE(''); }}
                style={{ ...rinp('100%'), height: 30 }} title={startTitle} data-testid="input-daterange-start" />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: C.textMuted, fontWeight: 700 }}>
              <span style={{ width: 30, flexShrink: 0 }}>종료</span>
              <input type="date" value={e} min={s || undefined} onChange={ev => setE(ev.target.value)}
                style={{ ...rinp('100%'), height: 30 }} title={endTitle} data-testid="input-daterange-end" />
            </label>
          </div>
          <div style={{ fontSize: 10, color: startAfterEnd ? C.danger : C.textMuted, marginTop: 6 }}>
            {startAfterEnd ? '⚠ 종료일이 시작일보다 빠릅니다' : '당일 일정은 종료일을 비워두세요'}
          </div>
          {/* 월 이동 안내 — 브라우저 native 달력 사용법 보조문구(작고 자연스럽게, 기존 안내문구 스타일 재사용) */}
          <div style={{ fontSize: 10, color: C.textMuted, marginTop: 4 }}>
            월 이동: ▲ 이전 달 · ▼ 다음 달
          </div>
          {/* 하단 버튼 — [초기화](보조) ↔ [확인] (TimeRangeField와 동일 규격) */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8 }}>
            <button type="button" onClick={reset} aria-label={`${title} 초기화`} data-testid="btn-daterange-reset"
              style={{ border: `1px solid ${C.g300}`, borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', background: C.g100, color: C.textSecondary }}>초기화</button>
            <button type="button" onClick={confirm} disabled={!s} aria-label={`${title} 확인`} data-testid="btn-daterange-confirm"
              style={{ border: 'none', borderRadius: 6, padding: '4px 14px', fontSize: 12, fontWeight: 700, cursor: s ? 'pointer' : 'default', background: s ? C.primary : C.g300, color: '#fff' }}>확인</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 설치일시(선택) Date+Time Picker — 장비 전용 ─────────────────────────────
// 네이티브 datetime-local/time picker 의 한계(시스템 placeholder·시간 잘림·OS 팝업 겹침·
// 즉시 닫힘)를 피하기 위한 완전 커스텀 피커. 화면 표시는 "26-07-20 10:00"(견적 화면 형식 통일).
// 팝업 내부에서 날짜 + 시·분(5분 단위) 목록으로 선택 → [확인]으로만 확정(바깥 클릭 전까지 유지).
// 저장은 "YYYY-MM-DD HH:MM" 문자열(operationHours 컬럼 재활용) — 선택 입력, 계산·PDF 미반영.
const INSTALL_HOURS   = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')); // 00..23 (24시간제)
const INSTALL_MINUTES = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55']; // 5분 단위

function InstallDateTimeField({ value, onChange, boxStyle, prefix }: {
  value: string; onChange: (v: string) => void; boxStyle: React.CSSProperties; prefix?: string;
}) {
  // 저장 문자열 파싱 — "YYYY-MM-DD HH:MM" 및 레거시 datetime-local "YYYY-MM-DDTHH:MM" 모두 허용
  const parse = (v: string) => {
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(v || '');
    return m ? { d: m[1], h: m[2], mi: m[3] } : { d: '', h: '', mi: '' };
  };
  const [open, setOpen] = useState(false);
  const [d, setD]   = useState('');   // 임시 날짜
  const [h, setH]   = useState('');   // 임시 시
  const [mi, setMi] = useState('');   // 임시 분
  const ref = useRef<HTMLDivElement>(null);
  const hourRef = useRef<HTMLDivElement>(null);
  const minRef  = useRef<HTMLDivElement>(null);
  const anchor = useFixedAnchor(ref, open);
  // 레거시 데이터(5분 배수가 아닌 분)도 선택/표시되도록 저장된 분을 목록에 포함
  const minuteOpts = (mi && !INSTALL_MINUTES.includes(mi)) ? [...INSTALL_MINUTES, mi].sort() : INSTALL_MINUTES;

  const openPicker = () => { const p = parse(value); setD(p.d); setH(p.h); setMi(p.mi); setOpen(true); };

  // 바깥 클릭/Esc → 임시값 폐기하고 닫기(저장값 유지). 팝업 내부 클릭은 ref.contains 로 유지(§6·§7)
  useEffect(() => {
    if (!open) return;
    const onMD  = (ev: MouseEvent)    => { if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onMD);
    document.addEventListener('keydown',   onKey);
    return () => { document.removeEventListener('mousedown', onMD); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // 팝업 열릴 때 시·분 목록을 현재 선택값 위치로 스크롤 (§4 — 저장된 시/분이 맨 위 00에 가려지지 않고 바로 보이도록)
  useLayoutEffect(() => {
    if (!open) return;
    const center = (el: HTMLDivElement | null, idx: number, total: number) => {
      if (!el || idx < 0 || total <= 0) return;
      const itemH = el.scrollHeight / total;
      el.scrollTop = Math.max(0, idx * itemH - (el.clientHeight - itemH) / 2);
    };
    center(hourRef.current, INSTALL_HOURS.indexOf(h), INSTALL_HOURS.length);
    center(minRef.current,  minuteOpts.indexOf(mi),   minuteOpts.length);
    // open 진입 시 1회만 정렬 (h/mi/minuteOpts 는 openPicker 가 이미 설정) — 사용자 클릭 시 재스크롤 방지
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const parsed  = parse(value);
  // 표시 — "26-07-20 10:00" (2자리 연도, 분까지). 값이 없으면 placeholder
  const display = parsed.d ? (parsed.h && parsed.mi ? `${parsed.d.slice(2)} ${parsed.h}:${parsed.mi}` : parsed.d.slice(2)) : '';

  const allSet   = !!d && !!h && !!mi;
  const allEmpty = !d && !h && !mi;
  const partial  = !allSet && !allEmpty;   // 일부만 선택 → 저장 차단(§11)

  // 확인 — 모두 선택: 저장 / 모두 비움: 빈 값(삭제) / 일부만: 차단
  const confirm = () => { if (partial) return; onChange(allSet ? `${d} ${h}:${mi}` : ''); setOpen(false); };
  const reset   = () => { setD(''); setH(''); setMi(''); };   // 임시값만 비움 → 확인 시 반영(§8)

  // 시·분 목록 — 팝업 내부 인라인(하단 버튼을 가리지 않음), 클릭 선택(빠른 스크롤 없음)(§3·§5)
  const timeCol = (listRef: React.RefObject<HTMLDivElement | null>, sel: string, onPick: (v: string) => void, opts: string[], testid: string) => (
    <div ref={listRef} data-testid={testid} style={{ height: 116, width: 56, overflowY: 'auto', border: BD.card, borderRadius: 6 }}>
      {opts.map(o => (
        <button key={o} type="button" onClick={() => onPick(o)}
          style={{ display: 'block', width: '100%', textAlign: 'center', padding: '5px 0', fontSize: 13, border: 'none',
            background: sel === o ? C.primaryBg : 'none', color: sel === o ? C.primaryText : C.textPrimary,
            fontWeight: sel === o ? 700 : 400, cursor: 'pointer' }}
          onMouseEnter={e => { if (sel !== o) (e.currentTarget as HTMLButtonElement).style.background = C.bgHover; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = sel === o ? C.primaryBg : 'none'; }}>
          {o}
        </button>
      ))}
    </div>
  );

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      {/* 단일 필드 — 클릭 시 팝오버. 시스템 placeholder 대신 "설치일시(선택)" 표시 */}
      <div onClick={() => { if (!open) openPicker(); }}
        data-testid="field-equip-install" aria-label="설치일시(선택)" title={display || '설치일시 (선택)'}
        style={{ ...boxStyle, display: 'flex', alignItems: 'center', gap: 0, padding: 0, overflow: 'hidden', cursor: 'pointer' }}>
        {/* Prefix(addon) — 입력창 내부 좌측 라벨. UI 전용(저장값 미포함). 우측 border로 한 컨트롤처럼 분리 */}
        {prefix && (
          <span aria-hidden style={{ flexShrink: 0, alignSelf: 'stretch', display: 'flex', alignItems: 'center', padding: '0 5px', fontSize: 11, color: C.textMuted, background: C.g50, borderRight: BD.divider, userSelect: 'none' }}>{prefix}</span>
        )}
        <span style={{ flex: 1, minWidth: 0, padding: '0 6px 0 8px', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          color: display ? C.textPrimary : C.g400 }}>{display || '설치일시(선택)'}</span>
        <span aria-hidden style={{ fontSize: 9, color: C.g400, padding: '0 4px 0 2px', flexShrink: 0, userSelect: 'none' }}>▼</span>
      </div>
      {open && (
        <div style={{ position: 'fixed', top: anchor.top, left: anchor.left, zIndex: 900, background: C.bgCard, border: BD.card, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', padding: 10, width: 236 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textPrimary, marginBottom: 8 }}>설치일시 (선택)</div>
          {/* 날짜 */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: C.textMuted, fontWeight: 700 }}>
            <span style={{ width: 30, flexShrink: 0 }}>날짜</span>
            <input type="date" value={d} onChange={ev => setD(ev.target.value)} style={{ ...rinp('100%'), height: 30 }} data-testid="input-install-date" />
          </label>
          {/* 시간 — 커스텀 시·분 목록(브라우저 기본 time picker 미사용). 인라인이라 하단 버튼 안 가림(§1·§2·§5) */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8 }}>
            <span style={{ width: 30, flexShrink: 0, fontSize: 11, color: C.textMuted, fontWeight: 700, paddingTop: 6 }}>시간</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {timeCol(hourRef, h, setH, INSTALL_HOURS, 'list-install-hour')}
              <span style={{ fontSize: 14, fontWeight: 800, color: C.textMuted }}>:</span>
              {timeCol(minRef, mi, setMi, minuteOpts, 'list-install-min')}
              <span style={{ fontSize: 13, fontWeight: 700, color: h && mi ? C.textPrimary : C.g400, minWidth: 42, paddingLeft: 2 }}>{h && mi ? `${h}:${mi}` : '--:--'}</span>
            </div>
          </div>
          {/* 안내/검증(§11) — 일부만 선택 시 경고 */}
          <div style={{ fontSize: 10, color: partial ? C.danger : C.textMuted, marginTop: 6 }}>
            {partial ? '설치 날짜와 시간을 모두 선택해 주세요.' : '전일·야간·새벽 설치 등 참고용 (계산·PDF 미반영)'}
          </div>
          {/* 하단 버튼 — 인라인 시간목록이라 항상 접근 가능. [취소]/[확인]으로만 확정(§4·§5·§6) */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 8 }}>
            <button type="button" onClick={reset} aria-label="설치일시 초기화" data-testid="btn-install-reset"
              style={{ border: `1px solid ${C.g300}`, borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', background: C.g100, color: C.textSecondary }}>초기화</button>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" onClick={() => setOpen(false)} aria-label="취소" data-testid="btn-install-cancel"
                style={{ border: `1px solid ${C.g300}`, borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', background: C.bgCard, color: C.textSecondary }}>취소</button>
              <button type="button" onClick={confirm} disabled={partial} aria-label="확인" data-testid="btn-install-confirm"
                style={{ border: 'none', borderRadius: 6, padding: '4px 14px', fontSize: 12, fontWeight: 700, cursor: partial ? 'default' : 'pointer', background: partial ? C.g300 : C.primary, color: '#fff' }}>확인</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 서비스 유형별 동적 필드 ─────────────────────────────────────────────────

function ServiceFields({ it, update, products }: {
  it: QuoteItemForm;
  update: (p: Partial<QuoteItemForm>) => void;
  products: Product[];
}) {
  switch (it.productType) {
    case 'translation': {
      // 출발언어는 상품 Master에서 자동 설정 (sourceLanguage in QuoteItemForm)
      // 사용자가 직접 언어를 선택하지 않음 — 상품 Master가 Single Source of Truth
      const policy = getPolicy(it.sourceLanguage);

      // char 기준 언어(또는 정책 없음) 여부 — 글자수가 수량을 결정하는 경우
      const charDrivesQty = policy?.calcType === 'character' || !policy;

      // 글자수 변경: char 기준 언어 → 수량 갱신 / 삭제 시 즉시 초기화 (지시문 5절)
      const handleCharChange = (v: string) => {
        const upd: Partial<QuoteItemForm> = { charCount: v };
        if (charDrivesQty) {
          const pages = calcTranslationPages('', v, it.sourceLanguage);
          upd.quantity = pages !== null ? String(pages) : '';  // 삭제/무효 → 수량 초기화
          upd.unit = '페이지';
        }
        update(upd);
      };

      // 단어수 변경: word 기준 언어 → 수량 갱신 / 삭제 시 즉시 초기화 (지시문 5절)
      const handleWordChange = (v: string) => {
        const upd: Partial<QuoteItemForm> = { wordCount: v };
        if (policy?.calcType === 'word') {
          const pages = calcTranslationPages(v, '', it.sourceLanguage);
          upd.quantity = pages !== null ? String(pages) : '';  // 삭제/무효 → 수량 초기화
          upd.unit = '페이지';
        }
        update(upd);
      };

      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {/* 작업기간(§2) — 통역/장비와 동일한 Date Range Picker.
              날짜 박스 폭은 통역/장비와 동일하게 200px 로 통일(시작~종료 YYYY-MM-DD 전체가 잘리지 않도록).
              저장은 eventStartDate/eventEndDate(납품일과 독립) */}
          <DateRangeField start={it.eventStartDate} end={it.eventEndDate}
            onChange={(s, e) => update({ eventStartDate: s, eventEndDate: e })}
            boxStyle={{ ...rinp(200), height: 32 }}
            title="번역 작업기간" startTitle="작업 시작일" endTitle="작업 종료일 (당일은 비워두세요)" />
          {/* 파일명 — 확장자 감지 시 파일형식 자동 설정 */}
          <input value={it.fileName}
            onChange={e => {
              const name = e.target.value;
              const upd: Partial<QuoteItemForm> = { fileName: name };
              if (!it.fileFormat) {
                const detected = detectFormatFromExt(name);
                if (detected) upd.fileFormat = detected;
              }
              update(upd);
            }}
            placeholder="파일명" style={{ ...rinp('auto'), flex: 1, minWidth: 60 }} title="원본 파일명" />
          {/* 파일형식 선택 (Popover) */}
          <FileFormatSelect value={it.fileFormat} onChange={v => update({ fileFormat: v })} />
          {/* 기타(직접입력) 모드일 때 텍스트 입력 */}
          {(it.fileFormat === FILE_FORMAT_CUSTOM ||
            (it.fileFormat !== '' && !(FILE_FORMATS as readonly string[]).includes(it.fileFormat))) && (
            <input
              value={it.fileFormat === FILE_FORMAT_CUSTOM ? '' : it.fileFormat}
              onChange={e => update({ fileFormat: e.target.value || FILE_FORMAT_CUSTOM })}
              placeholder="형식 입력 (예: InDesign, CAD)"
              style={{ ...rinp(90), flexShrink: 0 }}
              autoFocus={it.fileFormat === FILE_FORMAT_CUSTOM}
            />
          )}
          {/* 단어수 — 천 단위 콤마 + "단어". word 기준 언어 시 수량 자동 갱신 */}
          <CountInput value={it.wordCount} onChange={handleWordChange}
            unit="단어" placeholder="단어수" style={rinp(88)} />
          {/* 글자수 — 천 단위 콤마 + "글자". char 기준 언어 시 수량 자동 갱신 */}
          <CountInput value={it.charCount} onChange={handleCharChange}
            unit="글자" placeholder="글자수" style={rinp(88, { color: C.textSecondary })} />
        </div>
      );
    }
    case 'interpretation': {
      // 날짜 유효성 검증용 파생값 (종료일 < 시작일 경고에만 사용). 계산 로직은 calcItem에서 별도 수행.
      const interp = calcInterpretation({
        startDate:        it.interpretDate,
        endDate:          it.interpretEndDate,
        interpreterCount: it.interpreterCount,
        unitPrice:        it.unitPrice,
      });
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'nowrap' }}>
            {/* ① 기간 — 단일 기간 필드(Date Range Picker). 저장은 start/end 2필드 유지 */}
            <DateRangeField start={it.interpretDate} end={it.interpretEndDate}
              onChange={(s, e) => update({ interpretDate: s, interpretEndDate: e })}
              boxStyle={{ ...rinp(200), height: 32 }}
              title="행사 기간" startTitle="행사 시작일" endTitle="행사 종료일 (당일은 비워두세요)" />
            {/* ② 운영시간 — Time Range Picker. 확인 시 통역시간 자동 계산(사용자 수정 가능) */}
            {/* 확정 시 operationHours(표시값)와 interpretHours(계산값)를 '한 번의 update'로 함께 반영한다.
                두 값을 각각 update 하면 updateItem 이 같은 items 스냅샷을 map 하여 뒤 update 가 앞을 덮어써
                operationHours(선택 시간대)가 사라진다(계산값만 남던 버그). */}
            <TimeRangeField value={it.operationHours}
              onChange={v => update({ operationHours: v })}
              onConfirm={range => { const h = computeHoursPerDay(range); update(h ? { operationHours: range, interpretHours: h } : { operationHours: range }); }}
              onReset={() => update({ operationHours: '', interpretHours: '' })}
              boxStyle={{ ...rinp(132), height: 32 }} />
            {/* ③ 시간/일 — 하루 기준 통역시간(안내 정보, 계산 미사용) */}
            <CountInput value={it.interpretHours} onChange={v => update({ interpretHours: v })}
              unit="시간/일" placeholder="통역시간" decimal style={{ ...rinp(86, { paddingLeft: 5, paddingRight: 5 }), flexShrink: 0 }} />
            {/* ④ 인원 — 투입 인원 "2명" 표시 */}
            <CountInput value={it.interpreterCount} onChange={v => update({ interpreterCount: v })}
              unit="명" placeholder="인원" style={{ ...rinp(56, { paddingLeft: 5, paddingRight: 5 }), flexShrink: 0 }} />
            {/* ⑤ 장소 — 시간 그룹 뒤 마지막 배치. 남는 공간 우선 흡수(flex:1) + 최소폭 보장 (§1·§5·§8) */}
            <input value={it.interpretPlace}
              onChange={e => update({ interpretPlace: e.target.value })}
              placeholder="장소" style={{ ...rinp('auto'), flex: 1, minWidth: 100 }} title="행사 장소" />
          </div>
          {/* 날짜 오류 경고만 유지 (정보성 안내 문구는 제거 — 값이 이미 각 컬럼에 표시됨) */}
          {interp.invalidDateRange && (
            <span style={{ fontSize: 10, color: C.danger, fontWeight: 600 }}>
              ⚠ 종료일이 시작일보다 빠릅니다. 날짜를 확인해 주세요.
            </span>
          )}
        </div>
      );
    }
    case 'equipment':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'nowrap' }}>
          {/* ① 기간 — 통역과 동일한 단일 기간 필드(Date Range Picker). 확인 시 사용일수 자동 재계산 */}
          <DateRangeField start={it.eventStartDate} end={it.eventEndDate}
            onChange={(s, e) => {
              const upd: Partial<QuoteItemForm> = { eventStartDate: s, eventEndDate: e };
              const days = calcSpanDays(s, e);
              if (days > 0) upd.usagePeriod = String(days);   // 종료일 − 시작일 + 1
              update(upd);
            }}
            boxStyle={{ ...rinp(200), height: 32 }}
            title="사용 기간" startTitle="사용 시작일" endTitle="사용 종료일 (당일은 비워두세요)" />
          {/* ② 설치일시(선택) — 전일·야간·새벽·대형 장비 등 사전 설치 일정 관리용 참고정보.
              사용일수·공급가액 계산에 영향 없음, PDF·출력물 미표시. 저장은 operationHours 컬럼
              재활용(장비 미사용) — DB·API 무변경.
              "설치"는 입력창 내부 Prefix(UI 전용, 저장값 미포함) — 사용기간과 구분해 하나의 컨트롤로 인식. */}
          <InstallDateTimeField value={it.operationHours}
            onChange={v => update({ operationHours: v })}
            prefix="설치"
            boxStyle={{ ...rinp(200), height: 32 }} />
          {/* ③ 사용일수 — 날짜 입력 시 자동 계산, 직접 수정도 가능 (통역과 동일 흐름: 기간→수량→장소) */}
          <CountInput value={it.usagePeriod} onChange={v => update({ usagePeriod: v })}
            unit="일" placeholder="사용일수" style={{ ...rinp(72), flexShrink: 0 }} />
          {/* ④ 사용 장소 — 마지막 배치. 남는 공간 우선 흡수(flex:1) + 최소폭 보장 (§2·§5) */}
          <input value={it.itemLocation}
            onChange={e => update({ itemLocation: e.target.value })}
            placeholder="사용 장소" style={{ ...rinp('auto'), flex: 1, minWidth: 100 }} title="장비 사용 장소" />
        </div>
      );
    case 'expense': {
      // EXPENSE_CUSTOM sentinel 또는 미리 정의 목록 외 값 = 직접 입력 모드
      const isCustomInput = it.expenseType === EXPENSE_CUSTOM ||
        (it.expenseType !== '' && !(EXPENSE_TYPES as readonly string[]).includes(it.expenseType));
      // 텍스트 입력란에 표시할 값 — sentinel 자체는 빈 문자열 표시
      const customDisplayValue = it.expenseType === EXPENSE_CUSTOM ? '' : it.expenseType;
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <ExpenseTypeSelect value={it.expenseType} onChange={v => update({ expenseType: v })} />
          {isCustomInput && (
            <input
              value={customDisplayValue}
              onChange={e => update({ expenseType: e.target.value || EXPENSE_CUSTOM })}
              placeholder="서비스명 입력 (예: 행사 운영, AI 음성합성)"
              style={{ ...rinp('auto'), flex: 1, minWidth: 100 }}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus={it.expenseType === EXPENSE_CUSTOM}
            />
          )}
        </div>
      );
    }
    default:
      return <div />;
  }
}

// ─── 견적 항목 Row ────────────────────────────────────────────────────────────

function QuoteItemRow({ it, idx, total, vatType, baseSupply, products, updateItem, removeItem, addItemBelow, moveItem }: {
  it: QuoteItemForm; idx: number; total: number; vatType: VatType; baseSupply: number; products: Product[];
  updateItem: (idx: number, p: Partial<QuoteItemForm>) => void;
  removeItem: (idx: number) => void;
  addItemBelow: (idx: number) => void;
  moveItem: (idx: number, dir: 'up' | 'down') => void;
}) {
  const [showWarning, setShowWarning] = useState(false);
  const supply = calcItem(it, vatType, baseSupply).supply;
  // 미지원 유형(저장된 레거시/카탈로그 확장)이라도 배지 설정이 없어 크래시하지 않도록 기타로 폴백.
  const cfg    = SVC_CFG[it.productType] ?? SVC_CFG.expense;

  // ── 할인 항목 전용 행 (일반 상품 그리드와 다른 입력 필드) ──────────────────
  if (it.productType === 'discount') {
    const dcAmount = calcDiscountAmount(it, baseSupply);   // 양수 할인액
    return (
      <div style={{ ...tblRow, borderBottom: `1px solid ${C.g100}`, minHeight: 42, background: C.dangerBg, transition: 'background 0.1s' }}>
        {/* ① 행 제어 */}
        <div>
          <RowControls idx={idx} total={total} onRemove={removeItem} onAddBelow={addItemBelow}
            onMoveUp={i => moveItem(i, 'up')} onMoveDown={i => moveItem(i, 'down')} />
        </div>
        {/* ② 유형 배지(할인) */}
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <span style={{ ...TYPO.badge, color: cfg.color, background: C.bgCard, border: `1.5px solid ${cfg.border}`, borderRadius: 6, padding: '3px 8px', fontWeight: 700 }}>할인</span>
        </div>
        {/* ③ 상품명(수정 가능, 기본 Special D.C) */}
        <div style={{ display: 'flex' }}>
          <input value={it.productName} onChange={e => updateItem(idx, { productName: e.target.value })}
            placeholder="Special D.C" data-testid="input-discount-name" aria-label="할인 상품명"
            style={{ ...rinp('100%'), fontWeight: 600 }} />
        </div>
        {/* ④ 동적 필드 — 할인방식 / 할인값 / 할인사유 */}
        <div style={{ minWidth: 0, display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 3 }}>
            {(['amount', 'percent'] as DiscountType[]).map(t => (
              <button key={t} type="button"
                onClick={() => updateItem(idx, { discountType: t })}
                data-testid={`btn-discount-type-${t}`} aria-label={t === 'amount' ? '금액 할인' : '비율 할인'}
                style={{ padding: '5px 11px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
                  border: `1px solid ${(it.discountType ?? 'amount') === t ? C.danger : C.g300}`,
                  background: (it.discountType ?? 'amount') === t ? C.danger : C.bgCard,
                  color: (it.discountType ?? 'amount') === t ? '#fff' : C.textSecondary }}>
                {t === 'amount' ? '금액' : '%'}
              </button>
            ))}
          </div>
          <NumericInput value={it.discountValue ?? ''} onChange={v => updateItem(idx, { discountValue: v })}
            placeholder={(it.discountType ?? 'amount') === 'percent' ? '할인율' : '할인금액'}
            suffix={(it.discountType ?? 'amount') === 'percent' ? '%' : '원'}
            style={rinp(130, { textAlign: 'right' })} />
          <input value={it.discountReason ?? ''} onChange={e => updateItem(idx, { discountReason: e.target.value })}
            placeholder="할인 사유 (내부용 · PDF 미출력)" data-testid="input-discount-reason" aria-label="할인 사유"
            style={{ ...rinp('100%'), color: C.textMuted, flex: 1, minWidth: 120 }} />
        </div>
        {/* ⑤ AI (없음) */}
        <div />
        {/* ⑥ 수량 (없음) */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.g400 }}>—</div>
        {/* ⑦ 단위 (없음) */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.g400 }}>—</div>
        {/* ⑧ 단가 (없음) */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', color: C.g400, paddingRight: 6 }}>—</div>
        {/* ⑨ 공급가액 — 음수(빨강). 폰트·크기·굵기·tabular 는 일반 공급가액과 동일, 색상만 다르게 (지시문 §4·§7) */}
        <div style={dsAmount(dcAmount > 0, { paddingRight: 6, color: dcAmount > 0 ? C.danger : C.amountEmpty })}
          data-testid="discount-supply">
          {dcAmount > 0 ? `-${formatWon(dcAmount)}` : '—'}
        </div>
        {/* ⑩ 비고 */}
        <div style={{ borderLeft: '2px solid #e5e7eb', paddingLeft: 14 }}>
          <input value={it.memo} onChange={e => updateItem(idx, { memo: e.target.value })}
            placeholder="비고" style={{ ...rinp('100%'), color: C.textMuted }} />
        </div>
      </div>
    );
  }
  // 통역 파생 계산수량(인원 × 일수) — 수량 컬럼 읽기전용 표시에 사용
  const interp = it.productType === 'interpretation'
    ? calcInterpretation({
        startDate:        it.interpretDate,
        endDate:          it.interpretEndDate,
        interpreterCount: it.interpreterCount,
        unitPrice:        it.unitPrice,
      })
    : null;

  // 번역 항목 교차검증 (글자수·단어수 모두 입력된 경우에만)
  const validationPolicy = it.productType === 'translation' ? getPolicy(it.sourceLanguage) : null;
  const validation: ValidationResult | null = (
    validationPolicy && it.charCount && it.wordCount
  ) ? validateCounts(validationPolicy, it.charCount, it.wordCount) : null;

  // 상품 선택 시 productType, unit, sourceLanguage 자동 적용
  const selectProduct = (pid: number | null) => {
    const p = pid != null ? products.find(pr => pr.id === pid) : null;
    // 상품 선택 시: 지원 유형은 그대로, 미지원 카탈로그 유형(project/proofreading 등)은 기타로 정규화.
    // 상품 해제(pid=null)면 현재 행 유형 유지.
    const productType: ServiceType = p ? normalizeServiceType(p.productType) : it.productType;
    updateItem(idx, {
      productId: p?.id ?? null,
      productName: p?.name ?? '',
      productType,
      // 통역 단위는 항상 '일'로 고정 (상품 마스터의 '시간' 등 단위에 좌우되지 않음)
      unit: productType === 'interpretation'
        ? '일'
        : (p ? (displayUnit(p.name, p.unit) || SVC_DEFAULT_UNIT[productType]) : SVC_DEFAULT_UNIT[productType]),
      ...(productType === 'translation' && p?.sourceLanguage
        ? { sourceLanguage: p.sourceLanguage }
        : {}),
    });
  };

  return (
    <>
      <div style={{ ...tblRow, borderBottom: `1px solid ${C.g100}`, minHeight: 42, transition: 'background 0.1s' }}
        onMouseEnter={e => (e.currentTarget.style.background = C.bgHover)} onMouseLeave={e => (e.currentTarget.style.background = '')}>

        {/* ① 행 제어 */}
        <div>
          <RowControls idx={idx} total={total} onRemove={removeItem} onAddBelow={addItemBelow}
            onMoveUp={i => moveItem(i, 'up')} onMoveDown={i => moveItem(i, 'down')} />
        </div>

        {/* ② 유형 */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <ServiceTypeSelector value={it.productType}
            onChange={t => updateItem(idx, { ...defaultItemForType(t), productId: null, productName: '' })} />
        </div>

        {/* ③ 상품 */}
        <div style={{ display: 'flex' }}>
          <InlineSearchField items={products.map(p => ({ id: p.id, label: p.name, sub: p.code ?? undefined }))}
            value={it.productId} onChange={selectProduct} placeholder="상품 검색…" popupTitle="상품 검색"
            accentColor={cfg.border} compact />
        </div>

        {/* ④ 서비스별 동적 필드 — 1fr 셀, minWidth:0 으로 축소 허용 */}
        <div style={{ minWidth: 0 }}>
          <ServiceFields it={it} update={p => updateItem(idx, p)} products={products} />
        </div>

        {/* ⑤ AI 교차검증 배지 (번역 전용) */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {validation?.status === 'ok' && (
            <span style={{ color: C.success, fontSize: 12, fontWeight: 800, lineHeight: 1 }}
              title="AI 교차검증 완료 — 글자수·단어수 비율 정상">✓</span>
          )}
          {validation?.status === 'warning' && (
            <button type="button" onClick={() => setShowWarning(v => !v)}
              style={{
                background: showWarning ? (validation.severity === 'danger' ? C.dangerBg : C.warningBg) : 'none',
                border: 'none', cursor: 'pointer',
                color: validation.severity === 'danger' ? C.danger : C.warning,
                fontSize: 13, fontWeight: 800, padding: '1px 3px', borderRadius: 4, lineHeight: 1,
              }}
              title={`AI 교차검증: ${validation.message}`}>
              {validation.severity === 'danger' ? '✕' : '⚠'}
            </button>
          )}
        </div>

        {/* ⑥ 수량 — 통역은 진행일수(읽기전용, 날짜에서 파생), 그 외는 직접 입력 */}
        <div>
          {it.productType === 'interpretation' ? (
            <div
              title={interp && !interp.invalidDateRange
                ? `수량 = 진행일수 ${interp.serviceDays}일 (종료일 − 시작일 + 1). 인원은 별도, 공급가액 = 단가 × 일수 × 인원`
                : '시작일·종료일을 입력하면 진행일수가 자동 계산됩니다'}
              style={{
                ...rinp('100%', { textAlign: 'center' }),
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: C.g50, cursor: 'default', fontVariantNumeric: 'tabular-nums',
                color: interp?.invalidDateRange ? C.danger : C.textPrimary, fontWeight: 700,
              }}>
              {interp && !interp.invalidDateRange ? interp.serviceDays.toLocaleString() : '—'}
            </div>
          ) : (
            <NumericInput value={it.quantity} onChange={v => updateItem(idx, { quantity: v })} placeholder="1"
              style={rinp('100%', { textAlign: 'center' })} />
          )}
        </div>

        {/* ⑦ 단위 */}
        <div>
          <UnitSelect value={it.unit} onChange={v => updateItem(idx, { unit: v })} serviceType={it.productType} />
        </div>

        {/* ⑧ 단가 — 통역은 1인 기준 단가 */}
        <div title={it.productType === 'interpretation' ? '통역사 1인 기준 단가 (공급가액 = 투입인원 × 수량 × 단가)' : undefined}>
          <NumericInput value={it.unitPrice} onChange={v => updateItem(idx, { unitPrice: v })}
            placeholder="0" suffix="원"
            style={rinp('100%', { textAlign: 'right' })} />
        </div>

        {/* ⑨ 공급가액 */}
        <div style={dsAmount(supply > 0, { paddingRight: 6 })}>
          {supply > 0 ? supply.toLocaleString() + '원' : '—'}
        </div>

        {/* ⑩ 비고 — 공급가액과 명확히 구분 */}
        <div style={{ borderLeft: '2px solid #e5e7eb', paddingLeft: 14 }}>
          <input value={it.memo} onChange={e => updateItem(idx, { memo: e.target.value })}
            placeholder="비고 (긴급, 감수 포함, 출장비 별도 등)"
            style={{ ...rinp('100%'), color: C.textMuted }}
            title="긴급, 감수 포함, DTP 포함, 출장비 별도, 장비 설치 포함 등" />
        </div>
      </div>

      {/* AI 경고 패널 — ⚠ 클릭 시 토글 */}
      {showWarning && validation?.status === 'warning' && (
        <div style={{
          background: validation.severity === 'danger' ? C.dangerBgPanel : C.warningBg,
          border: `1px solid ${validation.severity === 'danger' ? C.dangerBorder : C.warningBorder}`,
          borderTop: 'none', borderRadius: '0 0 8px 8px', padding: '10px 16px', marginBottom: 2,
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: validation.severity === 'danger' ? C.dangerText : C.warningText, marginBottom: 4 }}>
                {validation.severity === 'danger' ? '✕ 위험' : '⚠ 주의'} — AI 문서 검증 결과
              </div>
              {validation.detail && (
                <div style={{ fontSize: 11, color: validation.severity === 'danger' ? C.dangerTextDeep : C.warningTextDeep, marginBottom: 6, fontVariantNumeric: 'tabular-nums' }}>
                  {validation.detail.basis === 'character' ? '예상 단어수' : '예상 글자수'}:&nbsp;
                  <strong>{validation.detail.expectedVal.toLocaleString()}</strong>
                  &nbsp;/ 실제: <strong>{validation.detail.actualVal.toLocaleString()}</strong>
                  &nbsp;— 오차 <strong>{validation.detail.deviationPct.toFixed(0)}%</strong>
                </div>
              )}
              <div style={{ fontSize: 11, color: validation.severity === 'danger' ? C.dangerText : C.warningText, lineHeight: 1.6 }}>
                <strong>예상 원인:</strong> {validation.causes?.join(' · ')}
              </div>
              <div style={{ fontSize: 11, color: validation.severity === 'danger' ? C.dangerTextDeep : C.warningTextDeep, marginTop: 4 }}>
                내용을 확인한 후 견적을 진행해 주세요. PM이 수량을 직접 수정하면 해당 값이 우선 적용됩니다.
              </div>
            </div>
            <button onClick={() => setShowWarning(false)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: validation.severity === 'danger' ? C.dangerText : C.warningText, flexShrink: 0, padding: '0 4px' }}>×</button>
          </div>
        </div>
      )}
    </>
  );
}

// ─── 카드 섹션 헤더 ──────────────────────────────────────────────────────────

function CardSectionHeader({ badge, badgeBg, badgeColor, title, hint }: {
  badge: string; badgeBg: string; badgeColor: string; title: string; hint?: string;
}) {
  return (
    <div style={{ ...TYPO.sectionTitle, paddingBottom: SP[4], borderBottom: BD.grid, marginBottom: SP[6], display: 'flex', alignItems: 'center', gap: SP[3] }}>
      <span style={{ width: 22, height: 22, borderRadius: BD.radius.md, background: badgeBg, color: badgeColor, fontSize: 12, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{badge}</span>
      {title}
      {hint && <span style={{ ...TYPO.helper, marginLeft: SP[2] }}>{hint}</span>}
    </div>
  );
}

// COL_H(컬럼 헤더 스타일)·SVC_FIELD_HINTS(④ 동적필드 헤더 힌트)는 quoteItemsShared 로
// 이관되어 판매관리 읽기전용 뷰와 공유한다. (이 파일 상단에서 import)

// ─── 상품정보 편집 그리드 (공용 편집 컴포넌트) ──────────────────────────────────
// 견적관리 편집기와 판매관리 수정모드가 동일하게 사용하는 편집 그리드.
// 헤더행 + 항목 행(QuoteItemRow) + 유형별 추가버튼을 렌더하며, 행 제어(추가/삭제/이동)는
// onItemsChange 기반으로 파생한다. 상위(카드/섹션 제목)와 상태 소유는 사용하는 화면이 담당한다.
// (Card·CardSectionHeader 는 포함하지 않는다 — 견적='상품정보' / 판매='판매정보' 로 각자 표기)
export function QuoteItemsEditor({ items, onItemsChange, vatType, products }: {
  items: QuoteItemForm[];
  onItemsChange: (items: QuoteItemForm[]) => void;
  vatType: VatType;
  products: Product[];
}) {
  const updateItem   = (idx: number, p: Partial<QuoteItemForm>) => onItemsChange(items.map((it, i) => i === idx ? { ...it, ...p } : it));
  const addItemBelow = (idx: number) => onItemsChange([...items.slice(0, idx + 1), defaultItem(), ...items.slice(idx + 1)]);
  const removeItem   = (idx: number) => onItemsChange(items.length > 1 ? items.filter((_, i) => i !== idx) : items);
  const moveItem     = (idx: number, dir: 'up' | 'down') => {
    const next = [...items]; const swap = dir === 'up' ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]]; onItemsChange(next);
  };
  const fieldHint = (() => { const t = [...new Set(items.map(it => it.productType))]; return t.length === 1 ? SVC_FIELD_HINTS[t[0]] : '서비스별 상세 입력 필드'; })();
  // 할인 항목(%)의 기준이 되는 비할인 상품 공급가액 합계 — 모든 행에 공통 전달
  const baseSupply = items.reduce((a, it) => it.productType === 'discount' ? a : a + calcItem(it, vatType).supply, 0);

  return (
    <>
      {/* 반응형 — 폭이 부족하면 이 영역(헤더+행)에만 가로 스크롤이 생긴다. */}
      <div style={{ overflowX: 'auto', scrollbarWidth: 'thin' }}>
        {/* 컬럼 헤더 — TABLE_COLS 공유 Grid (Body Row와 완전 동일 구조) */}
        <div style={{ ...tblRow, padding: '0 8px 7px', borderBottom: BD.grid, marginBottom: 3 }}>
          <div style={{ ...COL_H }}>행 제어</div>
          <div style={{ ...COL_H }}>유형</div>
          <div style={{ ...COL_H, textAlign: 'left' }}>상품 🔍🧽</div>
          <div style={{ ...COL_H, textAlign: 'left' }}>{fieldHint}</div>
          <div style={{ ...COL_H }}>AI</div>
          <div style={{ ...COL_H }}>수량</div>
          <div style={{ ...COL_H }}>단위</div>
          <div style={{ ...COL_H, textAlign: 'right' }}>단가</div>
          <div style={{ ...COL_H, textAlign: 'right', paddingRight: 6 }}>공급가액</div>
          <div style={{ ...COL_H, textAlign: 'left', borderLeft: BD.grid, paddingLeft: 14 }}>비고</div>
        </div>

        {/* 항목 행 */}
        <div>
          {items.map((it, idx) => (
            <QuoteItemRow key={idx} it={it} idx={idx} total={items.length} vatType={vatType} baseSupply={baseSupply} products={products}
              updateItem={updateItem} removeItem={removeItem} addItemBelow={addItemBelow} moveItem={moveItem} />
          ))}
        </div>
      </div>

      {/* 유형별 항목 추가 버튼 (+ 할인 항목 포함) */}
      <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
        {(['translation', 'interpretation', 'equipment', 'expense', 'discount'] as ServiceType[]).map(type => {
          const c = SVC_CFG[type];
          return (
            <button key={type} type="button"
              data-testid={`btn-add-item-${type}`} aria-label={`${c.label} 항목 추가`}
              onClick={() => onItemsChange([...items, { ...defaultItem(), ...defaultItemForType(type) }])}
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: c.color, background: c.bg, border: `1px dashed ${c.border}`, borderRadius: 7, padding: '5px 12px', cursor: 'pointer', fontWeight: 600 }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.75')} onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
              + {c.label} 항목
            </button>
          );
        })}
      </div>
    </>
  );
}

// 폼 항목(QuoteItemForm[]) → 저장 API body(items) 매핑 — 견적·판매 저장에서 공용 사용.
export function buildQuoteItemsBody(items: QuoteItemForm[], vat: VatType) {
  return items.map(it => toApiItem(it, vat));
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface QuoteEditorWorkspaceProps {
  token:             string;
  projectId:         number | null;
  initialCompanyId?: number | null;
  initialContactId?: number | null;
  initialDivisionId?: number | null;
  /** 담당 PM(project.adminId) — 기존 견적 편집 진입 시 PM 필드 복원용 */
  initialAdminId?:   number | null;
  /** 변경사유(version_reason) — 변경견적 상세 진입 시 저장된 사유 복원/표시용 */
  initialVersionReason?: string;
  initialTitle?:     string;
  onClose:           () => void;
  onSaved:           (result: { quoteId: number; projectId: number | null }) => void;
  onToast:           (msg: string) => void;
  adminList?:        AdminUser[];
  /** true: AdminDashboard 스크롤 영역 내 인라인 렌더링 (사이드바 유지) */
  asPage?:           boolean;
  // 기존 견적 편집 모드
  initialQuoteId?:   number;
  initialItems?:     QuoteItemForm[];
  initialNote?:      string;
  initialQuoteType?: QuoteType;
  initialIssueDate?: string;
  initialVatType?:   VatType;
  /** 진입 시점의 견적 상태(status). 'approved' 이면 이미 판매전환된 견적 → 전환완료로 표시. */
  initialStatus?:    string;
  /** 누적 견적서 마감일시(있으면 마감완료). accumulated_batch 전용 — 마감 후 편집/저장 차단. */
  initialBatchClosedAt?: string | null;
  /** 판매전환 성공 후 호출 — 목록 등 상위 화면 갱신용(에디터는 유지). */
  onConverted?:      () => void;
  /** '판매관리 보기' 클릭 시 판매관리(프로젝트) 탭으로 이동. 미제공 시 버튼 숨김. */
  onNavigateToSales?: () => void;
  /** 판매전환 성공 후 자동 생성된 판매 상세페이지(/sales/:projectId)로 이동. 미제공 시 onNavigateToSales로 폴백. */
  onOpenSalesDetail?: (projectId: number) => void;
  /** 판매전환 권한 충족 여부(기본 true). false면 판매전환 버튼을 비활성(숨기지 않음)한다. */
  canConvert?:       boolean;
  /** 다른 견적(변경견적/원견적)으로 이동. 미제공 시 목록 갱신 후 닫기로 폴백. */
  onOpenQuote?:      (quoteId: number) => void;
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────────

export function QuoteEditorWorkspace({
  token, projectId, initialCompanyId = null, initialContactId = null, initialDivisionId = null,
  initialAdminId = null, initialVersionReason = '', initialTitle = '',
  onClose, onSaved, onToast, adminList = [], asPage = false,
  initialQuoteId, initialItems, initialNote, initialQuoteType, initialIssueDate, initialVatType,
  initialStatus, initialBatchClosedAt = null, onConverted, onNavigateToSales, onOpenSalesDetail, canConvert = true, onOpenQuote,
}: QuoteEditorWorkspaceProps) {

  const authH = { Authorization: `Bearer ${token}` };
  const [showAiModal,   setShowAiModal]   = useState(false);
  // ── 누적 견적서 마감 상태 (accumulated_batch 전용) ───────────────────────────
  const [batchClosed,       setBatchClosed]       = useState<boolean>(!!initialBatchClosedAt);
  const [batchCloseConfirm, setBatchCloseConfirm] = useState(false);
  const [batchClosing,      setBatchClosing]      = useState(false);
  // ── 견적서 보기(PDF 미리보기) — 목록 화면과 동일한 로직 재사용 ────────────────
  const [pdfData,       setPdfData]       = useState<{ data: ReturnType<typeof buildQuotePdfData>; title: string } | null>(null);
  const [pdfLoading,    setPdfLoading]    = useState(false);
  // ── 견적서명 불러오기(과거 견적서명 조회) ────────────────────────────────────
  const [titlePickerOpen, setTitlePickerOpen] = useState(false);
  const [titleOptions,    setTitleOptions]    = useState<Array<{ id: number; title: string; issueDate: string | null; quoteType: string }>>([]);
  const [titleLoading,    setTitleLoading]    = useState(false);
  // ── 판매전환 상태 ──────────────────────────────────────────────────────────
  // convertConfirm: 확인창 표시, converting: 전환 처리 중, converted: 이미 전환 완료(대기→판매),
  // convertDone: 성공 안내 오버레이 표시(약 1초 후 판매 상세로 이동).
  const [convertConfirm, setConvertConfirm] = useState(false);
  const [converting,     setConverting]     = useState(false);
  // 의뢰건 → 견적서 작성 프리필(신규 견적 진입 시에만 1회 적용). 기존 견적 편집/전환에는 영향 없음.
  const inqPrefill = useRef(initialQuoteId ? null : readQuoteHandoff()).current;
  const [converted,      setConverted]      = useState(initialStatus === 'approved');
  const [convertDone,    setConvertDone]    = useState(false);
  const [title,          setTitle]         = useState(inqPrefill?.title || initialTitle);
  const [titleEdited,    setTitleEdited]   = useState(!!(inqPrefill?.title || initialTitle));
  const [companyId,      setCompanyId]     = useState<number | null>(inqPrefill?.companyId ?? initialCompanyId);
  const [divisionId,     setDivisionId]    = useState<number | null>(inqPrefill?.divisionId ?? initialDivisionId);
  const [contactId,      setContactId]     = useState<number | null>(inqPrefill?.contactId ?? initialContactId);
  const [adminId,        setAdminId]       = useState<number | null>(initialAdminId ?? null);
  const [issueDate,      setIssueDate]     = useState(() => initialIssueDate ?? dateOffset(0));
  const [quoteType,      setQuoteType]     = useState<QuoteType>(initialQuoteType ?? 'b2b_standard');
  const [vatType,        setVatType]       = useState<VatType>(initialVatType ?? 'taxable');
  const [note,           setNote]          = useState(inqPrefill?.note ?? initialNote ?? '');
  const [versionReason,  setVersionReason] = useState(initialVersionReason ?? '');
  // 의뢰건 handoff items 가 있으면 견적 항목으로 시드(각 항목을 defaultItem 위에 병합). 없으면 기존 로직 유지.
  const [items,          setItems]         = useState<QuoteItemForm[]>(
    inqPrefill?.items?.length
      ? inqPrefill.items.map((hi) => ({ ...defaultItem(), ...hi } as QuoteItemForm))
      : (initialItems ?? [defaultItem()]),
  );
  const [companies,      setCompanies]     = useState<Company[]>([]);
  const [divisions,      setDivisions]     = useState<Division[]>([]);
  const [contacts,       setContacts]      = useState<Contact[]>([]);
  const [products,       setProducts]      = useState<Product[]>([]);
  const [loading,        setLoading]       = useState(true);
  const [saving,         setSaving]        = useState(false);
  // 견적서 버튼: 신규 견적을 자동 저장하면 이후 저장은 이 id로 업데이트(중복 생성 방지)
  const [savedQuoteId,   setSavedQuoteId]  = useState<number | null>(initialQuoteId ?? null);
  // ── 차감 견적서(b2c_prepaid) 전용: 선입/이월 라인 + 이전 가용잔액 ─────────────
  // 기본 1개 행 표시(사용자가 '+ 선입 항목'으로 복수 행 추가). 금액 0 행은 저장 시 무시된다.
  const [prepaidLines,   setPrepaidLines]  = useState<PrepaidLine[]>([makeEmptyPrepaidLine()]);
  const [prevAvailable,  setPrevAvailable] = useState(0);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const isPrepaidQuote = quoteType === 'b2c_prepaid';

  // 의뢰건 프리필로 진입한 경우: 견적 최초 저장(savedQuoteId 생성) 시 의뢰건에 quoteId 역연결 후 handoff 소비.
  const inqLinkedRef = useRef(false);
  useEffect(() => {
    if (savedQuoteId == null || inqLinkedRef.current || !inqPrefill?.inquiryId) return;
    inqLinkedRef.current = true;
    fetch(api(`/api/admin/inquiries/${inqPrefill.inquiryId}/link-quote`), {
      method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: savedQuoteId }),
    }).catch(() => { /* 연결 실패는 무시(견적 저장 자체는 성공) */ });
    clearQuoteHandoff();
  }, [savedQuoteId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 저장되지 않은 변경사항 추적(값 기준) ─────────────────────────────────────
  // 저장 payload에 반영되는 폼 필드를 직렬화한 "서명"을 기준선과 비교한다.
  // 최초 로딩 완료(번역 수량 정규화 반영) 시점의 서명을 기준선으로 캡처하므로,
  // 마운트 시 정규화만으로는 dirty가 되지 않는다(이미 저장된 견적은 바로 판매전환).
  const formSig = useMemo(
    () => JSON.stringify({ items, title, companyId, contactId, divisionId, adminId, issueDate, quoteType, vatType, note, versionReason, prepaidLines }),
    [items, title, companyId, contactId, divisionId, adminId, issueDate, quoteType, vatType, note, versionReason, prepaidLines],
  );
  const formSigRef     = useRef(formSig);
  formSigRef.current   = formSig;                          // 최신 서명을 ref에 미러링(핸들러 stale 방지)
  const baselineSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (baselineSigRef.current === null && !loading) baselineSigRef.current = formSig;
  }, [formSig, loading]);
  // 저장 성공 후 기준선 갱신 → 변경사항 없음 상태로 리셋
  const markClean = useCallback(() => { baselineSigRef.current = formSigRef.current; }, []);
  // 미저장 견적(savedQuoteId 없음) 또는 기준선과 서명이 다르면 변경사항 있음
  const hasUnsavedChanges = () =>
    savedQuoteId == null || baselineSigRef.current === null || formSigRef.current !== baselineSigRef.current;

  // 로고 클릭 새로고침 시 확인창을 위해 전역 미저장 레지스트리에 dirty checker 등록(언마운트 시 해제).
  useEffect(() => registerUnsavedChecker(() => hasUnsavedChanges()), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(api('/api/admin/companies'), { headers: authH }).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(api('/api/admin/contacts'),  { headers: authH }).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(api('/api/admin/products'),  { headers: authH }).then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([cos, cts, prds]) => {
      setCompanies(Array.isArray(cos) ? cos : []);
      setContacts(Array.isArray(cts) ? cts : []);
      setProducts(Array.isArray(prds) ? prds.filter((p: Product) => p.active) : []);
    }).finally(() => setLoading(false));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // 거래처 선택 시 해당 거래처의 브랜드(Division) 목록 로드 (기존 API 재사용)
  useEffect(() => {
    if (companyId == null) { setDivisions([]); return; }
    fetch(api(`/api/admin/companies/${companyId}/divisions`), { headers: authH })
      .then(r => r.ok ? r.json() : [])
      .then(ds => setDivisions(Array.isArray(ds) ? ds : []))
      .catch(() => setDivisions([]));
  }, [companyId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  // 차감 견적서: 기존 견적 진입 시 저장된 선입/이월(reserved/confirmed) 라인을 폼으로 복원(1회).
  useEffect(() => {
    if (initialQuoteId == null || (initialQuoteType ?? 'b2b_standard') !== 'b2c_prepaid') return;
    fetch(api(`/api/admin/quotes/${initialQuoteId}`), { headers: authH })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d || !Array.isArray(d.prepaidLines)) return;
        const inflow = d.prepaidLines.filter((l: any) => l.type !== 'deduction');
        const parsed: PrepaidLine[] = inflow.map((l: any) => ({
          type: (l.type === 'carryover' ? 'carryover' : 'deposit') as PrepaidLine['type'],
          amount: String(l.amount ?? ''),
          transactionDate: l.transactionDate ?? new Date().toISOString().slice(0, 10),
          sourceRef: '',
          note: (l.description ?? '').replace(/^[^·]*·?\s*/, ''),
        }));
        if (parsed.length) setPrepaidLines(parsed);
      })
      .catch(() => { /* 복원 실패는 무시 */ });
  }, [initialQuoteId, initialQuoteType]); // eslint-disable-line react-hooks/exhaustive-deps

  // 차감 견적서: 거래처의 '이전 가용잔액'(확정잔액 − 다른 차감견적 예약분) 조회
  useEffect(() => {
    if (!isPrepaidQuote || companyId == null) { setPrevAvailable(0); return; }
    setBalanceLoading(true);
    const qs = savedQuoteId ? `?excludeQuoteId=${savedQuoteId}` : '';
    fetch(api(`/api/prepaid/available/${companyId}${qs}`), { headers: authH })
      .then(r => r.ok ? r.json() : null)
      .then(d => setPrevAvailable(d && typeof d.available === 'number' ? d.available : 0))
      .catch(() => setPrevAvailable(0))
      .finally(() => setBalanceLoading(false));
  }, [isPrepaidQuote, companyId, savedQuoteId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  // 수정 화면 최초 진입 시: 번역 수량을 저장된 quantity가 아니라 원본 입력값(단어수/글자수 + 정책)에서
  // 1회 재계산한다. (지시문 3·6절 — 저장·복원 불일치 방지) 신규 작성은 단어/글자수가 없어 영향 없음.
  useEffect(() => {
    setItems(prev => prev.map(it => {
      if (it.productType !== 'translation') return it;
      const pages = calcTranslationPages(it.wordCount, it.charCount, it.sourceLanguage);
      if (pages === null) return it;  // 단어/글자수 없음(직접 페이지 입력) → 저장값 유지
      return { ...it, quantity: String(pages), unit: '페이지' };
    }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 견적서명 자동생성 규칙(공통) — 버튼[자동생성]과 신규 자동입력 effect가 함께 사용.
  //  VERITAS | 거래처명_브랜드명_대표서비스_YYYYMMDD (빈 구분자 없음은 generateQuoteTitle이 처리).
  //  정보가 부족하면 '' 반환(자동입력/버튼 모두 no-op 처리).
  //  allowEmpty=true(수동 [자동생성] 버튼): 상품이 없어도 회사[_브랜드]_날짜만으로 생성.
  //  allowEmpty=false(자동입력 effect): 기존대로 상품이 있어야 생성(조기 자동 채움 방지).
  const computeAutoTitle = useCallback((allowEmpty = false): string => {
    const co = companies.find(c => c.id === companyId);
    if (!co) return '';
    const vi = items.filter(it => it.productType !== 'discount' && it.productName.trim());
    if (vi.length === 0 && !allowEmpty) return '';
    const brand = divisions.find(d => d.id === divisionId);
    return generateQuoteTitle({
      companyName: co.name,
      brandName: brand?.name ?? null,
      items: vi.map(it => ({
        productName: it.productName,
        productType: it.productType,
        // 역할(대표/보조) 판정을 위해 선택된 상품의 대분류를 함께 전달 (통역 연장료·할증 = 보조상품)
        mainCategory: it.productId != null ? (products.find(p => p.id === it.productId)?.mainCategory ?? null) : null,
        supplyAmount: calcItem(it, vatType).supply,
      })),
      issueDate,
      allowEmpty,
    }) || '';
  }, [companies, companyId, items, divisions, divisionId, products, vatType, issueDate]);

  // 신규 견적 자동입력 — 사용자가 직접 수정(titleEdited)하기 전까지만, 신규(projectId=null)에서만.
  //  (저장된 상세·버튼 재생성과 무관. 사용자가 수정하면 titleEdited 가드로 이후 자동 갱신 중단)
  useEffect(() => {
    if (titleEdited || projectId !== null) return;
    const t = computeAutoTitle();
    if (t) setTitle(t);
  }, [computeAutoTitle, titleEdited, projectId]);

  // [자동생성] 버튼 — 버튼을 직접 누른 경우에만 기존 견적서명을 덮어쓴다.
  //  이후 다른 필드 변경으로는 자동으로 다시 덮어쓰지 않도록 titleEdited=true 로 확정.
  const handleAutoTitle = useCallback(() => {
    const t = computeAutoTitle(true);   // 수동 클릭 — 상품이 없어도 확보된 정보로 생성, 현재 값과 무관하게 덮어씀
    if (!t) { onToast('거래처를 먼저 선택해주세요.'); return; }
    setTitle(t); setTitleEdited(true);
  }, [computeAutoTitle, onToast]);

  // [불러오기] 버튼 — 현재 거래처의 과거 견적서명을 조회(최신순). 제목만 복사한다.
  const handleLoadTitles = useCallback(() => {
    if (companyId == null) { onToast('거래처를 먼저 선택해주세요.'); return; }
    setTitlePickerOpen(true);
    setTitleLoading(true);
    fetch(api(`/api/admin/quotes?companyId=${companyId}&limit=200`), { headers: authH })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const list: any[] = Array.isArray(data) ? data : (data?.quotes ?? []);
        setTitleOptions(
          list.filter(q => q?.title && String(q.title).trim())
            .map(q => ({ id: q.id, title: String(q.title), issueDate: q.issueDate ?? null, quoteType: q.quoteType ?? 'b2b_standard' })),
        );
      })
      .catch(() => setTitleOptions([]))
      .finally(() => setTitleLoading(false));
  }, [companyId, onToast]); // eslint-disable-line react-hooks/exhaustive-deps

  // 과거 견적서명 선택 — '제목 텍스트만' 복사(+끝 날짜는 현재 견적일로 교체). 다른 데이터는 복사 안 함.
  const handlePickTitle = useCallback((t: { title: string }) => {
    setTitle(replaceTrailingDate(t.title, issueDate));
    setTitleEdited(true);
    setTitlePickerOpen(false);
  }, [issueDate]);

  // 불러오기 팝업 바깥 클릭 시 닫기
  const titlePickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!titlePickerOpen) return;
    const onMD = (ev: MouseEvent) => { if (titlePickerRef.current && !titlePickerRef.current.contains(ev.target as Node)) setTitlePickerOpen(false); };
    document.addEventListener('mousedown', onMD);
    return () => document.removeEventListener('mousedown', onMD);
  }, [titlePickerOpen]);

  const handleCompanyChange  = (cid: number | null) => { setCompanyId(cid); setDivisionId(null); setContactId(null); setTitleEdited(false); };
  // 브랜드 변경 시 담당자 재선택 유도 + 견적서명 재생성
  const handleDivisionChange = (did: number | null) => { setDivisionId(did); setContactId(null); setTitleEdited(false); };
  const isStandalone   = projectId === null;
  // 거래처 보조정보에 연결된 브랜드(divisions) 전체를 표시한다.
  // (InlineSearchField는 label + sub 를 모두 검색하므로, 전체 브랜드명으로 거래처 검색이 가능해진다)
  const companyOptions = companies.map(c => ({ id: c.id, label: c.name, sub: c.divisionNames?.join(' · ') }));
  const divisionOptions = divisions.map(d => ({ id: d.id, label: d.name }));
  // 담당자: 거래처로 1차 필터, 브랜드 선택 시 해당 브랜드(또는 브랜드 미지정) 담당자만.
  //   담당자 옵션에는 브랜드명을 회색 서브텍스트로 함께 표시한다.
  const contactOptions = contacts
    .filter(c => c.id === contactId || (
      (companyId === null || c.companyId === companyId) &&
      (divisionId === null || c.divisionId === divisionId || c.divisionId == null)
    ))
    .map(c => ({ id: c.id, label: c.name, sub: c.divisionName ?? undefined }));
  const adminOptions   = adminList.map(u => ({ id: u.id, label: u.name ?? u.email }));

  // 항목 행 제어(추가/삭제/이동)는 QuoteItemsEditor 내부에서 onItemsChange 기반으로 처리한다.

  // AI 초안 → QuoteItemForm 변환 후 기존 Row 아래에 추가
  const handleApplyAiRows = (draftRows: AiDraftRow[]) => {
    const defaultUnit: Record<ServiceType, string> = {
      translation: '페이지', interpretation: '일', equipment: '세트', expense: '건', discount: '건',
    };
    const converted: QuoteItemForm[] = draftRows.map(d => ({
      productId:        d.productId,
      productName:      d.productName || '',
      productType:      d.productType as ServiceType,
      quantity:         String(d.quantity || 1),
      unit:             d.unit || defaultUnit[d.productType as ServiceType] || '건',
      unitPrice:        d.unitPrice > 0 ? String(d.unitPrice) : '',
      taxType:          vatType,
      memo:             [d.memo, ...d.warnings].filter(Boolean).join(' / '),
      sourceLanguage:   d.sourceLanguage || 'ko',
      fileName:         d.fileName || '',
      fileFormat:       (FILE_FORMATS as readonly string[]).includes(d.fileFormat)
                          ? d.fileFormat
                          : (detectFormatFromExt(d.fileName || '') || ''),
      wordCount:        d.wordCount > 0 ? String(d.wordCount) : '',
      charCount:        d.charCount > 0 ? String(d.charCount) : '',
      interpretDate:    d.interpretDate || '',
      interpretEndDate: d.interpretEndDate || '',
      startTime:        d.startTime || '',
      endTime:          d.endTime || '',
      // 통역시간 — 하루 기준 시간(숫자) 필드. AI 초안은 시각만 제공하므로 비워 두고 사용자가 입력.
      interpretHours:   '',
      // 운영시간(행사 운영시간) — AI 초안의 시작~종료 시각이 있으면 그대로 채움
      operationHours:   [d.startTime, d.endTime].filter(Boolean).join('~'),
      interpretPlace:   d.interpretPlace || '',
      interpreterCount: d.interpreterCount > 0 ? String(d.interpreterCount) : '',
      eventStartDate:   d.eventStartDate || '',
      eventEndDate:     d.eventEndDate || '',
      itemLocation:     d.itemLocation || '',
      usagePeriod:      d.usagePeriod > 0 ? String(d.usagePeriod) : '',
      expenseType:      d.expenseType || '',
    }));
    // 기존에 빈 기본 Row 하나만 있으면 교체, 아니면 아래 추가
    setItems(prev => {
      const isOnlyDefault =
        prev.length === 1 &&
        !prev[0].productName.trim() &&
        !prev[0].unitPrice.trim();
      return isOnlyDefault ? converted : [...prev, ...converted];
    });
    onToast(`AI 초안 ${converted.length}건이 반영되었습니다.`);
  };

  const totals = calcTotals(items, vatType);

  // 변경견적 여부 최신값(family는 아래에서 파생) — persistQuote 저장 시점에 안전하게 읽기 위한 ref.
  const isRevisionRef = useRef(false);
  const isDerivedRef = useRef(false);   // 파생견적 저장 시 분리사유(versionReason) 전달 판단용

  // 저장 실행부 — 편집 화면을 닫지 않고 저장만 수행하고 { quoteId, projectId }를 반환한다.
  // 신규 견적은 최초 저장 시 생성하고 savedQuoteId를 기록 → 이후(저장/견적서)엔 동일 견적을 업데이트(중복 생성 방지).
  const persistQuote = useCallback(async (): Promise<{ quoteId: number; projectId: number | null } | null> => {
    // 유효 품목: 일반 상품은 품목명+단가(>0), 할인 항목은 할인값(>0) 기준으로 판별.
    //  (할인 항목은 단가가 0이므로 기존 단가 필터에서 누락되던 버그 수정)
    const isValidItem = (it: QuoteItemForm) =>
      it.productType === 'discount'
        ? Number(String(it.discountValue ?? '').replace(/,/g, '') || 0) > 0
        : it.productName.trim() && Number(it.unitPrice.replace?.(/,/g, '') || 0) > 0;
    const vi = items.filter(isValidItem);
    if (vi.length === 0) { onToast('품목명과 단가를 입력하세요.'); return null; }
    const itemsBody  = vi.map(it => toApiItem(it, vatType));
    const commonBody = {
      items: itemsBody, quoteType,
      billingType: 'postpaid_per_project', taxDocumentType: 'tax_invoice', taxCategory: 'normal',
      issueDate, validUntil: (() => { const d = new Date(issueDate); d.setDate(d.getDate() + 30); return d.toISOString().split('T')[0]; })(),
      note: note.trim() || undefined,
      // 차감 견적서: 선입/이월 라인(잔액 충전) — 서버가 reserved 예약으로 기록
      ...(isPrepaidQuote ? { prepaidLines: prepaidLinesToApi(prepaidLines) } : {}),
    };
    setSaving(true);
    try {
      // 기존 견적 또는 이미 자동 저장된 신규 견적 → 업데이트(PUT)
      if (savedQuoteId) {
        const url     = api(`/api/admin/quotes/${savedQuoteId}`);
        const payload = {
          ...commonBody,
          title:     title.trim() || undefined,
          companyId: companyId ?? undefined,
          contactId: contactId ?? undefined,
          divisionId: divisionId ?? null,
          // 담당 PM — 견적관리(독립 견적, projectId=null) 흐름에서만 전달.
          //  판매관리(projectId≠null)의 버전견적 저장은 기존 POST 경로를 사용하며 PM은 프로젝트에서 관리 → 여기서 건드리지 않음.
          ...(projectId === null ? { adminId: adminId ?? null } : {}),
          // 변경사유/분리사유 — 변경견적·파생견적에서만 전달(일반/버전견적 저장 동작은 기존과 동일하게 유지)
          ...(isRevisionRef.current || isDerivedRef.current ? { versionReason } : {}),
        };
        const res  = await fetch(url, {
          method: 'PUT', headers: { ...authH, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          const msg = res.status === 404 ? '견적 수정 API를 찾을 수 없습니다. (서버 재시작 필요)'
                    : res.status === 400 ? `입력값을 확인해 주세요: ${data.error}`
                    : `서버 오류 (${res.status}): ${data.error ?? data.message ?? ''}`;
          onToast(`견적 수정 실패: ${msg}`); return null;
        }
        return { quoteId: savedQuoteId, projectId: null };
      }
      // 신규 독립 견적 → 생성(POST) 후 id 기록
      if (projectId === null) {
        const t = title.trim();
        if (!t) { onToast('견적서명을 입력하세요.'); return null; }
        const res = await fetch(api('/api/admin/quotes'), {
          method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...commonBody, title: t, companyId: companyId ?? undefined, contactId: contactId ?? undefined, divisionId: divisionId ?? undefined, adminId: adminId ?? undefined }),
        });
        const data = await res.json();
        if (!res.ok) { onToast(`견적서 저장 실패: ${data.error}`); return null; }
        setSavedQuoteId(data.id);   // 이후 저장·견적서는 이 견적을 업데이트
        return { quoteId: data.id, projectId: null };
      }
      // 프로젝트 버전 견적 (Version Engine)
      const res = await fetch(api(`/api/admin/projects/${projectId}/quote`), {
        method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...commonBody, title: title.trim() || undefined, versionReason: versionReason.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`견적 저장 실패: ${data.error}`); return null; }
      return { quoteId: data.id, projectId };
    } catch { onToast('견적 저장 중 오류가 발생했습니다.'); return null; }
    finally { setSaving(false); }
  }, [items, projectId, savedQuoteId, title, companyId, contactId, divisionId, adminId, issueDate, quoteType, vatType, note, versionReason, token, prepaidLines, isPrepaidQuote]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = useCallback(async () => {
    if (batchClosed) { onToast('마감완료된 누적 견적서는 수정할 수 없습니다.'); return; }
    const isUpdate = savedQuoteId != null;
    const r = await persistQuote();
    if (!r) return;
    markClean();
    onToast(isUpdate ? '견적이 수정되었습니다.' : '견적서가 저장되었습니다.');
    onSaved(r);
  }, [persistQuote, onSaved, onToast, savedQuoteId, markClean, batchClosed]);

  // ─── 누적 마감(누적중 → 마감완료) ────────────────────────────────────────────
  // 판매전환과 별개. 확인 후 POST → 이후 상품/금액 수정 차단(API에서도 차단). 연결 판매건은 최종 확정 유지.
  const handleBatchClose = useCallback(async () => {
    if (savedQuoteId == null) { onToast('먼저 견적을 저장해 주세요.'); return; }
    setBatchClosing(true);
    try {
      const res = await fetch(api(`/api/admin/quotes/${savedQuoteId}/batch-close`), {
        method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`누적 마감 실패: ${data.error ?? res.status}`); return; }
      setBatchClosed(true);
      setBatchCloseConfirm(false);
      onToast('누적 견적서가 마감완료 처리되었습니다.');
      onConverted?.();   // 목록 배지 갱신
    } catch {
      onToast('누적 마감 처리 중 오류가 발생했습니다.');
    } finally {
      setBatchClosing(false);
    }
  }, [savedQuoteId, onToast, onConverted]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 견적 엔진 STEP2/STEP3: 관계(family) 조회 + 변경견적/파생견적 workflow ──────────
  type FamilyMember = { id: number; quoteNumber: string | null; relationType: string | null; status: string; isCurrent: boolean; price: number; version: number; projectId: number | null; parentVersionId?: number | null };
  type Allocation = { currentEffectiveAmount: number; approvedDerivedTotal: number; pendingDerivedTotal: number; remaining: number; derivedCount: number };
  const [family, setFamily] = useState<FamilyMember[]>([]);
  const [allocation, setAllocation] = useState<Allocation | null>(null);
  const [showRevisionModal, setShowRevisionModal] = useState(false);
  const [revisionReason, setRevisionReason] = useState('');
  const [revBusy, setRevBusy] = useState(false);
  // ── 파생견적(STEP3) 생성 모달 상태 ──
  const [showDerivedModal, setShowDerivedModal] = useState(false);
  const [derivedBusy, setDerivedBusy] = useState(false);
  // 파생 = "견적서 분할 발행": N개 업체로 분할. 각 행 = 업체 + 담당자 + (품목 or 금액).
  type SplitRow = { companyId: number | null; contactId: number | null; mode: 'items' | 'amount'; itemIds: Set<number>; amount: string; label: string; taxType: VatType };
  const emptySplit = (): SplitRow => ({ companyId: null, contactId: null, mode: 'amount', itemIds: new Set(), amount: '', label: '', taxType: 'taxable' });
  const [derivedSplits, setDerivedSplits] = useState<SplitRow[]>([]);
  const [derivedReason, setDerivedReason] = useState('');
  const [dSourceItems, setDSourceItems]   = useState<Array<{ id: number; productName: string; totalAmount: number }>>([]);
  const updateSplit = (i: number, patch: Partial<SplitRow>) => setDerivedSplits(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  const fetchFamily = useCallback(async () => {
    if (savedQuoteId == null) { setFamily([]); setAllocation(null); return; }
    try {
      const r = await fetch(api(`/api/admin/quotes/${savedQuoteId}/family`), { headers: authH });
      if (!r.ok) return;
      const d = await r.json();
      setFamily(Array.isArray(d.members) ? d.members : []);
      setAllocation(d.allocation ?? null);
    } catch { /* 무시 */ }
  }, [savedQuoteId, token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetchFamily(); }, [fetchFamily]);

  const meMember       = family.find(m => m.id === savedQuoteId) ?? null;
  const isRevision     = meMember?.relationType === 'revision';
  // persistQuote(위에서 선언)에서 저장 시점의 최신 isRevision 을 안전하게 참조하기 위한 ref.
  isRevisionRef.current = isRevision;
  const rootMember     = family.find(m => m.relationType == null) ?? null;   // 원견적
  const currentMember  = family.find(m => m.isCurrent) ?? null;              // 현재 유효본
  const isPendingRevision = isRevision && meMember?.status === 'pending';
  // 파생견적(STEP3) — is_current 는 항상 false. 과거견적(isSuperseded)로 오분류되지 않도록 별도 처리.
  const isDerived      = meMember?.relationType === 'derived';
  isDerivedRef.current = isDerived;
  const isPendingDerived = isDerived && meMember?.status === 'pending';
  const derivedBaseMember = isDerived && meMember?.parentVersionId != null
    ? (family.find(m => m.id === meMember.parentVersionId) ?? null) : null;   // 기준견적(§26)
  const isSuperseded   = meMember != null && meMember.isCurrent === false && !isPendingRevision && !isDerived;
  const hasRevisionChildren = family.some(m => m.relationType === 'revision');
  // 변경견적 생성 가능: 저장된 b2b 일반견적 + 현재 유효본 + 미확정 변경견적 없음 (파생 자신 제외)
  const canCreateRevision = quoteType === 'b2b_standard' && savedQuoteId != null && !isDerived && (meMember?.isCurrent ?? true)
    && !family.some(m => m.relationType === 'revision' && m.status === 'pending');
  // 파생견적 생성 가능: b2b 일반견적 + 현재유효 견적(원견적/변경 현재본)에서만(§5/§37/§38). 파생 자신에서는 불가.
  const canCreateDerived = quoteType === 'b2b_standard' && savedQuoteId != null && !isDerived && (meMember?.isCurrent ?? true);

  const handleCreateRevision = useCallback(async () => {
    if (savedQuoteId == null) return;
    setRevBusy(true);
    try {
      const res = await fetch(api(`/api/admin/quotes/${savedQuoteId}/create-revision`), {
        method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionReason: revisionReason.trim() || null }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`변경견적 생성 실패: ${d.error ?? res.status}`); return; }
      setShowRevisionModal(false); setRevisionReason('');
      onToast(`변경견적 ${d.quoteNumber ?? ''} 이(가) 생성되었습니다. 원견적은 그대로 보존됩니다.`);
      onConverted?.();
      if (onOpenQuote && d.id) onOpenQuote(d.id); else onClose?.();
    } catch { onToast('변경견적 생성 중 오류가 발생했습니다.'); }
    finally { setRevBusy(false); }
  }, [savedQuoteId, revisionReason, token, onToast, onConverted, onOpenQuote, onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleApproveRevision = useCallback(async () => {
    if (savedQuoteId == null) return;
    setRevBusy(true);
    try {
      const res = await fetch(api(`/api/admin/quotes/${savedQuoteId}/approve-revision`), { method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' } });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`변경견적 승인 실패: ${d.error ?? res.status}`); return; }
      onToast('변경견적이 승인되어 현재 유효견적으로 전환되었습니다.');
      onConverted?.(); fetchFamily();
    } catch { onToast('변경견적 승인 중 오류가 발생했습니다.'); }
    finally { setRevBusy(false); }
  }, [savedQuoteId, token, onToast, onConverted, fetchFamily]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRejectRevision = useCallback(async () => {
    if (savedQuoteId == null) return;
    setRevBusy(true);
    try {
      const res = await fetch(api(`/api/admin/quotes/${savedQuoteId}/reject-revision`), { method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' } });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`변경견적 거절 실패: ${d.error ?? res.status}`); return; }
      onToast('변경견적이 거절되었습니다. 기존 유효견적이 유지됩니다.');
      onConverted?.(); fetchFamily();
    } catch { onToast('변경견적 거절 중 오류가 발생했습니다.'); }
    finally { setRevBusy(false); }
  }, [savedQuoteId, token, onToast, onConverted, fetchFamily]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 파생견적(STEP3) = 견적서 분할 발행 ─────────────────────────────────────
  // 모달 열기 — 현재유효 견적의 실제 품목(id 포함)을 조회하고, 기본 2개 업체 행으로 시작한다.
  const openDerivedModal = useCallback(async () => {
    if (savedQuoteId == null) return;
    if (hasUnsavedChanges()) { onToast('저장 후 분할견적을 생성할 수 있습니다.'); return; }
    setDerivedReason('');
    setDerivedSplits([emptySplit(), emptySplit()]);   // 기본 2개 업체 분할
    try {
      const res = await fetch(api(`/api/admin/quotes/${savedQuoteId}`), { headers: authH });
      const d = await res.json().catch(() => null);
      const its = Array.isArray(d?.items) ? d.items.map((it: any) => ({ id: it.id as number, productName: String(it.productName ?? ''), totalAmount: Number(it.totalAmount ?? 0) })) : [];
      setDSourceItems(its);
    } catch { setDSourceItems([]); }
    setShowDerivedModal(true);
  }, [savedQuoteId, token, onToast]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreateDerived = useCallback(async () => {
    if (savedQuoteId == null) return;
    if (derivedSplits.length < 2) { onToast('2개 이상 업체로 분할해 주세요.'); return; }
    const splits = derivedSplits.map(r => ({
      companyId: r.companyId,
      contactId: r.contactId ?? undefined,
      mode: r.mode,
      itemIds: r.mode === 'items' ? [...r.itemIds] : undefined,
      amount: r.mode === 'amount' ? Number(r.amount.replace(/,/g, '')) : undefined,
      label: r.label.trim() || null,
      taxType: r.taxType,
    }));
    if (splits.some(s => !s.companyId)) { onToast('모든 분할 업체를 선택해 주세요.'); return; }
    setDerivedBusy(true);
    try {
      const res = await fetch(api(`/api/admin/quotes/${savedQuoteId}/create-derived`), {
        method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: derivedReason.trim() || null, splits }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`분할견적 생성 실패: ${d.error ?? res.status}`); return; }
      setShowDerivedModal(false);
      onToast(`분할견적 ${d.count ?? ''}건이 생성되었습니다. 현재유효 견적은 그대로 유지됩니다.`);
      onConverted?.(); fetchFamily();
    } catch { onToast('분할견적 생성 중 오류가 발생했습니다.'); }
    finally { setDerivedBusy(false); }
  }, [savedQuoteId, derivedSplits, derivedReason, token, onToast, onConverted, fetchFamily]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleApproveDerived = useCallback(async () => {
    if (savedQuoteId == null) return;
    setRevBusy(true);
    try {
      const res = await fetch(api(`/api/admin/quotes/${savedQuoteId}/approve-derived`), { method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' } });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`분할 승인 실패: ${d.error ?? res.status}`); return; }
      onToast('분할견적이 승인되어 배분이 확정되었습니다.');
      onConverted?.(); fetchFamily();
    } catch { onToast('분할 승인 중 오류가 발생했습니다.'); }
    finally { setRevBusy(false); }
  }, [savedQuoteId, token, onToast, onConverted, fetchFamily]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRejectDerived = useCallback(async () => {
    if (savedQuoteId == null) return;
    setRevBusy(true);
    try {
      const res = await fetch(api(`/api/admin/quotes/${savedQuoteId}/reject-derived`), { method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' } });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`분할 거절 실패: ${d.error ?? res.status}`); return; }
      onToast('분할견적이 거절되었습니다. 현재유효 견적과 기존 배분에는 영향이 없습니다.');
      onConverted?.(); fetchFamily();
    } catch { onToast('분할 거절 중 오류가 발생했습니다.'); }
    finally { setRevBusy(false); }
  }, [savedQuoteId, token, onToast, onConverted, fetchFamily]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 견적서 보기(PDF 미리보기) ──────────────────────────────────────────────
  // 목록 화면과 동일하게 GET /admin/quotes/:id → buildQuotePdfData → QuotePdfPreviewModal 재사용.
  // 저장 스냅샷 기준으로 표시하므로 미저장 수정사항은 반영되지 않는다(dirty면 안내).
  const handleViewPdf = useCallback(async () => {
    if (savedQuoteId == null) return;                       // 저장 전에는 비활성(버튼 disabled)
    if (hasUnsavedChanges()) onToast('저장되지 않은 수정사항은 견적서에 반영되지 않습니다. 먼저 저장해 주세요.');
    setPdfLoading(true);
    try {
      const res = await fetch(api(`/api/admin/quotes/${savedQuoteId}`), { headers: authH });
      if (!res.ok) { onToast('견적서 미리보기에 실패했습니다.'); return; }
      const detail = await res.json();
      if (!detail.items || detail.items.length === 0) { onToast('견적 품목이 없습니다. 품목을 먼저 입력해 주세요.'); return; }
      setPdfData({ data: buildQuotePdfData(detail), title: title.trim() || detail.title || String(detail.quoteNumber ?? '') });
    } catch {
      onToast('견적서 생성 중 오류가 발생했습니다.');
    } finally {
      setPdfLoading(false);
    }
  }, [savedQuoteId, title, onToast]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 판매전환 실행 ────────────────────────────────────────────────────────
  // 확인창 [판매전환] 클릭 시 호출. 순서: ① 미저장 변경사항 자동 저장 → ② 저장 성공 확인
  // → ③ 기존 판매전환 API(PATCH .../status {approved}) 호출(중복은 서버 409 차단)
  // → ④ 성공 안내 오버레이 약 1초 표시 → ⑤ 자동 생성된 판매 상세로 이동.
  // 저장 실패 시 판매전환을 진행하지 않는다(persistQuote가 실패 사유를 토스트).
  const handleConvert = useCallback(async () => {
    setConvertConfirm(false);
    setConverting(true);
    try {
      // ①·② 저장되지 않은 변경사항이 있으면 먼저 저장하고 성공을 확인한다.
      let quoteId = savedQuoteId;
      if (hasUnsavedChanges()) {
        const r = await persistQuote();
        if (!r) return;              // 저장 실패 → 전환 중단
        markClean();
        quoteId = r.quoteId;
      }
      if (quoteId == null) { onToast('먼저 견적을 저장하세요.'); return; }
      // ③·④ 기존 판매전환 API 호출 (서버가 중복 전환을 409로 차단)
      const res  = await fetch(api(`/api/admin/quotes/${quoteId}/status`), {
        method: 'PATCH', headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        onToast(`판매전환 실패: ${data?.error ?? `서버 오류 (${res.status})`}`);
        return;
      }
      setConverted(true);
      onConverted?.();
      // ⑤ 성공 안내 후 자동 생성된 판매 상세페이지로 이동 (약 1초 표시)
      const projId: number | null = data?.project?.id ?? data?.quote?.projectId ?? null;
      setConvertDone(true);
      setTimeout(() => {
        if (projId != null && onOpenSalesDetail) onOpenSalesDetail(projId);
        else onNavigateToSales?.();
      }, 1000);
    } catch {
      onToast('판매전환 중 오류가 발생했습니다.');
    } finally {
      setConverting(false);
    }
    // hasUnsavedChanges/markClean는 ref 기반 안정 참조라 deps에서 제외
  }, [savedQuoteId, persistQuote, onToast, onConverted, onOpenSalesDetail, onNavigateToSales, token]); // eslint-disable-line react-hooks/exhaustive-deps



  // ─── 공통 Form 컨텐츠 ─────────────────────────────────────────────────────

  const inpSt: React.CSSProperties = dsField();
  const fLbl  = (txt: string, req = false) => (
    <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: FIELD.labelGap }}>
      {txt}{req && <span style={{ color: C.danger, marginLeft: 2 }}>*</span>}
    </label>
  );

  const formContent = loading ? (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: C.g400, fontSize: 14 }}>데이터 불러오는 중…</div>
  ) : (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      {/* ── A. 기본정보 ─────────────────────────────────────────────────── */}
      <Card style={{ padding: '14px 22px' }}>
        <CardSectionHeader badge="A" badgeBg="#eff6ff" badgeColor="#2563eb" title="기본정보" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: FIELD.rowGap }}>
          {/* 1행 — 견적서 유형 / 견적일 / 부가세 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: `0 20px` }}>
            <div>
              {fLbl('견적서 유형')}
              {isDerived ? (
                // 분할견적: quote_type(내부)은 일반견적 기반 유지, 화면 표시만 '분할 견적서'로 override.
                <div data-testid="quote-type-derived" style={{ ...dsField(), display: 'flex', alignItems: 'center', color: '#92400e', fontWeight: 700 }}>🌱 분할 견적서</div>
              ) : (
                <ClickSelect value={quoteType} onChange={v => setQuoteType(v as QuoteType)}
                  triggerStyle={dsField()}
                  options={[{ value: 'b2b_standard', label: '일반 견적서', sub: '일반 B2B 프로젝트' }, { value: 'b2c_prepaid', label: '차감 견적서', sub: '선입금 잔액 차감' }, { value: 'accumulated_batch', label: '누적 견적서', sub: '월별 누적 청구' }]} />
              )}
            </div>
            <div>
              {fLbl('견적일')}
              <input type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} style={inpSt} />
            </div>
            <div>
              {fLbl('부가세')}
              <ClickSelect value={vatType} onChange={v => setVatType(v as VatType)}
                triggerStyle={dsField()}
                options={[{ value: 'taxable', label: '부가세 10%' }, { value: 'exempt', label: '면세' }, { value: 'zero_rate', label: '영세율' }]} />
            </div>
          </div>

          {/* 2행 — 견적서명 (전체 너비) */}
          {isStandalone && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: FIELD.labelGap }}>
                {fLbl('견적서명', true)}
                {!titleEdited && title && <span style={{ fontSize: 10, color: C.textMuted, fontStyle: 'italic' }}>자동생성됨</span>}
              </div>
              {/* 입력창 + [자동생성] + [불러오기] — 입력창은 flex:1 로 폭 확보, 버튼은 우측 고정 */}
              <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
                <input value={title} onChange={e => { setTitle(e.target.value); setTitleEdited(true); }}
                  placeholder="예: VERITAS│삼성전자_영어↔한국어 동시통역_20260720" style={{ ...inpSt, flex: 1, minWidth: 0 }}
                  data-testid="input-quote-title" aria-label="견적서명" />
                <DsButton variant="secondary" size="md" onClick={handleAutoTitle} data-testid="btn-title-auto" aria-label="견적서명 자동생성">자동생성</DsButton>
                <div ref={titlePickerRef} style={{ position: 'relative', flexShrink: 0 }}>
                  <DsButton variant="secondary" size="md" data-testid="btn-title-load" aria-label="기존 견적서명 불러오기"
                    onClick={() => { if (titlePickerOpen) setTitlePickerOpen(false); else handleLoadTitles(); }}>불러오기</DsButton>
                  {titlePickerOpen && (
                    <div style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 50, width: 'min(440px, 80vw)', maxHeight: 320, overflowY: 'auto',
                      background: C.bgCard, border: BD.card, borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.16)' }}>
                      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, fontSize: 11, fontWeight: 700, color: C.textSecondary, position: 'sticky', top: 0, background: C.bgCard }}>
                        기존 견적서명 불러오기 (제목만 복사)
                      </div>
                      {titleLoading ? (
                        <div style={{ padding: 16, textAlign: 'center', color: C.textMuted, fontSize: 13 }}>불러오는 중…</div>
                      ) : titleOptions.length === 0 ? (
                        <div style={{ padding: 16, textAlign: 'center', color: C.textMuted, fontSize: 13 }}>이 거래처의 기존 견적서명이 없습니다.</div>
                      ) : titleOptions.map(o => (
                        <button key={o.id} type="button" onClick={() => handlePickTitle(o)} data-testid={`title-option-${o.id}`}
                          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none', borderBottom: `1px solid ${C.g100}`, background: 'transparent', cursor: 'pointer' }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.title}</div>
                          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{o.issueDate ?? '-'} · {QUOTE_TYPE_SHORT[o.quoteType] ?? o.quoteType} 견적서</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 3행 — 거래처 / 브랜드 / 담당자 / 담당 PM (한 줄) */}
          {(() => {
            const hasBrand = isStandalone && divisions.length > 0;
            const crmCols = !isStandalone
              ? CRM_FIELD_COLS.pmOnly
              : hasBrand ? CRM_FIELD_COLS.full : CRM_FIELD_COLS.noBrand;
            return (
              <div style={{ display: 'grid', gridTemplateColumns: crmCols, gap: '0 20px' }}>
                {isStandalone && (
                  <div>
                    {fLbl('거래처')}
                    <InlineSearchField items={companyOptions} value={companyId} onChange={handleCompanyChange} placeholder="거래처 검색…" popupTitle="거래처 검색" />
                  </div>
                )}
                {/* 브랜드(Division) — 브랜드가 있는 거래처에서만 표시, 선택사항 */}
                {hasBrand && (
                  <div>
                    {fLbl('브랜드')}
                    <InlineSearchField items={divisionOptions} value={divisionId} onChange={handleDivisionChange} placeholder="브랜드 선택 (선택사항)" popupTitle="브랜드 선택" />
                  </div>
                )}
                {isStandalone && (
                  <div>
                    {fLbl('담당자')}
                    <InlineSearchField items={contactOptions} value={contactId} onChange={setContactId} placeholder="담당자 검색…" popupTitle="담당자 검색" />
                  </div>
                )}
                <div>
                  {fLbl('담당 PM')}
                  <InlineSearchField items={adminOptions} value={adminId} onChange={setAdminId} placeholder="PM 검색 (선택)" popupTitle="담당 PM 검색" />
                </div>
              </div>
            );
          })()}
        </div>
      </Card>

      {/* ── B-0. 차감 견적서 전용: 선입/이월 (차감 사용내역 위) ───────────────── */}
      {isPrepaidQuote && (
        <PrepaidLinesSection
          lines={prepaidLines}
          onLinesChange={setPrepaidLines}
          hasCompany={companyId != null}
        />
      )}

      {/* ── B. 상품정보 ─────────────────────────────────────────────────── */}
      <Card>
        <CardSectionHeader badge="B" badgeBg="#f0fdf4" badgeColor="#16a34a" title={isPrepaidQuote ? '차감 사용내역' : '상품정보'} hint="← 유형 클릭으로 번역/통역/장비/기타 전환" />

        {/* 마감완료 누적 견적서: 편집 차단 안내 배너(상품/금액 확정) */}
        {batchClosed && (
          <div style={{ marginBottom: 10, padding: '9px 14px', background: '#f3f4f6', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.textSecondary, fontWeight: 600 }}>
            🔒 마감완료된 누적 견적서입니다. 상품·금액을 수정할 수 없습니다. (조회·PDF는 가능)
          </div>
        )}
        {/* 상품정보 편집 그리드 — 판매관리 수정모드와 공용(QuoteItemsEditor).
            누적 마감 시 편집 차단(pointer-events 무효화 + 흐리게). API에서도 수정 차단됨. */}
        <div style={batchClosed ? { pointerEvents: 'none', opacity: 0.6 } : undefined} aria-disabled={batchClosed}>
          <QuoteItemsEditor items={items} onItemsChange={setItems} vatType={vatType} products={products} />
        </div>
      </Card>

      {/* ── B-1. 차감 견적서 전용: 차감 잔액 요약 (차감 사용내역 아래) ───────────── */}
      {isPrepaidQuote && (
        <PrepaidSummarySection
          previousAvailable={prevAvailable}
          incomingPrepaid={sumPrepaidLines(prepaidLines)}
          quoteTotal={totals.total}
          loadingBalance={balanceLoading}
        />
      )}

      {/* ── C. 금액 요약 ─────────────────────────────────────────────────── */}
      {/* 차감 견적서(b2c_prepaid)는 위 '차감 잔액 요약'에 금액 정보가 이미 노출되므로 C 금액 요약을 화면에서 숨긴다.
          (계산값·저장 payload·PDF/Excel은 그대로 유지 — 표시만 조건부) */}
      {!isPrepaidQuote && (
      <Card>
        <CardSectionHeader badge="C" badgeBg="#fffbeb" badgeColor="#d97706" title="금액 요약" />
        {/* 유형별 소계 + Special D.C — '상품합계 → 할인 차감 → 공급가액' 계산 흐름을 그대로 노출 */}
        {(() => {
          // ① 상품 유형별 소계 배지 (번역/통역/장비/기타)
          const productBadges = (['translation', 'interpretation', 'equipment', 'expense'] as ServiceType[]).map(type => {
            const ti = items.filter(it => it.productType === type);
            if (!ti.length) return null;
            const s = calcTotals(ti, vatType);
            const c = SVC_CFG[type];
            return s.supply > 0 ? (
              <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', background: c.bg, border: `1px solid ${c.border}`, borderRadius: 7 }}>
                <span style={{ ...TYPO.badge, color: c.color }}>{c.label}</span>
                <span style={{ ...TYPO.amount, color: C.textSecondary }}>{formatWon(s.supply)}</span>
              </div>
            ) : null;
          }).filter(Boolean);
          // ② Special D.C(할인) 배지 — 적용된 항목만 빨간색 계열로 표시. 각 할인 항목을 개별 배지로
          //    노출하여 향후 정부기관/VIP/프로모션 등 Price Adjustment 확장에도 동일 방식으로 대응한다.
          //    할인액은 비할인 상품 공급가 합계(nonDiscountSupply)를 기준으로 계산(화면·행과 동일 공식).
          const nonDiscountSupply = items.reduce((a, it) => it.productType === 'discount' ? a : a + calcItem(it, vatType).supply, 0);
          const dc = SVC_CFG.discount;
          const discountBadges = items.map((it, i) => {
            if (it.productType !== 'discount') return null;
            const amt = calcItem(it, vatType, nonDiscountSupply).supply;   // 음수(할인액). 미적용(0)이면 숨김
            if (amt >= 0) return null;
            return (
              <div key={`dc-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', background: dc.bg, border: `1px solid ${dc.border}`, borderRadius: 7 }}
                data-testid={`summary-discount-${i}`}>
                <span style={{ ...TYPO.badge, color: dc.color }}>{it.productName?.trim() || 'Special D.C'}</span>
                <span style={{ ...TYPO.amount, color: C.danger }}>{formatWon(amt)}</span>
              </div>
            );
          }).filter(Boolean);
          const gs = [...productBadges, ...discountBadges];
          return gs.length > 1 ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>{gs}</div> : null;
        })()}
        <div style={{ display: 'flex', gap: SP[6], justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {[{ label: '공급가액', value: totals.supply }, { label: '부가세', value: totals.tax }].map(r => (
            <div key={r.label} style={{ textAlign: 'right', padding: `${SP[4]}px ${SP[5]}px`, borderRadius: BD.radius.lg, background: C.bgHover }}>
              <div style={{ ...TYPO.helper, marginBottom: 3 }}>{r.label}</div>
              <div style={{ ...TYPO.summaryAmount }}>{formatWon(r.value)}</div>
            </div>
          ))}
          <div style={{ textAlign: 'right', padding: `${SP[5]}px ${SP[7]}px`, borderRadius: BD.radius.xl, background: C.primaryBg, border: `1.5px solid ${C.primaryBorder}` }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.primary, marginBottom: 3 }}>총 견적금액</div>
            <div style={{ ...TYPO.totalAmount }}>{formatWon(totals.total)}</div>
          </div>
        </div>
      </Card>
      )}

      {/* ── D. 비고 / 버전 사유 ─────────────────────────────────────────── */}
      <Card>
        <CardSectionHeader badge="D" badgeBg="#f5f3ff" badgeColor="#7c3aed" title="비고 / 기타" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            {fLbl('견적 비고')}
            <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="견적 관련 메모 또는 안내 사항" rows={2}
              style={{ ...inpSt, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
          {(projectId !== null || isRevision || isDerived) && (
            <div style={{ background: C.warningBg, borderRadius: BD.radius.xl, padding: `${SP[5]}px ${SP[6]}px`, border: `1px solid ${C.warningBorder}` }}>
              <label style={{ ...TYPO.fieldLabel, color: C.warningText, display: 'block', marginBottom: SP[3] }}>
                {isDerived ? '분할 사유' : isRevision ? '변경 사유' : '버전 변경 사유'}
                <span style={{ marginLeft: SP[2], fontWeight: 400, color: C.warning }}>
                  {isDerived ? '— 이 분할견적의 분할사유입니다(저장 시 반영, 현재유효 견적에는 영향 없음)'
                    : isRevision ? '— 이 변경견적의 변경사유입니다(저장 시 반영, 원견적에는 영향 없음)'
                    : '— 저장 시 새 Version으로 기록됩니다'}
                </span>
              </label>
              <input value={versionReason} onChange={e => setVersionReason(e.target.value)}
                data-testid="input-version-reason" aria-label={isDerived ? '분할 사유' : isRevision ? '변경 사유' : '버전 변경 사유'}
                placeholder="예: 고객 요청에 따른 조건 변경 / 회사별 청구 분리 / 금액 수정" style={{ ...inpSt, background: C.bgCard }} />
            </div>
          )}
        </div>
      </Card>
    </div>
  );

  // ─── 공통 Workspace 헤더 (PageHeader 기반) ────────────────────────────────

  // 페이지 제목은 화면 성격을 나타낸다.
  // 기존 견적 진입(initialQuoteId)은 조회·수정·PDF·판매전환 등을 모두 다루는 통합 관리 화면 → '견적 상세'.
  // 그 외(신규 작성) → '견적서 작성'.
  const pageTitle = initialQuoteId != null ? '견적 상세' : '견적서 작성';

  // ── 신분(관계/상태) 정보 — Action 버튼과 분리해 제목 옆(subtitle)에 표시(§3~§7) ──
  //  Action 영역에는 실행 기능만 남기고, "변경견적 Rn / 원견적 Qxxxxx / 현재 상태"는 여기서 신분정보로 노출한다.
  const revStatusLabel = (s?: string) =>
    s === 'approved' ? '승인' : s === 'rejected' ? '거절' : s === 'pending' ? '승인대기' : s === 'sent' ? '발송' : (s ?? '');
  const relBadge = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 7, fontSize: 12, fontWeight: 700 } as const;
  const relLinkBtn = (color: string) => ({ border: 'none', background: 'transparent', color, textDecoration: 'underline', cursor: onOpenQuote ? 'pointer' : 'default', fontSize: 12, fontWeight: 600, padding: 0 } as const);
  const derivedSuffix = (n?: string | null) => (n ? n.split('-').pop() : '') ?? '';
  const statusChip = (s?: string) => (
    <span style={{ ...relBadge, background: s === 'rejected' ? '#fef2f2' : s === 'approved' ? '#ecfdf5' : '#fffbeb', color: s === 'rejected' ? '#b91c1c' : s === 'approved' ? '#047857' : '#b45309' }}>
      {revStatusLabel(s)}
    </span>
  );
  const showDerivedSummary = !isDerived && (allocation?.derivedCount ?? 0) > 0;
  const headerSubtitle: React.ReactNode = (isRevision || isDerived || isSuperseded || hasRevisionChildren || showDerivedSummary) ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {isRevision && (
        <>
          <span data-testid="badge-revision" style={{ ...relBadge, background: '#eef2ff', color: '#4338ca' }}>
            🔁 변경견적{meMember?.quoteNumber ? ` ${derivedSuffix(meMember.quoteNumber)}` : ''}
          </span>
          {rootMember?.quoteNumber && (
            <button type="button" data-testid="link-root-quote" onClick={() => rootMember && onOpenQuote?.(rootMember.id)}
              title="원견적으로 이동" style={relLinkBtn('#4338ca')}>
              원견적: {rootMember.quoteNumber}
            </button>
          )}
          {meMember?.status && statusChip(meMember.status)}
        </>
      )}
      {isDerived && (
        <>
          <span data-testid="badge-derived" style={{ ...relBadge, background: '#fef3c7', color: '#92400e' }}>
            🌱 분할견적{meMember?.quoteNumber ? ` ${derivedSuffix(meMember.quoteNumber)}` : ''}
          </span>
          {rootMember?.quoteNumber && (
            <button type="button" data-testid="link-root-quote" onClick={() => rootMember && onOpenQuote?.(rootMember.id)}
              title="원견적으로 이동" style={relLinkBtn('#92400e')}>
              원견적: {rootMember.quoteNumber}
            </button>
          )}
          {derivedBaseMember?.quoteNumber && (
            <button type="button" data-testid="link-base-quote" onClick={() => derivedBaseMember && onOpenQuote?.(derivedBaseMember.id)}
              title="기준 견적으로 이동" style={relLinkBtn('#6b7280')}>
              기준견적: {derivedBaseMember.quoteNumber}
            </button>
          )}
          {meMember?.status && statusChip(meMember.status)}
        </>
      )}
      {isSuperseded && (
        <span data-testid="badge-superseded" style={{ ...relBadge, background: '#f3f4f6', color: '#6b7280' }}>
          🗂 과거 견적
          {currentMember?.quoteNumber && currentMember.id !== savedQuoteId && (
            <button type="button" onClick={() => currentMember && onOpenQuote?.(currentMember.id)}
              title="현재 유효견적으로 이동" style={relLinkBtn('#2563eb')}>
              현재 유효견적: {currentMember.quoteNumber}
            </button>
          )}
        </span>
      )}
      {!isRevision && !isDerived && !isSuperseded && hasRevisionChildren && (
        <span data-testid="badge-has-revision" style={{ ...relBadge, background: '#fef9c3', color: '#854d0e', fontWeight: 600 }}>
          🔁 변경견적 존재
        </span>
      )}
      {/* 파생 배분현황(§28) — 현재유효 견적에서만, 파생이 1건 이상일 때 간단 표시(과도 확장 금지) */}
      {showDerivedSummary && allocation && (
        <span data-testid="derived-allocation-summary" style={{ ...relBadge, background: '#fffbeb', color: '#92400e', fontWeight: 600 }}
          title={`계약금액 ${formatWon(allocation.currentEffectiveAmount)} · 분할확정 ${formatWon(allocation.approvedDerivedTotal)} · 잔여 ${formatWon(allocation.remaining)}`}>
          🌱 분할 {allocation.derivedCount}건 · 잔여 {formatWon(allocation.remaining)}
        </span>
      )}
    </span>
  ) : (projectId !== null ? 'Version Engine' : undefined);

  // 우측 기능 버튼 그룹 — 두 헤더(오버레이·인라인)가 공유
  // 견적서 보기 — 저장 전(quoteId 없음)에는 비활성. 저장 성공 시 savedQuoteId가 생기며 즉시 활성화된다.
  const pdfDisabled = savedQuoteId == null || pdfLoading;
  const headerActions = (
    <>
      <button type="button" onClick={handleViewPdf} disabled={pdfDisabled}
        data-testid="btn-view-quote-pdf" aria-label="견적서 보기"
        title={savedQuoteId == null ? '견적을 먼저 저장하면 견적서를 볼 수 있습니다.' : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 600,
          border: `1px solid ${C.border}`, background: '#ffffff', color: pdfDisabled ? C.textMuted : C.textSecondary,
          cursor: pdfDisabled ? 'not-allowed' : 'pointer', opacity: pdfDisabled ? 0.55 : 1 }}>
        📄 {pdfLoading ? '여는 중…' : '견적서 보기'}
      </button>
      <button type="button" onClick={() => setShowAiModal(true)} data-testid="btn-ai-quote" aria-label="AI 견적 생성"
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', background: C.ai, color: '#ffffff' }}>
        🤖 AI 견적 생성
      </button>
      {/* 판매전환 — 견적 상세의 기본 진입점(Success/초록, 저장(파랑)과 명확히 구분).
          미저장 변경사항은 확인창의 [판매전환] 선택 후 자동 저장→전환된다.
          이미 전환(approved)·권한 없음·처리 중이면 비활성(숨기지 않음). PDF/일괄전환은 목록에서 유지. */}
      {(() => {
        // 견적 엔진: 미확정 변경견적/과거(대체)견적/파생견적은 판매전환 불가(§18/§19). 승인된 현재 유효견적만 전환 대상.
        //  파생견적은 '판매전환'이 아니라 [파생 승인]으로 배분 확정된다(별도 project/청구 단위).
        const revisionBlocked = isPendingRevision || isSuperseded || isDerived;
        const convertDisabled = converted || converting || saving || !canConvert || revisionBlocked;
        // 누적 견적서: 전환 후에도 견적을 계속 누적·저장하면 '연결된 판매건 1건'에 자동 반영되므로,
        // 완료 상태를 '판매 연결됨'으로 표기해 판매건이 이미 연결돼 있음을 명확히 안내한다(요구 §7).
        const isAccumulated = quoteType === 'accumulated_batch';
        const convertLabel = converted
          ? (isAccumulated ? '판매 연결됨' : '전환완료')
          : converting ? '전환 중…' : '판매전환';
        const convertTitle = !canConvert ? '판매전환 권한이 없습니다.'
          : isDerived ? '분할견적은 판매전환 대신 [분할 승인]으로 배분 확정됩니다(원 계약금액을 청구주체별로 배분).'
          : isPendingRevision ? '변경견적은 [변경견적 승인]으로 확정됩니다(승인 시 현재 유효견적으로 전환).'
          : isSuperseded ? '과거(대체된) 견적입니다. 현재 유효견적을 사용하세요.'
          : converted ? (isAccumulated
              ? '판매건이 연결되어 있습니다. 견적을 저장하면 같은 판매건에 자동 반영됩니다.'
              : '이미 판매전환된 견적입니다.')
          : undefined;
        return (
          <button type="button" onClick={() => setConvertConfirm(true)} disabled={convertDisabled}
            data-testid="btn-quote-convert" aria-label="판매전환"
            title={convertTitle}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 700, border: 'none',
              background: convertDisabled ? '#9ca3af' : C.success, color: '#ffffff',
              cursor: convertDisabled ? 'not-allowed' : 'pointer', opacity: convertDisabled ? 0.6 : 1 }}>
            🔁 {convertLabel}
          </button>
        );
      })()}
      {/* 관계/신분 배지(변경견적·원견적·과거견적)는 Action 영역에서 제거하고 제목 옆 신분정보(headerSubtitle)로 이동(§3~§5) */}

      {/* 견적 작업: 변경견적 생성 — 일반견적(b2b) 유효본에서만. 원견적은 보존됨. */}
      {canCreateRevision && (
        <button type="button" onClick={() => { if (hasUnsavedChanges()) { onToast('저장 후 변경견적을 생성할 수 있습니다.'); return; } setShowRevisionModal(true); }} disabled={revBusy}
          data-testid="btn-create-revision" aria-label="변경견적 생성"
          title="현재 견적을 기준으로 변경견적을 생성합니다(원견적 보존)."
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 700, border: `1px solid ${C.primary}`,
            background: '#fff', color: C.primary, cursor: revBusy ? 'not-allowed' : 'pointer', opacity: revBusy ? 0.6 : 1 }}>
          🔀 변경견적 생성
        </button>
      )}
      {/* 견적 작업: 파생견적 생성 — 현재유효 일반견적에서만. 원 계약금액을 청구주체별로 분리(현재유효 견적 유지). */}
      {canCreateDerived && (
        <button type="button" onClick={openDerivedModal} disabled={derivedBusy}
          data-testid="btn-create-derived" aria-label="분할견적 생성"
          title="현재유효 견적금액을 여러 회사로 나누어 견적서를 분할 발행합니다(현재유효 견적은 유지)."
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 700, border: `1px solid ${C.warning}`,
            background: '#fff', color: '#92400e', cursor: derivedBusy ? 'not-allowed' : 'pointer', opacity: derivedBusy ? 0.6 : 1 }}>
          🌱 분할견적 생성
        </button>
      )}
      {/* 미확정 변경견적 상세: 승인 / 거절 */}
      {isPendingRevision && (
        <>
          <button type="button" onClick={handleApproveRevision} disabled={revBusy}
            data-testid="btn-approve-revision" aria-label="변경견적 승인" title="이 변경견적을 현재 유효견적으로 확정하고 판매건에 반영합니다."
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 700, border: 'none', background: C.success, color: '#fff', cursor: revBusy ? 'not-allowed' : 'pointer', opacity: revBusy ? 0.6 : 1 }}>
            ✅ 변경견적 승인
          </button>
          <button type="button" onClick={handleRejectRevision} disabled={revBusy}
            data-testid="btn-reject-revision" aria-label="변경견적 거절" title="이 변경견적을 거절합니다(기존 유효견적 유지)."
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 700, border: `1px solid ${C.danger}`, background: '#fff', color: C.danger, cursor: revBusy ? 'not-allowed' : 'pointer', opacity: revBusy ? 0.6 : 1 }}>
            ✖ 거절
          </button>
        </>
      )}
      {/* 미확정 파생견적 상세: 파생 승인 / 파생 거절 (승인 시 과배분 검증) */}
      {isPendingDerived && (
        <>
          <button type="button" onClick={handleApproveDerived} disabled={revBusy}
            data-testid="btn-approve-derived" aria-label="분할견적 승인" title="이 분할견적의 배분을 확정합니다(과배분 시 차단). 현재유효 견적은 유지됩니다."
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 700, border: 'none', background: C.success, color: '#fff', cursor: revBusy ? 'not-allowed' : 'pointer', opacity: revBusy ? 0.6 : 1 }}>
            ✅ 분할 승인
          </button>
          <button type="button" onClick={handleRejectDerived} disabled={revBusy}
            data-testid="btn-reject-derived" aria-label="분할견적 거절" title="이 분할견적을 거절합니다(현재유효/기존 배분 무영향)."
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 700, border: `1px solid ${C.danger}`, background: '#fff', color: C.danger, cursor: revBusy ? 'not-allowed' : 'pointer', opacity: revBusy ? 0.6 : 1 }}>
            ✖ 거절
          </button>
        </>
      )}

      {/* 누적 마감 — accumulated_batch 전용, 저장된 견적에서만. 판매전환과 별개 동작. */}
      {quoteType === 'accumulated_batch' && savedQuoteId != null && (
        <button type="button"
          onClick={() => { if (!batchClosed) setBatchCloseConfirm(true); }}
          disabled={batchClosed || batchClosing}
          data-testid="btn-batch-close" aria-label={batchClosed ? '마감완료' : '누적 마감'}
          title={batchClosed ? '이 누적 견적서는 마감완료되었습니다(수정 불가).' : '누적 기간을 마감합니다(마감 후 수정 불가).'}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 700, border: 'none',
            background: batchClosed ? '#6b7280' : (batchClosing ? '#9ca3af' : C.warning), color: '#ffffff',
            cursor: (batchClosed || batchClosing) ? 'not-allowed' : 'pointer', opacity: (batchClosed || batchClosing) ? 0.7 : 1 }}>
          {batchClosed ? '🔒 마감완료' : batchClosing ? '마감 중…' : '📦 누적 마감'}
        </button>
      )}
      <DsButton variant="primary" size="md" onClick={handleSave} disabled={saving || batchClosed}>
        {batchClosed ? '🔒 마감됨' : saving ? '저장 중…' : '💾 저장'}
      </DsButton>
    </>
  );

  // 견적서 PDF 미리보기 모달 — 두 렌더 분기(인라인/오버레이)가 공유. 닫으면 상세 화면 상태 유지.
  const pdfModal = pdfData && (
    <QuotePdfPreviewModal data={pdfData.data} quoteTitle={pdfData.title} onClose={() => setPdfData(null)} />
  );

  const wsHeader = (bg: string, border: string, shadow: string, padH: string) => (
    <PageHeader
      onBack={onClose}
      testId="btn-quote-back"
      title={pageTitle}
      subtitle={headerSubtitle}
      right={headerActions}
      style={{ background: bg, borderBottom: border, boxShadow: shadow, padding: `0 ${padH}` }}
    />
  );

  // ─── 판매전환 확인창 + 성공 안내 오버레이 (두 렌더 분기 공유) ────────────────
  const convertOverlays = (
    <>
      {/* 1) 판매전환 확인창 — [취소]는 아무 작업 없음, [판매전환]만 실제 전환 진행 */}
      {convertConfirm && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setConvertConfirm(false)}>
          <div onClick={e => e.stopPropagation()} data-testid="modal-quote-convert"
            style={{ background: '#fff', borderRadius: 14, padding: '26px 30px', width: 440, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
            <h2 style={{ margin: '0 0 10px', fontSize: 18, fontWeight: 800, color: C.successText }}>판매전환하시겠습니까?</h2>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: '#374151', lineHeight: 1.6 }}>판매전환 후에는 판매관리에서 진행됩니다.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setConvertConfirm(false)} data-testid="cancel-quote-convert"
                style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151' }}>취소</button>
              <button onClick={handleConvert} data-testid="confirm-quote-convert"
                style={{ padding: '9px 20px', borderRadius: 8, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, background: C.success, cursor: 'pointer' }}>판매전환</button>
            </div>
          </div>
        </div>
      )}
      {/* 2) 성공 안내 오버레이 — 약 1초 표시 후 판매 상세로 자동 이동 */}
      {convertDone && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9100, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div data-testid="modal-quote-convert-done"
            style={{ background: '#fff', borderRadius: 14, padding: '30px 34px', width: 420, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', textAlign: 'center' }}>
            <div style={{ fontSize: 34, marginBottom: 10 }}>✅</div>
            <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 800, color: C.successText }}>판매전환이 완료되었습니다.</h2>
            <p style={{ margin: 0, fontSize: 13, color: '#374151', lineHeight: 1.6 }}>판매 상세페이지로 이동합니다.</p>
          </div>
        </div>
      )}
      {/* 3) 누적 마감 확인창 — [마감완료]만 실제 마감 처리 */}
      {batchCloseConfirm && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setBatchCloseConfirm(false)}>
          <div onClick={e => e.stopPropagation()} data-testid="modal-batch-close"
            style={{ background: '#fff', borderRadius: 14, padding: '26px 30px', width: 460, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
            <h2 style={{ margin: '0 0 10px', fontSize: 18, fontWeight: 800, color: C.textPrimary }}>누적 견적서를 마감하시겠습니까?</h2>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: '#374151', lineHeight: 1.6 }}>마감 후에는 상품 및 금액을 수정할 수 없습니다. (연결된 판매건도 최종 금액으로 확정됩니다.)</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setBatchCloseConfirm(false)} data-testid="cancel-batch-close"
                style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151' }}>취소</button>
              <button onClick={handleBatchClose} disabled={batchClosing} data-testid="confirm-batch-close"
                style={{ padding: '9px 20px', borderRadius: 8, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, background: C.warning, cursor: batchClosing ? 'not-allowed' : 'pointer', opacity: batchClosing ? 0.7 : 1 }}>마감완료</button>
            </div>
          </div>
        </div>
      )}

      {/* 변경견적 생성 확인 모달 (§4) — 변경사유(version_reason) 입력 */}
      {showRevisionModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { if (!revBusy) setShowRevisionModal(false); }}>
          <div onClick={e => e.stopPropagation()} data-testid="modal-create-revision"
            style={{ background: '#fff', borderRadius: 14, padding: '26px 30px', width: 480, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
            <h2 style={{ margin: '0 0 10px', fontSize: 18, fontWeight: 800, color: C.textPrimary }}>변경견적을 생성하시겠습니까?</h2>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
              현재 견적을 기준으로 변경견적을 생성합니다. <b>원견적은 그대로 보존</b>되며, 변경견적이 승인되기 전까지는 기존 견적이 계속 유효합니다.
            </p>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 6 }}>변경 사유 (선택)</label>
            <textarea value={revisionReason} onChange={e => setRevisionReason(e.target.value)} data-testid="input-revision-reason"
              placeholder="예: 고객 요청에 따른 통역 일수 추가 / 단가 재협의"
              style={{ width: '100%', minHeight: 72, boxSizing: 'border-box', padding: '9px 11px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, resize: 'vertical', marginBottom: 20 }} />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowRevisionModal(false)} disabled={revBusy} data-testid="cancel-create-revision"
                style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151' }}>취소</button>
              <button onClick={handleCreateRevision} disabled={revBusy} data-testid="confirm-create-revision"
                style={{ padding: '9px 20px', borderRadius: 8, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, background: C.primary, cursor: revBusy ? 'not-allowed' : 'pointer', opacity: revBusy ? 0.7 : 1 }}>{revBusy ? '생성 중…' : '변경견적 생성'}</button>
            </div>
          </div>
        </div>
      )}

      {/* 파생견적 생성 모달 (STEP3 — 견적서 분할 발행) — N개 업체로 100% 분할 */}
      {showDerivedModal && (() => {
        const companyOptions = companies.map(c => ({ id: c.id, label: c.name }));
        const base = allocation?.currentEffectiveAmount ?? 0;
        const rowAmount = (r: SplitRow) => r.mode === 'items'
          ? dSourceItems.filter(it => r.itemIds.has(it.id)).reduce((s, it) => s + it.totalAmount, 0)
          : (Number(r.amount.replace(/,/g, '')) || 0);
        const takenByOthers = (idx: number) => {
          const s = new Set<number>();
          derivedSplits.forEach((r, i) => { if (i !== idx && r.mode === 'items') r.itemIds.forEach(id => s.add(id)); });
          return s;
        };
        const splitTotal = derivedSplits.reduce((s, r) => s + rowAmount(r), 0);
        const remaining = base - splitTotal;
        const allCompanies = derivedSplits.every(r => r.companyId != null);
        const canSubmit = derivedSplits.length >= 2 && allCompanies && remaining === 0 && !derivedBusy;
        const fLbl2 = (t: string) => <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 5 }}>{t}</label>;
        const inp = { width: '100%', boxSizing: 'border-box' as const, padding: '9px 11px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 };
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
            onClick={() => { if (!derivedBusy) setShowDerivedModal(false); }}>
            <div onClick={e => e.stopPropagation()} data-testid="modal-create-derived"
              style={{ background: '#fff', borderRadius: 14, padding: '24px 28px', width: 680, maxWidth: '95vw', maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
              <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 800, color: C.textPrimary }}>🌱 견적서 분할 발행</h2>
              <p style={{ margin: '0 0 14px', fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
                현재유효 견적금액 <b>{formatWon(base)}</b>을 2개 이상 업체로 나누어 견적서를 각각 발행합니다. <b>계약/판매는 1건</b>이며, 분할합계는 반드시 계약금액과 일치해야 합니다(100% 분할).
              </p>

              {/* 분할 개수 컨트롤 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#6b7280' }}>분할 업체 수</span>
                {[2, 3].map(n => (
                  <button key={n} type="button" onClick={() => setDerivedSplits(prev => {
                    const next = prev.slice(0, n); while (next.length < n) next.push(emptySplit()); return next;
                  })} data-testid={`derived-count-${n}`}
                    style={{ padding: '5px 12px', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                      border: `1px solid ${derivedSplits.length === n ? C.warning : '#d1d5db'}`, background: derivedSplits.length === n ? '#fffbeb' : '#fff', color: derivedSplits.length === n ? '#92400e' : '#6b7280' }}>{n}</button>
                ))}
                <button type="button" onClick={() => setDerivedSplits(prev => prev.length >= 6 ? prev : [...prev, emptySplit()])} data-testid="derived-add-company"
                  style={{ padding: '5px 12px', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: `1px dashed ${C.warning}`, background: '#fff', color: '#92400e' }}>+ 업체 추가</button>
              </div>

              {/* 업체별 분할 행 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
                {derivedSplits.map((row, idx) => {
                  const contactOptions = contacts.filter(c => row.companyId == null || c.companyId === row.companyId).map(c => ({ id: c.id, label: c.name, sub: c.divisionName ?? undefined }));
                  const taken = takenByOthers(idx);
                  return (
                    <div key={idx} data-testid={`derived-split-${idx}`} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, background: '#fcfcfd' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 800, color: '#92400e' }}>업체 {idx + 1}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 12, color: '#111827', fontWeight: 700 }}>{formatWon(rowAmount(row))}</span>
                          {derivedSplits.length > 2 && (
                            <button type="button" onClick={() => setDerivedSplits(prev => prev.filter((_, i) => i !== idx))} data-testid={`derived-remove-${idx}`}
                              style={{ border: 'none', background: 'transparent', color: C.danger, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>✕ 제거</button>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 8 }}>
                        <div>{fLbl2('회사')}<InlineSearchField items={companyOptions} value={row.companyId} onChange={(id) => updateSplit(idx, { companyId: id, contactId: null })} placeholder="회사 검색" popupTitle="분할 대상 회사" /></div>
                        <div>{fLbl2('담당자')}<InlineSearchField items={contactOptions} value={row.contactId} onChange={(id) => updateSplit(idx, { contactId: id })} placeholder="담당자 검색 (선택)" popupTitle="담당자 검색" /></div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                        {(['amount', 'items'] as const).map(m => (
                          <button key={m} type="button" onClick={() => updateSplit(idx, { mode: m })} data-testid={`derived-mode-${idx}-${m}`}
                            style={{ flex: 1, padding: '6px 8px', borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                              border: `1px solid ${row.mode === m ? C.warning : '#d1d5db'}`, background: row.mode === m ? '#fffbeb' : '#fff', color: row.mode === m ? '#92400e' : '#6b7280' }}>
                            {m === 'amount' ? '금액 분할' : '품목 분할'}
                          </button>
                        ))}
                      </div>
                      {row.mode === 'amount' ? (
                        <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 0.9fr 1.3fr', gap: 8 }}>
                          <input value={row.amount} onChange={e => updateSplit(idx, { amount: e.target.value })} data-testid={`derived-amount-${idx}`} inputMode="numeric" placeholder="금액(총액)" style={inp} />
                          <select value={row.taxType} onChange={e => updateSplit(idx, { taxType: e.target.value as VatType })} data-testid={`derived-tax-${idx}`} style={{ ...inp, background: '#fff' }}>
                            <option value="taxable">과세(10%)</option>
                            <option value="exempt">면세</option>
                          </select>
                          <input value={row.label} onChange={e => updateSplit(idx, { label: e.target.value })} data-testid={`derived-label-${idx}`} placeholder="항목명(선택)" style={inp} />
                        </div>
                      ) : (
                        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 6, maxHeight: 150, overflowY: 'auto', background: '#fff' }}>
                          {dSourceItems.length === 0 ? <div style={{ fontSize: 12, color: '#9ca3af', padding: 6 }}>분할 가능한 품목이 없습니다.</div>
                            : dSourceItems.map(it => {
                              const disabled = taken.has(it.id) && !row.itemIds.has(it.id);
                              return (
                                <label key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 4px', fontSize: 12, opacity: disabled ? 0.4 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
                                  <input type="checkbox" disabled={disabled} checked={row.itemIds.has(it.id)} onChange={(e) => updateSplit(idx, {
                                    itemIds: (() => { const n = new Set(row.itemIds); if (e.target.checked) n.add(it.id); else n.delete(it.id); return n; })(),
                                  })} />
                                  <span style={{ flex: 1, color: '#374151' }}>{it.productName || '(품목)'}{disabled ? ' · 다른 업체에 배정됨' : ''}</span>
                                  <span style={{ color: '#111827', fontWeight: 600 }}>{formatWon(it.totalAmount)}</span>
                                </label>
                              );
                            })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* 100% 분할 미리보기 */}
              <div style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 12px', marginBottom: 12, fontSize: 12, color: '#374151', display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                <span>분할 합계 <b style={{ color: '#111827' }}>{formatWon(splitTotal)}</b></span>
                <span>계약금액 <b>{formatWon(base)}</b></span>
                <span style={{ color: remaining === 0 ? '#047857' : C.danger, fontWeight: 700 }}>
                  {remaining === 0 ? '✓ 100% 분할' : `차이 ${formatWon(remaining)} (100% 분할 필요)`}
                </span>
              </div>

              {fLbl2('분할 사유 (선택)')}
              <textarea value={derivedReason} onChange={e => setDerivedReason(e.target.value)} data-testid="input-derived-reason"
                placeholder="예: 고객 요청에 따른 회사별 청구 분리"
                style={{ width: '100%', minHeight: 56, boxSizing: 'border-box', padding: '9px 11px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, resize: 'vertical', marginBottom: 18 }} />

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowDerivedModal(false)} disabled={derivedBusy} data-testid="cancel-create-derived"
                  style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151' }}>취소</button>
                <button onClick={handleCreateDerived} disabled={!canSubmit} data-testid="confirm-create-derived"
                  style={{ padding: '9px 20px', borderRadius: 8, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, background: canSubmit ? C.warning : '#9ca3af', cursor: canSubmit ? 'pointer' : 'not-allowed', opacity: canSubmit ? 1 : 0.7 }}>{derivedBusy ? '생성 중…' : '분할 견적서 생성'}</button>
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );

  // ─────────────────────────────────────────────────────────────────────────
  // asPage=true: AdminDashboard 스크롤 영역 내 인라인 렌더링
  //   → QuoteListTab이 margin: '-24px -28px' wrapper로 감싸줌
  // ─────────────────────────────────────────────────────────────────────────

  if (asPage) {
    return (
      <div style={{ background: C.g50, minHeight: '100vh' }}>
        {showAiModal && (
          <AiQuoteModal
            onApply={handleApplyAiRows}
            onClose={() => setShowAiModal(false)}
          />
        )}
        {convertOverlays}
        {pdfModal}
        {/* 인라인 Workspace 헤더 — 스크롤 영역에서 full-bleed sticky (공통 헤더 토큰) */}
        <PageHeader
          onBack={onClose}
          testId="btn-quote-back"
          title={pageTitle}
          subtitle={headerSubtitle}
          right={headerActions}
          style={dsStickyPageHeader()}
        />

        {/* 카드 컨텐츠 — 좌우 여백은 스크롤 컨테이너 패딩이 제공(가로 0) */}
        <div style={{ padding: '24px 0 64px' }}>
          {formContent}
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // asPage=false (기본): position:fixed 오버레이 (ProjectDetailModal 등)
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 800, background: C.g50, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {showAiModal && (
        <AiQuoteModal
          onApply={handleApplyAiRows}
          onClose={() => setShowAiModal(false)}
        />
      )}
      {convertOverlays}
      {pdfModal}
      {wsHeader(C.bgCard, BD.card, BD.shadow.card, '24px')}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 24px 64px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          {formContent}
        </div>
      </div>
    </div>
  );
}
