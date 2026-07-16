/**
 * QuoteEditorWorkspace — VERITAS 표준 Workspace (4차 개편)
 *
 * asPage=true : AdminDashboard 스크롤 영역 안에 인라인 렌더링 → 사이드바 유지.
 * asPage=false: 기존 position:fixed 오버레이 (ProjectDetailModal 등 모달 내 사용).
 *
 * Version Engine 및 저장 로직 100% 유지.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, Product } from '../../lib/constants';
import { Card, DsButton, ClickSelect, NumericInput } from '../ui';
import { dsInput, dsInputStd, dsColH, dsRow, dsAmount, C, BD, TBL, TYPO, SP, FORM } from '../../lib/ds';
import {
  getPolicy, validateCounts, calcPagesFromStr,
  type ValidationResult,
} from '../../lib/languagePagePolicy';
import AiQuoteModal, { type AiDraftRow } from './AiQuoteModal';
import { calcInterpretation, displayUnit, buildQuotePdfData } from '../../lib/quotePdf';
import { generateQuoteTitle } from '../../lib/quoteTitle';
import QuotePdfPreviewModal from './QuotePdfPreviewModal';
import { PageHeader } from './PageHeader';

// ─── 타입 ─────────────────────────────────────────────────────────────────────

export type QuoteType    = 'b2b_standard' | 'b2c_prepaid' | 'accumulated_batch';
export type VatType      = 'taxable' | 'exempt' | 'zero_rate';
export type ServiceType  = 'translation' | 'interpretation' | 'equipment' | 'expense';

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
}

interface Company   { id: number; name: string; divisionNames?: string[] }
interface Division  { id: number; name: string }
interface Contact   { id: number; name: string; companyId: number | null; divisionId?: number | null; divisionName?: string | null }
interface AdminUser { id: number; name?: string | null; email: string }

// ─── 서비스 유형 설정 ─────────────────────────────────────────────────────────

const SVC_CFG: Record<ServiceType, { label: string; color: string; bg: string; border: string; dot: string }> = {
  translation:    { label: '번역',   color: C.primary, bg: C.primaryBg, border: '#93c5fd', dot: '#3b82f6' },
  interpretation: { label: '통역',   color: C.successText, bg: C.successBg, border: '#86efac', dot: '#10b981' },
  equipment:      { label: '장비',   color: C.warning, bg: C.warningBg, border: '#fcd34d', dot: '#f59e0b' },
  expense:        { label: '기타',   color: C.textMuted, bg: C.g50, border: C.g300, dot: C.g400 },
};
const SVC_DEFAULT_UNIT: Record<ServiceType, string> = {
  translation: '페이지', interpretation: '일', equipment: '세트', expense: '건',
};
const SVC_UNITS: Record<ServiceType, string[]> = {
  translation:    ['페이지', '단어', '글자', '건', '개'],
  interpretation: ['일', '시간', '회', '건'],
  equipment:      ['세트', '개', '일', '회', '건'],
  expense:        ['건', '회', '시간', '일', '페이지', '부', '권', '개', '세트'],
};
function getUnitOptions(serviceType: ServiceType, v: string): string[] {
  const list = SVC_UNITS[serviceType];
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

function calcItem(it: QuoteItemForm, vat: VatType) {
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
  } else {
    s = Math.round((Number(it.quantity) || 1) * p);
  }
  const tax = vat === 'taxable' ? Math.round(s * 0.1) : 0;
  return { supply: s, tax, total: s + tax };
}
function calcTotals(items: QuoteItemForm[], vat: VatType) {
  return items.reduce((a, it) => { const r = calcItem(it, vat); return { supply: a.supply + r.supply, tax: a.tax + r.tax, total: a.total + r.total }; }, { supply: 0, tax: 0, total: 0 });
}
function dateOffset(d: number) {
  const dt = new Date(); dt.setDate(dt.getDate() + d);
  return dt.toISOString().split('T')[0];
}

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
        memo:           it.memo           || undefined,
      };
    }
    case 'expense':
      return {
        ...base,
        interpretType: it.expenseType || undefined,  // 서비스 유형 (interpretType 컬럼 재활용)
        memo:          it.memo        || undefined,
      };
    default:
      return { ...base, memo: it.memo || undefined };
  }
}

// ─── 공통 인풋 스타일 — DS Compact 스케일 ────────────────────────────────────
// dsInput()의 로컬 alias. 이 파일의 모든 Grid Row 입력칸에 사용.
const rinp = dsInput;
const sep_s: React.CSSProperties = { flexShrink: 0, fontSize: 11, color: C.textMuted, userSelect: 'none' };

// ─── 상품정보 Table Grid 정의 — DS TBL 토큰 기반 ─────────────────────────────
// Header와 모든 Body Row가 동일한 grid-template-columns를 공유 → 컬럼 폭 변경 시 1곳만 수정
const TABLE_COLS = '82px 60px 170px 1fr 28px 72px 64px 112px 112px minmax(130px, 220px)';
const tblRow: React.CSSProperties = dsRow(TABLE_COLS);

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
          <div style={{ position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0, zIndex: 700, background: C.bgCard, border: `1px solid ${accentColor}`, borderRadius: 9, boxShadow: '0 6px 20px rgba(0,0,0,0.1)', maxHeight: 200, overflowY: 'auto' }}>
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

function RowControls({ idx, total, onRemove, onAddBelow, onMoveUp, onMoveDown }: {
  idx: number; total: number;
  onRemove: (i: number) => void; onAddBelow: (i: number) => void;
  onMoveUp: (i: number) => void; onMoveDown: (i: number) => void;
}) {
  const btn = (dis: boolean): React.CSSProperties => ({
    background: 'none', border: BD.card, borderRadius: 4,
    cursor: dis ? 'default' : 'pointer', fontSize: 11, lineHeight: 1,
    padding: '3px 6px', color: dis ? C.g300 : C.textMuted,
  });
  const hov = (el: HTMLButtonElement, c: string) => { el.style.background = c; };
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center', justifyContent: 'center' }}>
      <button type="button" title="행 삭제" onClick={() => onRemove(idx)} disabled={total <= 1}
        style={{ ...btn(total <= 1), color: total > 1 ? C.danger : C.g300, borderColor: total > 1 ? C.dangerBorder : C.border }}
        onMouseEnter={e => { if (total > 1) hov(e.currentTarget, C.dangerBg); }} onMouseLeave={e => hov(e.currentTarget, 'none')}>−</button>
      <button type="button" title="아래 행 추가" onClick={() => onAddBelow(idx)} style={{ ...btn(false), color: C.primary, borderColor: C.primaryBorder }}
        onMouseEnter={e => hov(e.currentTarget, C.primaryBg)} onMouseLeave={e => hov(e.currentTarget, 'none')}>+</button>
      <button type="button" title="위로 이동" onClick={() => onMoveUp(idx)} disabled={idx === 0} style={btn(idx === 0)}
        onMouseEnter={e => { if (idx > 0) hov(e.currentTarget, C.g100); }} onMouseLeave={e => hov(e.currentTarget, 'none')}>▲</button>
      <button type="button" title="아래로 이동" onClick={() => onMoveDown(idx)} disabled={idx === total - 1} style={btn(idx === total - 1)}
        onMouseEnter={e => { if (idx < total - 1) hov(e.currentTarget, C.g100); }} onMouseLeave={e => hov(e.currentTarget, 'none')}>▼</button>
    </div>
  );
}

// ─── 서비스 유형 선택 ─────────────────────────────────────────────────────────

function ServiceTypeSelector({ value, onChange }: { value: ServiceType; onChange: (t: ServiceType) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cfg = SVC_CFG[value];
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
        <div style={{ position: 'absolute', top: 'calc(100% + 2px)', left: 0, zIndex: 800, background: C.bgCard, border: BD.card, borderRadius: 9, boxShadow: '0 4px 20px rgba(0,0,0,0.12)', padding: 4, minWidth: 74 }}>
          {(Object.entries(SVC_CFG) as [ServiceType, typeof SVC_CFG[ServiceType]][]).map(([k, c]) => (
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
        <div style={{ position: 'absolute', top: 'calc(100% + 2px)', left: 0, zIndex: 900, background: C.bgCard, border: BD.card, borderRadius: 9, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', minWidth: 72, padding: 4 }}>
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
      style={style}
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
        <div style={{ position: 'absolute', top: 'calc(100% + 3px)', left: 0, zIndex: 900, background: C.bgCard, border: BD.card, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', minWidth: 114, padding: 4, maxHeight: 300, overflowY: 'auto' }}>
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
        <div style={{ position: 'absolute', top: 'calc(100% + 3px)', left: 0, zIndex: 900, background: C.bgCard, border: BD.card, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', minWidth: 130, padding: 4, maxHeight: 320, overflowY: 'auto' }}>
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

function TimeRangeField({ value, onChange, onConfirm, boxStyle }: {
  value: string; onChange: (v: string) => void; onConfirm?: (range: string) => void; boxStyle: React.CSSProperties;
}) {
  const [open, setOpen]   = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd]     = useState('');
  const ref = useRef<HTMLDivElement>(null);

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
          style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontSize: 13, padding: '0 6px', height: '100%', cursor: 'pointer' }}
          title="운영시간 (클릭하여 선택 또는 직접 입력, 예: 09:00~18:00). 공급가액 계산에는 사용되지 않습니다." />
        <span aria-hidden style={{ fontSize: 9, color: C.g400, padding: '0 6px', flexShrink: 0, userSelect: 'none' }}>▼</span>
      </div>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 3px)', left: 0, zIndex: 900, background: C.bgCard, border: BD.card, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', padding: 10, width: 190 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textPrimary, marginBottom: 6 }}>운영시간</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            {column('시작', start, pickStart, TIME_OPTIONS)}
            {column('종료', end, setEnd, start ? TIME_OPTIONS.filter(t => t > start) : TIME_OPTIONS)}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
            <span style={{ fontSize: 11, color: canConfirm ? C.textSecondary : C.g400 }}>{start && end ? `${start}~${end}` : '시작·종료 선택'}</span>
            <button type="button" onClick={confirm} disabled={!canConfirm}
              style={{ border: 'none', borderRadius: 6, padding: '4px 14px', fontSize: 12, fontWeight: 700, cursor: canConfirm ? 'pointer' : 'default', background: canConfirm ? C.primary : C.g300, color: '#fff' }}>확인</button>
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
            {/* 행사 시작일 */}
            <input type="date" value={it.interpretDate}
              onChange={e => update({ interpretDate: e.target.value })}
              style={{ ...rinp(122), height: 32, flexShrink: 0 }} title="행사 시작일" />
            <span style={sep_s}>~</span>
            {/* 행사 종료일 — 기간 행사 시 입력 / 당일은 비워둠 */}
            <input type="date" value={it.interpretEndDate}
              onChange={e => update({ interpretEndDate: e.target.value })}
              style={{ ...rinp(122), height: 32, flexShrink: 0 }} title="행사 종료일 (기간 행사 시 입력, 당일은 비워두세요)" />
            {/* 장소 */}
            <input value={it.interpretPlace}
              onChange={e => update({ interpretPlace: e.target.value })}
              placeholder="장소" style={{ ...rinp('auto'), flex: 1, minWidth: 50 }} title="행사 장소" />
            {/* 통역시간(계약) — 하루 기준 시간(숫자, 소수 허용), "N시간/일"로 표시. 안내 정보(계산 미사용) */}
            <CountInput value={it.interpretHours} onChange={v => update({ interpretHours: v })}
              unit="시간/일" placeholder="통역시간" decimal style={{ ...rinp(104), flexShrink: 0 }} />
            {/* 운영시간(행사 운영시간) — Time Range Picker(선택) + 직접 입력.
                확인 시 통역시간을 자동 계산(기본값)해 채우되, 사용자가 언제든 수정 가능 (지시문 5절) */}
            <TimeRangeField value={it.operationHours}
              onChange={v => update({ operationHours: v })}
              onConfirm={range => { const h = computeHoursPerDay(range); if (h) update({ interpretHours: h }); }}
              boxStyle={{ ...rinp(120), height: 32 }} />
            {/* 투입 인원 — "2명" 형태 표시 (CountInput) */}
            <CountInput value={it.interpreterCount} onChange={v => update({ interpreterCount: v })}
              unit="명" placeholder="인원" style={{ ...rinp(72), flexShrink: 0 }} />
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
          {/* 사용 시작일 — 변경 시 사용일수(usagePeriod) 자동 재계산 */}
          <input type="date" value={it.eventStartDate}
            onChange={e => {
              const start = e.target.value;
              const upd: Partial<QuoteItemForm> = { eventStartDate: start };
              const days = calcSpanDays(start, it.eventEndDate);
              if (days > 0) upd.usagePeriod = String(days);   // 종료일 − 시작일 + 1
              update(upd);
            }}
            style={{ ...rinp(122), height: 32, flexShrink: 0 }} title="사용 시작일" />
          <span style={sep_s}>~</span>
          {/* 사용 종료일 — 당일 사용이면 비워둠. 변경 시 사용일수 자동 재계산 */}
          <input type="date" value={it.eventEndDate}
            onChange={e => {
              const end = e.target.value;
              const upd: Partial<QuoteItemForm> = { eventEndDate: end };
              const days = calcSpanDays(it.eventStartDate, end);
              if (days > 0) upd.usagePeriod = String(days);   // 종료일 − 시작일 + 1
              update(upd);
            }}
            style={{ ...rinp(122), height: 32, flexShrink: 0 }} title="사용 종료일 (당일 사용이면 비워두세요)" />
          {/* 사용 장소 */}
          <input value={it.itemLocation}
            onChange={e => update({ itemLocation: e.target.value })}
            placeholder="사용 장소" style={{ ...rinp('auto'), flex: 1, minWidth: 50 }} title="장비 사용 장소" />
          {/* 사용일수 — 날짜 입력 시 자동 계산, 직접 수정도 가능 */}
          <CountInput value={it.usagePeriod} onChange={v => update({ usagePeriod: v })}
            unit="일" placeholder="사용일수" style={{ ...rinp(72), flexShrink: 0 }} />
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

function QuoteItemRow({ it, idx, total, vatType, products, updateItem, removeItem, addItemBelow, moveItem }: {
  it: QuoteItemForm; idx: number; total: number; vatType: VatType; products: Product[];
  updateItem: (idx: number, p: Partial<QuoteItemForm>) => void;
  removeItem: (idx: number) => void;
  addItemBelow: (idx: number) => void;
  moveItem: (idx: number, dir: 'up' | 'down') => void;
}) {
  const [showWarning, setShowWarning] = useState(false);
  const supply = calcItem(it, vatType).supply;
  const cfg    = SVC_CFG[it.productType];
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
    const productType = (p?.productType as ServiceType) ?? it.productType;
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
                background: C.g50, cursor: 'default',
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
                <div style={{ fontSize: 11, color: validation.severity === 'danger' ? C.dangerTextDeep : C.warningTextDeep, marginBottom: 6 }}>
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

// ─── 컬럼 헤더 레이블 스타일 — DS dsColH 기반 ────────────────────────────────

const COL_H: React.CSSProperties = dsColH('center');

const SVC_FIELD_HINTS: Record<ServiceType, string> = {
  translation:    '파일명 / 파일형식 / 단어수 / 글자수',
  interpretation: '시작일 ~ 종료일 / 시작시간 ~ 종료시간 / 장소 / 인원',
  equipment:      '시작일 ~ 종료일 / 사용 장소 / 사용일수',
  expense:        '서비스유형 (공증·속기·녹취·더빙·편집·감수·DTP 등)',
};

// ─── Props ────────────────────────────────────────────────────────────────────

export interface QuoteEditorWorkspaceProps {
  token:             string;
  projectId:         number | null;
  initialCompanyId?: number | null;
  initialContactId?: number | null;
  initialDivisionId?: number | null;
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
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────────

export function QuoteEditorWorkspace({
  token, projectId, initialCompanyId = null, initialContactId = null, initialDivisionId = null, initialTitle = '',
  onClose, onSaved, onToast, adminList = [], asPage = false,
  initialQuoteId, initialItems, initialNote, initialQuoteType, initialIssueDate, initialVatType,
}: QuoteEditorWorkspaceProps) {

  const authH = { Authorization: `Bearer ${token}` };
  const [showAiModal,   setShowAiModal]   = useState(false);
  const [title,          setTitle]         = useState(initialTitle);
  const [titleEdited,    setTitleEdited]   = useState(!!initialTitle);
  const [companyId,      setCompanyId]     = useState<number | null>(initialCompanyId);
  const [divisionId,     setDivisionId]    = useState<number | null>(initialDivisionId);
  const [contactId,      setContactId]     = useState<number | null>(initialContactId);
  const [adminId,        setAdminId]       = useState<number | null>(null);
  const [issueDate,      setIssueDate]     = useState(() => initialIssueDate ?? dateOffset(0));
  const [quoteType,      setQuoteType]     = useState<QuoteType>(initialQuoteType ?? 'b2b_standard');
  const [vatType,        setVatType]       = useState<VatType>(initialVatType ?? 'taxable');
  const [note,           setNote]          = useState(initialNote ?? '');
  const [versionReason,  setVersionReason] = useState('');
  const [items,          setItems]         = useState<QuoteItemForm[]>(initialItems ?? [defaultItem()]);
  const [companies,      setCompanies]     = useState<Company[]>([]);
  const [divisions,      setDivisions]     = useState<Division[]>([]);
  const [contacts,       setContacts]      = useState<Contact[]>([]);
  const [products,       setProducts]      = useState<Product[]>([]);
  const [loading,        setLoading]       = useState(true);
  const [saving,         setSaving]        = useState(false);
  // 견적서 버튼: 신규 견적을 자동 저장하면 이후 저장은 이 id로 업데이트(중복 생성 방지)
  const [savedQuoteId,   setSavedQuoteId]  = useState<number | null>(initialQuoteId ?? null);
  // 견적서 미리보기 모달 데이터 (편집 화면 위에 오버레이 → 편집 상태 유지)
  const [previewData,    setPreviewData]   = useState<{ data: ReturnType<typeof buildQuotePdfData>; title: string } | null>(null);

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

  useEffect(() => {
    if (titleEdited || projectId !== null) return;
    const co = companies.find(c => c.id === companyId);
    const vi = items.filter(it => it.productName.trim());
    if (!co || vi.length === 0) return;
    // 견적서명은 공통 함수 generateQuoteTitle()로 생성한다 (대표상품 선정·외 N건·날짜 포함).
    // 회사/브랜드/상품 추가·삭제/상품명/공급가액/날짜 변경 시 이 effect가 재실행되어 자동 갱신된다.
    // (최초 기본값일 뿐, 사용자가 수정하면 titleEdited 가드로 덮어쓰지 않음)
    const brand = divisions.find(d => d.id === divisionId);
    const nextTitle = generateQuoteTitle({
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
    });
    if (nextTitle) setTitle(nextTitle);
  }, [companyId, divisionId, divisions, items, issueDate, vatType, companies, products, titleEdited, projectId]);

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

  const updateItem   = (idx: number, p: Partial<QuoteItemForm>) => setItems(prev => prev.map((it, i) => i === idx ? { ...it, ...p } : it));
  const addItemBelow = (idx: number) => setItems(prev => [...prev.slice(0, idx + 1), defaultItem(), ...prev.slice(idx + 1)]);
  const removeItem   = (idx: number) => setItems(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);
  const moveItem     = (idx: number, dir: 'up' | 'down') => setItems(prev => {
    const next = [...prev]; const swap = dir === 'up' ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= next.length) return prev;
    [next[idx], next[swap]] = [next[swap], next[idx]]; return next;
  });

  // AI 초안 → QuoteItemForm 변환 후 기존 Row 아래에 추가
  const handleApplyAiRows = (draftRows: AiDraftRow[]) => {
    const defaultUnit: Record<ServiceType, string> = {
      translation: '페이지', interpretation: '일', equipment: '세트', expense: '건',
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
  const fieldHint = (() => { const t = [...new Set(items.map(it => it.productType))]; return t.length === 1 ? SVC_FIELD_HINTS[t[0]] : '서비스별 상세 입력 필드'; })();

  // 저장 실행부 — 편집 화면을 닫지 않고 저장만 수행하고 { quoteId, projectId }를 반환한다.
  // 신규 견적은 최초 저장 시 생성하고 savedQuoteId를 기록 → 이후(저장/견적서)엔 동일 견적을 업데이트(중복 생성 방지).
  const persistQuote = useCallback(async (): Promise<{ quoteId: number; projectId: number | null } | null> => {
    const vi = items.filter(it => it.productName.trim() && Number(it.unitPrice.replace?.(/,/g, '') || 0) > 0);
    if (vi.length === 0) { onToast('품목명과 단가를 입력하세요.'); return null; }
    const itemsBody  = vi.map(it => toApiItem(it, vatType));
    const commonBody = {
      items: itemsBody, quoteType,
      billingType: 'postpaid_per_project', taxDocumentType: 'tax_invoice', taxCategory: 'normal',
      issueDate, validUntil: (() => { const d = new Date(issueDate); d.setDate(d.getDate() + 30); return d.toISOString().split('T')[0]; })(),
      note: note.trim() || undefined,
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
  }, [items, projectId, savedQuoteId, title, companyId, contactId, divisionId, adminId, issueDate, quoteType, vatType, note, versionReason, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = useCallback(async () => {
    const isUpdate = savedQuoteId != null;
    const r = await persistQuote();
    if (!r) return;
    onToast(isUpdate ? '견적이 수정되었습니다.' : '견적서가 저장되었습니다.');
    onSaved(r);
  }, [persistQuote, onSaved, onToast, savedQuoteId]);

  // 견적서 버튼 — 현재 편집 내용을 자동 저장(신규=생성/기존=업데이트)한 뒤 최신 견적서를 미리보기로 표시.
  // 편집 화면은 그대로 유지되어 확인 후 즉시 재수정 가능 (지시문 3~6절).
  const handleShowQuote = useCallback(async () => {
    const r = await persistQuote();
    if (!r) return;
    try {
      const res = await fetch(api(`/api/admin/quotes/${r.quoteId}`), { headers: authH });
      if (!res.ok) { onToast('견적서 생성에 실패했습니다.'); return; }
      const detail = await res.json();
      setPreviewData({ data: buildQuotePdfData(detail), title: title.trim() || detail.title || `견적 #${r.quoteId}` });
    } catch { onToast('견적서 생성 중 오류가 발생했습니다.'); }
  }, [persistQuote, title, token, onToast]); // eslint-disable-line react-hooks/exhaustive-deps


  // ─── 공통 Form 컨텐츠 ─────────────────────────────────────────────────────

  const inpSt: React.CSSProperties = dsInputStd();
  const fLbl  = (txt: string, req = false) => (
    <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: SP[2] }}>
      {txt}{req && <span style={{ color: C.danger, marginLeft: 2 }}>*</span>}
    </label>
  );

  const formContent = loading ? (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: C.g400, fontSize: 14 }}>데이터 불러오는 중…</div>
  ) : (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      {/* ── A. 기본정보 ─────────────────────────────────────────────────── */}
      <Card>
        <CardSectionHeader badge="A" badgeBg="#eff6ff" badgeColor="#2563eb" title="기본정보" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px 20px' }}>
          <div>
            {fLbl('견적서 유형')}
            <ClickSelect value={quoteType} onChange={v => setQuoteType(v as QuoteType)}
              triggerStyle={dsInputStd()}
              options={[{ value: 'b2b_standard', label: '일반 견적서', sub: '일반 B2B 프로젝트' }, { value: 'b2c_prepaid', label: '차감 견적서', sub: '선입금 잔액 차감' }, { value: 'accumulated_batch', label: '누적 견적서', sub: '월별 누적 청구' }]} />
          </div>
          <div>
            {fLbl('견적일')}
            <input type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} style={inpSt} />
          </div>
          <div>
            {fLbl('부가세')}
            <ClickSelect value={vatType} onChange={v => setVatType(v as VatType)}
              triggerStyle={dsInputStd()}
              options={[{ value: 'taxable', label: '부가세 10%' }, { value: 'exempt', label: '면세' }, { value: 'zero_rate', label: '영세율' }]} />
          </div>
          {isStandalone && (
            <div style={{ gridColumn: 'span 3' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                {fLbl('견적서명', true)}
                {!titleEdited && title && <span style={{ fontSize: 10, color: C.textMuted, fontStyle: 'italic', marginBottom: 4 }}>자동생성됨</span>}
              </div>
              <input value={title} onChange={e => { setTitle(e.target.value); setTitleEdited(true); }} placeholder="예: VERITAS│삼성전자_영어↔한국어 동시통역_20260720" style={inpSt} />
            </div>
          )}
          {isStandalone && (
            <div>
              {fLbl('거래처')}
              <InlineSearchField items={companyOptions} value={companyId} onChange={handleCompanyChange} placeholder="거래처 검색…" popupTitle="거래처 검색" />
            </div>
          )}
          {/* 브랜드(Division) — 브랜드가 있는 거래처에서만 표시, 선택사항 */}
          {isStandalone && divisions.length > 0 && (
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
      </Card>

      {/* ── B. 상품정보 ─────────────────────────────────────────────────── */}
      <Card>
        <CardSectionHeader badge="B" badgeBg="#f0fdf4" badgeColor="#16a34a" title="상품정보" hint="← 유형 클릭으로 번역/통역/장비/기타 전환" />

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
            <QuoteItemRow key={idx} it={it} idx={idx} total={items.length} vatType={vatType} products={products}
              updateItem={updateItem} removeItem={removeItem} addItemBelow={addItemBelow} moveItem={moveItem} />
          ))}
        </div>

        {/* 유형별 항목 추가 버튼 */}
        <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
          {(['translation', 'interpretation', 'equipment', 'expense'] as ServiceType[]).map(type => {
            const c = SVC_CFG[type];
            return (
              <button key={type} type="button"
                onClick={() => setItems(prev => [...prev, { ...defaultItem(), ...defaultItemForType(type) }])}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: c.color, background: c.bg, border: `1px dashed ${c.border}`, borderRadius: 7, padding: '5px 12px', cursor: 'pointer', fontWeight: 600 }}
                onMouseEnter={e => (e.currentTarget.style.opacity = '0.75')} onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
                + {c.label} 항목
              </button>
            );
          })}
        </div>
      </Card>

      {/* ── C. 금액 요약 ─────────────────────────────────────────────────── */}
      <Card>
        <CardSectionHeader badge="C" badgeBg="#fffbeb" badgeColor="#d97706" title="금액 요약" />
        {/* 서비스 유형별 소계 (복수 유형 시) */}
        {(() => {
          const gs = (['translation', 'interpretation', 'equipment', 'expense'] as ServiceType[]).map(type => {
            const ti = items.filter(it => it.productType === type);
            if (!ti.length) return null;
            const s = calcTotals(ti, vatType);
            const c = SVC_CFG[type];
            return s.supply > 0 ? (
              <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', background: c.bg, border: `1px solid ${c.border}`, borderRadius: 7 }}>
                <span style={{ ...TYPO.badge, color: c.color }}>{c.label}</span>
                <span style={{ ...TYPO.fieldLabel, color: C.textSecondary }}>{s.supply.toLocaleString()}원</span>
              </div>
            ) : null;
          }).filter(Boolean);
          return gs.length > 1 ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>{gs}</div> : null;
        })()}
        <div style={{ display: 'flex', gap: SP[6], justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {[{ label: '공급가액', value: totals.supply }, { label: '부가세', value: totals.tax }].map(r => (
            <div key={r.label} style={{ textAlign: 'right', padding: `${SP[4]}px ${SP[5]}px`, borderRadius: BD.radius.lg, background: C.bgHover }}>
              <div style={{ ...TYPO.helper, marginBottom: 3 }}>{r.label}</div>
              <div style={{ ...TYPO.summaryAmount }}>{r.value.toLocaleString()}원</div>
            </div>
          ))}
          <div style={{ textAlign: 'right', padding: `${SP[5]}px ${SP[7]}px`, borderRadius: BD.radius.xl, background: C.primaryBg, border: `1.5px solid ${C.primaryBorder}` }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.primary, marginBottom: 3 }}>총 견적금액</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.primaryText, letterSpacing: '-0.01em' }}>{totals.total.toLocaleString()}원</div>
          </div>
        </div>
      </Card>

      {/* ── D. 비고 / 버전 사유 ─────────────────────────────────────────── */}
      <Card>
        <CardSectionHeader badge="D" badgeBg="#f5f3ff" badgeColor="#7c3aed" title="비고 / 기타" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            {fLbl('견적 비고')}
            <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="견적 관련 메모 또는 안내 사항" rows={2}
              style={{ ...inpSt, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
          {projectId !== null && (
            <div style={{ background: C.warningBg, borderRadius: BD.radius.xl, padding: `${SP[5]}px ${SP[6]}px`, border: `1px solid ${C.warningBorder}` }}>
              <label style={{ ...TYPO.fieldLabel, color: C.warningText, display: 'block', marginBottom: SP[3] }}>
                버전 변경 사유 <span style={{ marginLeft: SP[2], fontWeight: 400, color: C.warning }}>— 저장 시 새 Version으로 기록됩니다</span>
              </label>
              <input value={versionReason} onChange={e => setVersionReason(e.target.value)}
                placeholder="예: 최초 견적 / 일정 변경 / 금액 수정 / 고객 요청" style={{ ...inpSt, background: C.bgCard }} />
            </div>
          )}
        </div>
      </Card>
    </div>
  );

  // ─── 공통 Workspace 헤더 (PageHeader 기반) ────────────────────────────────

  // 페이지 제목은 업무(작성/수정)를 나타낸다 — '새' 등 신규 상태 표현은 쓰지 않는다.
  // 기존 견적 편집 진입(initialQuoteId) → '견적서 수정', 그 외(신규 작성) → '견적서 작성'.
  const pageTitle = initialQuoteId != null ? '견적서 수정' : '견적서 작성';
  // 우측 기능 버튼 그룹 — 두 헤더(오버레이·인라인)가 공유
  const headerActions = (
    <>
      <button type="button" onClick={() => setShowAiModal(true)} data-testid="btn-ai-quote" aria-label="AI 견적 생성"
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', background: C.ai, color: '#ffffff' }}>
        🤖 AI 견적 생성
      </button>
      <DsButton variant="secondary" size="md" onClick={handleShowQuote} disabled={saving}>📄 견적서</DsButton>
      <DsButton variant="primary" size="md" onClick={handleSave} disabled={saving}>
        {saving ? '저장 중…' : '💾 저장'}
      </DsButton>
    </>
  );

  const wsHeader = (bg: string, border: string, shadow: string, padH: string) => (
    <PageHeader
      onBack={onClose}
      testId="btn-quote-back"
      title={pageTitle}
      subtitle={projectId !== null ? 'Version Engine' : undefined}
      right={headerActions}
      style={{ background: bg, borderBottom: border, boxShadow: shadow, padding: `0 ${padH}` }}
    />
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
        {/* 견적서 미리보기 — 편집 화면 위 오버레이(zIndex 2000). 닫으면 편집 상태 그대로 유지 */}
        {previewData && (
          <QuotePdfPreviewModal data={previewData.data} quoteTitle={previewData.title} onClose={() => setPreviewData(null)} />
        )}
        {/* 인라인 Workspace 헤더 — 스크롤 영역에서 sticky (PageHeader 공통 구조) */}
        <PageHeader
          onBack={onClose}
          testId="btn-quote-back"
          title={pageTitle}
          subtitle={projectId !== null ? 'Version Engine' : undefined}
          right={headerActions}
          style={{ position: 'sticky', top: 0, zIndex: 20, background: C.bgCard, borderBottom: BD.card, padding: '0 28px', boxShadow: BD.shadow.card }}
        />

        {/* 카드 컨텐츠 */}
        <div style={{ padding: '24px 28px 64px' }}>
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
      {/* 견적서 미리보기 — 편집 화면 위 오버레이(zIndex 2000). 닫으면 편집 상태 그대로 유지 */}
      {previewData && (
        <QuotePdfPreviewModal data={previewData.data} quoteTitle={previewData.title} onClose={() => setPreviewData(null)} />
      )}
      {wsHeader(C.bgCard, BD.card, BD.shadow.card, '24px')}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 24px 64px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          {formContent}
        </div>
      </div>
    </div>
  );
}
