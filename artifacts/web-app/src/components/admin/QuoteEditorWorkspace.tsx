/**
 * QuoteEditorWorkspace — AI-First 견적 작성 Workspace (2차 개편)
 *
 * 서비스 유형(번역/통역/장비/기타)별 입력 구조 전환.
 * quote_items 기존 컬럼(interpretDate, interpretPlace, eventStartDate 등) 활용.
 * Version Engine 및 저장 구조 100% 유지.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, Product } from '../../lib/constants';
import { GhostBtn, ClickSelect, NumericInput } from '../ui';

// ─── 타입 ─────────────────────────────────────────────────────────────────────

type QuoteType    = 'b2b_standard' | 'b2c_prepaid' | 'accumulated_batch';
type VatType      = 'taxable' | 'exempt' | 'zero_rate';
type CreationMode = 'direct' | 'ai';
type ServiceType  = 'translation' | 'interpretation' | 'equipment' | 'expense';

/** 견적 항목 폼 (서비스 유형별 전용 필드 포함) */
export interface QuoteItemForm {
  // ── 공통 ─────────────────────────────────────────────────
  productId:    number | null;
  productName:  string;
  productType:  ServiceType;
  unit:         string;
  quantity:     string;
  unitPrice:    string;
  taxType:      VatType;
  memo:         string;

  // ── 번역 전용 ────────────────────────────────────────────
  sourceLanguage: string;  // languagePair 생성에 사용
  targetLanguage: string;
  wordCount:      string;  // 참고용 → memo 패킹
  charCount:      string;  // 참고용 → memo 패킹

  // ── 통역 전용 ────────────────────────────────────────────
  interpretDate:  string;  // → interpretDate
  startTime:      string;  // ─┐ interpretDuration 패킹
  endTime:        string;  // ─┘ "09:00~18:00"
  interpretPlace: string;  // → interpretPlace
  headcount:      string;  // → memo

  // ── 장비 전용 ────────────────────────────────────────────
  eventStartDate: string;  // → eventStartDate
  itemLocation:   string;  // → itemLocation
  quantityUnit:   string;  // → quantityUnit
  usagePeriod:    string;  // → usagePeriod
}

interface Company   { id: number; name: string; divisionNames?: string[] }
interface Contact   { id: number; name: string; companyId: number | null }
interface AdminUser { id: number; name?: string | null; email: string }

// ─── 서비스 유형 설정 ─────────────────────────────────────────────────────────

const SVC_CFG: Record<ServiceType, { label: string; color: string; bg: string; border: string; dot: string }> = {
  translation:    { label: '번역',   color: '#2563eb', bg: '#eff6ff', border: '#93c5fd', dot: '#3b82f6' },
  interpretation: { label: '통역',   color: '#059669', bg: '#f0fdf4', border: '#86efac', dot: '#10b981' },
  equipment:      { label: '장비',   color: '#d97706', bg: '#fffbeb', border: '#fcd34d', dot: '#f59e0b' },
  expense:        { label: '기타',   color: '#6b7280', bg: '#f9fafb', border: '#d1d5db', dot: '#9ca3af' },
};

const SVC_UNITS: Record<ServiceType, string> = {
  translation:    '건',
  interpretation: '시간',
  equipment:      '개',
  expense:        '건',
};

// ─── 계산 ─────────────────────────────────────────────────────────────────────

function calcItem(it: QuoteItemForm, vatType: VatType) {
  const price  = Number(it.unitPrice.replace?.(/,/g, '') || 0);
  const qty    = Number(it.quantity || 1);
  const supply = Math.round(qty * price);
  const tax    = vatType === 'taxable' ? Math.round(supply * 0.1) : 0;
  return { supply, tax, total: supply + tax };
}

function calcTotals(items: QuoteItemForm[], vatType: VatType) {
  return items.reduce(
    (acc, it) => { const r = calcItem(it, vatType); return { supply: acc.supply + r.supply, tax: acc.tax + r.tax, total: acc.total + r.total }; },
    { supply: 0, tax: 0, total: 0 },
  );
}

function dateOffset(days: number) {
  const d = new Date(); d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function defaultItem(): QuoteItemForm {
  return {
    productId: null, productName: '', productType: 'translation',
    unit: '건', quantity: '1', unitPrice: '', taxType: 'taxable', memo: '',
    sourceLanguage: '', targetLanguage: '', wordCount: '', charCount: '',
    interpretDate: '', startTime: '', endTime: '', interpretPlace: '', headcount: '',
    eventStartDate: '', itemLocation: '', quantityUnit: '', usagePeriod: '',
  };
}

function defaultItemForType(type: ServiceType): Partial<QuoteItemForm> {
  return { productType: type, unit: SVC_UNITS[type] };
}

// ─── 저장 시 API 항목 변환 ────────────────────────────────────────────────────

function toApiItem(it: QuoteItemForm, vatType: VatType) {
  const base = {
    productId:   it.productId ?? undefined,
    productName: it.productName.trim(),
    unit:        it.unit || SVC_UNITS[it.productType],
    quantity:    Number(it.quantity) || 1,
    unitPrice:   Number(it.unitPrice.replace?.(/,/g, '') || 0),
    taxRate:     (vatType === 'taxable' ? 0.1 : 0) as 0 | 0.1,
    taxType:     vatType,
    itemType:    it.productType,
    memo:        it.memo || undefined,
  };

  switch (it.productType) {
    case 'translation': {
      const refParts = [
        it.wordCount && `단어수: ${it.wordCount}`,
        it.charCount && `글자수: ${it.charCount}`,
      ].filter(Boolean).join(' | ');
      const langPair = [it.sourceLanguage.trim(), it.targetLanguage.trim()].filter(Boolean).join('→');
      return {
        ...base,
        languagePair: langPair || undefined,
        memo: [it.memo, refParts].filter(Boolean).join(' | ') || undefined,
      };
    }
    case 'interpretation': {
      const langPair = [it.sourceLanguage.trim(), it.targetLanguage.trim()].filter(Boolean).join('↔');
      const dur      = [it.startTime, it.endTime].filter(Boolean).join('~');
      const hcMemo   = it.headcount ? `인원: ${it.headcount}명` : '';
      return {
        ...base,
        languagePair:     langPair || undefined,
        interpretDate:    it.interpretDate   || undefined,
        interpretPlace:   it.interpretPlace  || undefined,
        interpretDuration: dur               || undefined,
        memo: [it.memo, hcMemo].filter(Boolean).join(' | ') || undefined,
      };
    }
    case 'equipment':
      return {
        ...base,
        eventStartDate: it.eventStartDate || undefined,
        itemLocation:   it.itemLocation   || undefined,
        quantityUnit:   it.quantityUnit   || undefined,
        usagePeriod:    it.usagePeriod    || undefined,
      };
    default:
      return base;
  }
}

// ─── 공통 인풋 스타일 ─────────────────────────────────────────────────────────

const row_inp = (w: number | string = '100%', extra: React.CSSProperties = {}): React.CSSProperties => ({
  width: typeof w === 'number' ? w : w,
  boxSizing: 'border-box',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  padding: '4px 6px',
  fontSize: 12,
  outline: 'none',
  minWidth: 0,
  background: '#fff',
  ...extra,
});

const sep_style: React.CSSProperties = {
  flexShrink: 0, fontSize: 11, color: '#9ca3af', userSelect: 'none',
};

// ─── 하이브리드 검색 팝업 ──────────────────────────────────────────────────────

function SearchPopup({ title, items, value, onSelect, onClose }: {
  title: string;
  items: { id: number; label: string; sub?: string }[];
  value: number | null;
  onSelect: (id: number | null) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const filtered = q.trim()
    ? items.filter(i => i.label.toLowerCase().includes(q.toLowerCase()) || (i.sub ?? '').toLowerCase().includes(q.toLowerCase())).slice(0, 40)
    : items.slice(0, 40);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 14, width: 480, maxHeight: '70vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ padding: '14px 18px 10px', borderBottom: '1px solid #f0f2f5', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, color: '#9ca3af', cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ padding: '10px 18px', borderBottom: '1px solid #f0f2f5' }}>
          <input ref={ref} value={q} onChange={e => setQ(e.target.value)} placeholder="검색어를 입력하세요…"
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', fontSize: 14, border: '1.5px solid #6366f1', borderRadius: 8, outline: 'none' }} />
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {value !== null && (
            <div onClick={() => { onSelect(null); onClose(); }}
              style={{ padding: '10px 18px', fontSize: 13, color: '#9ca3af', cursor: 'pointer', borderBottom: '1px solid #f8f9fa' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={e => (e.currentTarget.style.background = '')}>
              선택 해제
            </div>
          )}
          {filtered.length === 0 && <div style={{ padding: '24px 18px', textAlign: 'center', fontSize: 13, color: '#9ca3af' }}>검색 결과 없습니다.</div>}
          {filtered.map(item => (
            <div key={item.id} onClick={() => { onSelect(item.id); onClose(); }}
              style={{ padding: '10px 18px', cursor: 'pointer', background: item.id === value ? '#eff6ff' : undefined, borderBottom: '1px solid #f8f9fa' }}
              onMouseEnter={e => { if (item.id !== value) (e.currentTarget as HTMLDivElement).style.background = '#f8fafc'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = item.id === value ? '#eff6ff' : ''; }}>
              <div style={{ fontSize: 14, fontWeight: item.id === value ? 700 : 400, color: '#111827' }}>{item.label}</div>
              {item.sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{item.sub}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── 인라인 검색 필드 (하이브리드) ────────────────────────────────────────────

function InlineSearchField({ items, value, onChange, placeholder = '검색…', popupTitle = '검색', accentColor = '#6366f1', compact = false }: {
  items:       { id: number; label: string; sub?: string }[];
  value:       number | null;
  onChange:    (id: number | null) => void;
  placeholder?: string;
  popupTitle?: string;
  accentColor?: string;
  compact?:    boolean;
}) {
  const [open, setOpen]         = useState(false);
  const [q, setQ]               = useState('');
  const [showPopup, setShowPopup] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = items.find(i => i.id === value);

  const filtered = q.trim()
    ? items.filter(i => i.label.toLowerCase().includes(q.toLowerCase()) || (i.sub ?? '').toLowerCase().includes(q.toLowerCase())).slice(0, 12)
    : items.slice(0, 12);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setQ(''); } };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const pad = compact ? '4px 6px' : '7px 10px';
  const fs  = compact ? 12 : 13;

  return (
    <>
      <div ref={ref} style={{ position: 'relative', display: 'flex', alignItems: 'center', border: `1px solid ${open ? accentColor : '#d1d5db'}`, borderRadius: 7, background: '#fff', minWidth: 0, flex: 1, transition: 'border-color 0.12s' }}>
        <input
          value={open ? q : (selected?.label ?? '')}
          onChange={e => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => { setOpen(true); if (selected) setQ(''); }}
          placeholder={placeholder}
          style={{ flex: 1, minWidth: 0, padding: pad, fontSize: fs, border: 'none', outline: 'none', background: 'transparent', color: selected && !open ? '#111827' : undefined }}
        />
        <button type="button" title="전체 검색" onClick={() => { setOpen(false); setShowPopup(true); }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', fontSize: 12, color: '#6366f1', flexShrink: 0 }}>🔍</button>
        {value !== null && (
          <button type="button" title="초기화" onClick={() => { onChange(null); setQ(''); setOpen(false); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', fontSize: 12, color: '#9ca3af', flexShrink: 0 }}>🧽</button>
        )}
        {open && (
          <div style={{ position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0, zIndex: 700, background: '#fff', border: `1px solid ${accentColor}`, borderRadius: 9, boxShadow: '0 6px 20px rgba(0,0,0,0.1)', maxHeight: 200, overflowY: 'auto' }}>
            {value !== null && <div onClick={() => { onChange(null); setQ(''); setOpen(false); }} style={{ padding: '6px 10px', fontSize: 12, color: '#9ca3af', cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }} onMouseEnter={e => (e.currentTarget.style.background = '#f8f9fa')} onMouseLeave={e => (e.currentTarget.style.background = '')}>선택 해제</div>}
            {filtered.length === 0 && <div style={{ padding: '8px 10px', fontSize: 12, color: '#9ca3af' }}>결과 없음 — <span style={{ color: accentColor, cursor: 'pointer', fontWeight: 600 }} onClick={() => { setOpen(false); setShowPopup(true); }}>전체 검색 🔍</span></div>}
            {filtered.map(item => (
              <div key={item.id} onClick={() => { onChange(item.id); setQ(''); setOpen(false); }}
                style={{ padding: '6px 10px', cursor: 'pointer', background: item.id === value ? '#eff6ff' : undefined }}
                onMouseEnter={e => { if (item.id !== value) (e.currentTarget as HTMLDivElement).style.background = '#f8fafc'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = item.id === value ? '#eff6ff' : ''; }}>
                <div style={{ fontSize: 12, fontWeight: item.id === value ? 700 : 400, color: '#111827' }}>{item.label}</div>
                {item.sub && <div style={{ fontSize: 10, color: '#9ca3af' }}>{item.sub}</div>}
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
    background: 'none', border: '1px solid #e5e7eb', borderRadius: 4,
    cursor: dis ? 'default' : 'pointer', fontSize: 10, lineHeight: 1,
    padding: '3px 5px', color: dis ? '#d1d5db' : '#6b7280', transition: 'all 0.1s',
  });
  const hoverBg = (el: HTMLButtonElement, c: string) => { el.style.background = c; };
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
      <button type="button" title="행 삭제" onClick={() => onRemove(idx)} disabled={total <= 1}
        style={{ ...btn(total <= 1), color: total > 1 ? '#e11d48' : '#d1d5db', borderColor: total > 1 ? '#fca5a5' : '#e5e7eb' }}
        onMouseEnter={e => { if (total > 1) hoverBg(e.currentTarget, '#fef2f2'); }}
        onMouseLeave={e => { hoverBg(e.currentTarget, 'none'); }}>−</button>
      <button type="button" title="아래 행 추가" onClick={() => onAddBelow(idx)} style={{ ...btn(false), color: '#2563eb', borderColor: '#bfdbfe' }}
        onMouseEnter={e => hoverBg(e.currentTarget, '#eff6ff')} onMouseLeave={e => hoverBg(e.currentTarget, 'none')}>+</button>
      <button type="button" title="위로 이동" onClick={() => onMoveUp(idx)} disabled={idx === 0} style={btn(idx === 0)}
        onMouseEnter={e => { if (idx > 0) hoverBg(e.currentTarget, '#f3f4f6'); }} onMouseLeave={e => hoverBg(e.currentTarget, 'none')}>▲</button>
      <button type="button" title="아래로 이동" onClick={() => onMoveDown(idx)} disabled={idx === total - 1} style={btn(idx === total - 1)}
        onMouseEnter={e => { if (idx < total - 1) hoverBg(e.currentTarget, '#f3f4f6'); }} onMouseLeave={e => hoverBg(e.currentTarget, 'none')}>▼</button>
    </div>
  );
}

// ─── 서비스 유형 선택 버튼 ───────────────────────────────────────────────────

function ServiceTypeSelector({ value, onChange }: { value: ServiceType; onChange: (t: ServiceType) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cfg = SVC_CFG[value];

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" onClick={() => setOpen(v => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 3, background: cfg.bg, color: cfg.color, border: `1.5px solid ${cfg.border}`, borderRadius: 6, padding: '3px 7px', fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', width: 56 }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.dot, flexShrink: 0 }} />
        {cfg.label}
        <span style={{ fontSize: 7, marginLeft: 'auto' }}>▼</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 2px)', left: 0, zIndex: 800, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9, boxShadow: '0 4px 20px rgba(0,0,0,0.12)', padding: 4, minWidth: 72 }}>
          {(Object.entries(SVC_CFG) as [ServiceType, typeof SVC_CFG[ServiceType]][]).map(([k, c]) => (
            <button key={k} type="button"
              onClick={() => { onChange(k); setOpen(false); }}
              style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%', textAlign: 'left', padding: '5px 8px', background: value === k ? c.bg : 'transparent', color: c.color, border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: value === k ? 700 : 400 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.dot, flexShrink: 0 }} />
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 서비스 유형별 동적 입력 필드 ────────────────────────────────────────────

function ServiceFields({ it, idx, update }: {
  it: QuoteItemForm;
  idx: number;
  update: (patch: Partial<QuoteItemForm>) => void;
}) {
  const i = row_inp;

  switch (it.productType) {
    case 'translation':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
          {/* 언어쌍 */}
          <input value={it.sourceLanguage} onChange={e => update({ sourceLanguage: e.target.value })}
            placeholder="출발어" style={i(46)} title="출발 언어 (예: 한국어, KO)" />
          <span style={sep_style}>→</span>
          <input value={it.targetLanguage} onChange={e => update({ targetLanguage: e.target.value })}
            placeholder="도착어" style={i(46)} title="도착 언어 (예: 영어, EN)" />
          {/* 단어수 */}
          <input value={it.wordCount} onChange={e => update({ wordCount: e.target.value })}
            placeholder="단어수" style={i(64)} title="단어수 (참고용)" />
          {/* 글자수 */}
          <input value={it.charCount} onChange={e => update({ charCount: e.target.value })}
            placeholder="글자수" style={{ ...i(64), color: '#6b7280' }} title="글자수 (참고용)" />
        </div>
      );

    case 'interpretation':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
          {/* 언어쌍 */}
          <input value={it.sourceLanguage} onChange={e => update({ sourceLanguage: e.target.value })}
            placeholder="출발어" style={i(44)} />
          <span style={sep_style}>↔</span>
          <input value={it.targetLanguage} onChange={e => update({ targetLanguage: e.target.value })}
            placeholder="도착어" style={i(44)} />
          {/* 행사일 */}
          <input type="date" value={it.interpretDate} onChange={e => update({ interpretDate: e.target.value })}
            style={i(96)} title="행사일" />
          {/* 시작~종료 */}
          <input value={it.startTime} onChange={e => update({ startTime: e.target.value })}
            placeholder="시작" style={i(44)} title="시작 시간 (예: 09:00)" />
          <span style={sep_style}>~</span>
          <input value={it.endTime} onChange={e => update({ endTime: e.target.value })}
            placeholder="종료" style={i(44)} title="종료 시간 (예: 18:00)" />
          {/* 장소 */}
          <input value={it.interpretPlace} onChange={e => update({ interpretPlace: e.target.value })}
            placeholder="장소" style={{ ...i('auto'), flex: 1, minWidth: 60 }} title="통역 장소" />
          {/* 인원 */}
          <input value={it.headcount} onChange={e => update({ headcount: e.target.value })}
            placeholder="인원" style={i(44)} title="인원수 (참고용)" />
        </div>
      );

    case 'equipment':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
          {/* 사용일 */}
          <input type="date" value={it.eventStartDate} onChange={e => update({ eventStartDate: e.target.value })}
            style={i(96)} title="장비 사용일" />
          {/* 장소 */}
          <input value={it.itemLocation} onChange={e => update({ itemLocation: e.target.value })}
            placeholder="사용 장소" style={{ ...i('auto'), flex: 1, minWidth: 80 }} title="장비 사용 장소" />
          {/* 사용기간 */}
          <input value={it.usagePeriod} onChange={e => update({ usagePeriod: e.target.value })}
            placeholder="사용기간" style={i(68)} title="사용 기간 (예: 1일, 반일)" />
        </div>
      );

    case 'expense':
    default:
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
          <input value={it.memo} onChange={e => update({ memo: e.target.value })}
            placeholder="항목 설명 / 메모" style={{ ...i('auto'), flex: 1 }} />
        </div>
      );
  }
}

// ─── 상품 유형별 컬럼 힌트 ────────────────────────────────────────────────────

const SVC_HINTS: Record<ServiceType, string> = {
  translation:    '언어쌍 / 단어수',
  interpretation: '언어쌍 / 행사일 / 시간 / 장소 / 인원',
  equipment:      '사용일 / 장소 / 사용기간',
  expense:        '메모',
};

// ─── 견적 항목 행 컴포넌트 ────────────────────────────────────────────────────

function QuoteItemRow({ it, idx, total, vatType, products, updateItem, removeItem, addItemBelow, moveItem }: {
  it: QuoteItemForm; idx: number; total: number; vatType: VatType;
  products: Product[];
  updateItem: (idx: number, patch: Partial<QuoteItemForm>) => void;
  removeItem: (idx: number) => void;
  addItemBelow: (idx: number) => void;
  moveItem: (idx: number, dir: 'up' | 'down') => void;
}) {
  const supply = calcItem(it, vatType).supply;
  const cfg    = SVC_CFG[it.productType];

  const productOptions = products.map(p => ({
    id: p.id, label: p.name, sub: p.code ?? undefined,
  }));

  const selectProduct = (pid: number | null) => {
    const p = pid != null ? products.find(pr => pr.id === pid) : null;
    updateItem(idx, {
      productId:   p?.id ?? null,
      productName: p?.name ?? '',
      productType: (p?.productType as ServiceType) ?? it.productType,
      unit:        p?.unit ?? SVC_UNITS[it.productType],
    });
  };

  const handleTypeChange = (t: ServiceType) => {
    updateItem(idx, { ...defaultItemForType(t), productId: null, productName: '' });
  };

  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 8px', borderBottom: '1px solid #f0f2f5', minHeight: 40, transition: 'background 0.1s' }}
      onMouseEnter={e => (e.currentTarget.style.background = '#fafcff')}
      onMouseLeave={e => (e.currentTarget.style.background = '')}
    >
      {/* ① 행 제어 (항상 가장 왼쪽) */}
      <div style={{ flexShrink: 0, width: 90 }}>
        <RowControls idx={idx} total={total}
          onRemove={removeItem} onAddBelow={addItemBelow}
          onMoveUp={i => moveItem(i, 'up')} onMoveDown={i => moveItem(i, 'down')} />
      </div>

      {/* ② 서비스 유형 */}
      <div style={{ flexShrink: 0 }}>
        <ServiceTypeSelector value={it.productType} onChange={handleTypeChange} />
      </div>

      {/* ③ 상품 검색 (하이브리드) */}
      <div style={{ flexShrink: 0, width: 158, display: 'flex' }}>
        <InlineSearchField
          items={productOptions}
          value={it.productId}
          onChange={selectProduct}
          placeholder="상품 검색…"
          popupTitle="상품 검색"
          accentColor={cfg.border}
          compact
        />
      </div>

      {/* ④ 서비스 유형별 동적 입력 필드 */}
      <ServiceFields it={it} idx={idx} update={patch => updateItem(idx, patch)} />

      {/* ⑤ 단위 */}
      <div style={{ flexShrink: 0, width: 50 }}>
        <input value={it.unit} onChange={e => updateItem(idx, { unit: e.target.value })}
          placeholder="단위" style={row_inp(50)} />
      </div>

      {/* ⑥ 수량 */}
      <div style={{ flexShrink: 0, width: 68 }}>
        <NumericInput value={it.quantity} onChange={v => updateItem(idx, { quantity: v })} placeholder="1" />
      </div>

      {/* ⑦ 단가 */}
      <div style={{ flexShrink: 0, width: 96 }}>
        <NumericInput value={it.unitPrice} onChange={v => updateItem(idx, { unitPrice: v })} placeholder="0" suffix="원" />
      </div>

      {/* ⑧ 공급가액 */}
      <div style={{ flexShrink: 0, width: 86, textAlign: 'right', fontWeight: 600, color: supply > 0 ? '#1e3a5f' : '#d1d5db', fontSize: 12, whiteSpace: 'nowrap' }}>
        {supply > 0 ? supply.toLocaleString() + '원' : '—'}
      </div>
    </div>
  );
}

// ─── 상단 섹션 스타일 ─────────────────────────────────────────────────────────

const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none' };
const lbl = (txt: string, required = false) => (
  <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>
    {txt}{required && <span style={{ color: '#e11d48', marginLeft: 2 }}>*</span>}
  </label>
);
const sectionTitle = (letter: string, bg: string, color: string, text: string, hint?: string): React.ReactNode => (
  <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.06em', paddingBottom: 8, borderBottom: '1.5px solid #e5e7eb', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
    <span style={{ width: 20, height: 20, borderRadius: 6, background: bg, color, fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{letter}</span>
    {text}
    {hint && <span style={{ fontSize: 10, fontWeight: 400, color: '#9ca3af', marginLeft: 4 }}>{hint}</span>}
  </div>
);

// ─── 메인 Props ───────────────────────────────────────────────────────────────

export interface QuoteEditorWorkspaceProps {
  token:             string;
  projectId:         number | null;
  initialCompanyId?: number | null;
  initialContactId?: number | null;
  initialTitle?:     string;
  onClose:           () => void;
  onSaved:           (result: { quoteId: number; projectId: number | null }) => void;
  onToast:           (msg: string) => void;
  adminList?:        AdminUser[];
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────────

export function QuoteEditorWorkspace({
  token, projectId, initialCompanyId = null, initialContactId = null, initialTitle = '',
  onClose, onSaved, onToast, adminList = [],
}: QuoteEditorWorkspaceProps) {

  const authH = { Authorization: `Bearer ${token}` };

  // ── 생성 방식 ──────────────────────────────────────────────────────────────
  const [creationMode, setCreationMode] = useState<CreationMode>('direct');

  // ── 기본 정보 ──────────────────────────────────────────────────────────────
  const [title,         setTitle]        = useState(initialTitle);
  const [titleEdited,   setTitleEdited]  = useState(!!initialTitle);
  const [companyId,     setCompanyId]    = useState<number | null>(initialCompanyId);
  const [contactId,     setContactId]    = useState<number | null>(initialContactId);
  const [adminId,       setAdminId]      = useState<number | null>(null);
  const [issueDate,     setIssueDate]    = useState(() => dateOffset(0));
  const [quoteType,     setQuoteType]    = useState<QuoteType>('b2b_standard');
  const [vatType,       setVatType]      = useState<VatType>('taxable');
  const [note,          setNote]         = useState('');
  const [versionReason, setVersionReason] = useState('');

  // ── 견적 항목 ──────────────────────────────────────────────────────────────
  const [items, setItems] = useState<QuoteItemForm[]>([defaultItem()]);

  // ── 참조 데이터 ────────────────────────────────────────────────────────────
  const [companies, setCompanies] = useState<Company[]>([]);
  const [contacts,  setContacts]  = useState<Contact[]>([]);
  const [products,  setProducts]  = useState<Product[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [saving,    setSaving]    = useState(false);

  // ── 데이터 로딩 ────────────────────────────────────────────────────────────
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

  // ── 견적서명 자동생성 ───────────────────────────────────────────────────────
  useEffect(() => {
    if (titleEdited || projectId !== null) return;
    const company = companies.find(c => c.id === companyId);
    const validItems = items.filter(it => it.productName.trim());
    if (!company || validItems.length === 0) return;
    setTitle(`${company.name}_${validItems[0].productName.trim()}_${issueDate.replace(/-/g, '')}`);
  }, [companyId, items, issueDate, companies, titleEdited, projectId]);

  const handleCompanyChange = (cid: number | null) => { setCompanyId(cid); setContactId(null); setTitleEdited(false); };

  const isStandalone   = projectId === null;
  const companyOptions = companies.map(c => ({ id: c.id, label: c.name, sub: c.divisionNames?.slice(0, 2).join(' · ') }));
  const contactOptions = (contactId !== null || companyId === null ? contacts : contacts.filter(c => c.companyId === companyId)).map(c => ({ id: c.id, label: c.name }));
  const adminOptions   = adminList.map(u => ({ id: u.id, label: u.name ?? u.email }));

  // ── 항목 조작 ──────────────────────────────────────────────────────────────
  const updateItem   = (idx: number, patch: Partial<QuoteItemForm>) => setItems(prev => prev.map((it, i) => i === idx ? { ...it, ...patch } : it));
  const addItemBelow = (idx: number) => setItems(prev => [...prev.slice(0, idx + 1), defaultItem(), ...prev.slice(idx + 1)]);
  const removeItem   = (idx: number) => setItems(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);
  const moveItem     = (idx: number, dir: 'up' | 'down') => setItems(prev => {
    const next = [...prev]; const swap = dir === 'up' ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= next.length) return prev;
    [next[idx], next[swap]] = [next[swap], next[idx]]; return next;
  });

  const totals = calcTotals(items, vatType);

  // ── 저장 (Version Engine 유지) ─────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const validItems = items.filter(it => it.productName.trim() && Number(it.unitPrice.replace?.(/,/g, '') || 0) > 0);
    if (validItems.length === 0) { onToast('품목명과 단가를 입력하세요.'); return; }

    const itemsBody = validItems.map(it => toApiItem(it, vatType));

    const commonBody = {
      items: itemsBody,
      quoteType,
      billingType:     'postpaid_per_project',
      taxDocumentType: 'tax_invoice',
      taxCategory:     'normal',
      issueDate,
      validUntil: (() => { const d = new Date(issueDate); d.setDate(d.getDate() + 30); return d.toISOString().split('T')[0]; })(),
      note: note.trim() || undefined,
    };

    setSaving(true);
    try {
      if (projectId === null) {
        const t = title.trim();
        if (!t) { onToast('견적서명을 입력하세요.'); return; }
        const res = await fetch(api('/api/admin/quotes'), {
          method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...commonBody, title: t, companyId: companyId ?? undefined, contactId: contactId ?? undefined, adminId: adminId ?? undefined }),
        });
        const data = await res.json();
        if (!res.ok) { onToast(`견적서 저장 실패: ${data.error}`); return; }
        onToast('견적서가 저장되었습니다.');
        onSaved({ quoteId: data.id, projectId: null });
        return;
      }
      const res = await fetch(api(`/api/admin/projects/${projectId}/quote`), {
        method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...commonBody, title: title.trim() || undefined, versionReason: versionReason.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`견적 저장 실패: ${data.error}`); return; }
      onToast('견적이 저장되었습니다.');
      onSaved({ quoteId: data.id, projectId });
    } catch { onToast('견적 저장 중 오류가 발생했습니다.'); }
    finally { setSaving(false); }
  }, [items, projectId, title, companyId, contactId, adminId, issueDate, quoteType, vatType, note, versionReason, token]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 800, background: '#f1f5f9', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── 헤더 바 ──────────────────────────────────────────────────────────── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '0 24px', height: 56, display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: '#6b7280', fontSize: 13, padding: '4px 0' }}>
          ← 돌아가기
        </button>
        <div style={{ width: 1, height: 20, background: '#e5e7eb' }} />
        <div>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>{isStandalone ? '새 견적서 작성' : '견적 작성'}</span>
          {projectId !== null && <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>프로젝트 #{projectId} — Version Engine</span>}
        </div>

        {/* 생성 방식 토글 */}
        <div style={{ marginLeft: 'auto', marginRight: 'auto', display: 'flex', gap: 4, background: '#f1f5f9', borderRadius: 10, padding: 4 }}>
          <button type="button" disabled title="AI 견적 생성 (준비 중)"
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 18px', borderRadius: 7, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'not-allowed', background: creationMode === 'ai' ? '#6366f1' : 'transparent', color: '#9ca3af', transition: 'all 0.15s' }}>
            🤖 AI 견적 생성
            <span style={{ fontSize: 10, fontWeight: 700, background: '#e0e7ff', color: '#6366f1', borderRadius: 4, padding: '1px 5px' }}>준비 중</span>
          </button>
          <button type="button" onClick={() => setCreationMode('direct')}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 18px', borderRadius: 7, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', background: creationMode === 'direct' ? '#fff' : 'transparent', color: creationMode === 'direct' ? '#111827' : '#6b7280', boxShadow: creationMode === 'direct' ? '0 1px 4px rgba(0,0,0,0.1)' : 'none', transition: 'all 0.15s' }}>
            ✏ 직접 작성
          </button>
        </div>

        {/* 저장 버튼 */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <GhostBtn onClick={onClose} disabled={saving} style={{ fontSize: 13, padding: '7px 16px' }}>취소</GhostBtn>
          <button type="button" onClick={handleSave} disabled={saving}
            style={{ background: saving ? '#93c5fd' : '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
            {saving ? '저장 중…' : '💾 견적 저장'}
          </button>
        </div>
      </div>

      {/* ── 본문 ─────────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 24px 64px' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: '#9ca3af', fontSize: 14 }}>데이터 불러오는 중…</div>
        ) : (
          <div style={{ maxWidth: 1160, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>

            {/* ── A. 기본정보 ──────────────────────────────────────────────────── */}
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '18px 22px' }}>
              {sectionTitle('A', '#eff6ff', '#2563eb', '기본정보')}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px 20px' }}>

                <div>
                  {lbl('견적서 유형')}
                  <ClickSelect value={quoteType} onChange={v => setQuoteType(v as QuoteType)}
                    triggerStyle={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', width: '100%' }}
                    options={[
                      { value: 'b2b_standard',     label: '일반 견적서',  sub: '일반 B2B 프로젝트' },
                      { value: 'b2c_prepaid',       label: '차감 견적서', sub: '선입금 잔액 차감' },
                      { value: 'accumulated_batch', label: '누적 견적서', sub: '월별 누적 청구' },
                    ]} />
                </div>

                <div>
                  {lbl('견적일')}
                  <input type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} style={{ ...inp }} />
                </div>

                <div>
                  {lbl('부가세')}
                  <ClickSelect value={vatType} onChange={v => setVatType(v as VatType)}
                    triggerStyle={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', width: '100%' }}
                    options={[
                      { value: 'taxable',   label: '부가세 10%' },
                      { value: 'exempt',    label: '면세' },
                      { value: 'zero_rate', label: '영세율' },
                    ]} />
                </div>

                {isStandalone && (
                  <div style={{ gridColumn: 'span 3' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      {lbl('견적서명', true)}
                      {!titleEdited && title && <span style={{ fontSize: 10, color: '#6b7280', fontStyle: 'italic', marginBottom: 4 }}>자동생성됨</span>}
                    </div>
                    <input value={title} onChange={e => { setTitle(e.target.value); setTitleEdited(true); }} placeholder="예: 삼성전자_한영동시통역_20260715" style={{ ...inp }} />
                  </div>
                )}

                {isStandalone && (
                  <div>
                    {lbl('거래처')}
                    <InlineSearchField items={companyOptions} value={companyId} onChange={handleCompanyChange} placeholder="거래처 검색…" popupTitle="거래처 검색" />
                  </div>
                )}

                {isStandalone && (
                  <div>
                    {lbl('담당자')}
                    <InlineSearchField items={contactOptions} value={contactId} onChange={setContactId} placeholder="담당자 검색…" popupTitle="담당자 검색" />
                  </div>
                )}

                <div>
                  {lbl('담당 PM')}
                  <InlineSearchField items={adminOptions} value={adminId} onChange={setAdminId} placeholder="PM 검색 (선택)" popupTitle="담당 PM 검색" />
                </div>
              </div>
            </div>

            {/* ── B. 상품정보 ──────────────────────────────────────────────────── */}
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '18px 22px' }}>
              {sectionTitle('B', '#f0fdf4', '#16a34a', '상품정보', '← 유형 클릭으로 번역 / 통역 / 장비 / 기타 전환 | − 삭제 + 추가 ▲▼ 이동')}

              {/* 컬럼 헤더 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 8px 4px', borderBottom: '1.5px solid #e5e7eb', marginBottom: 2 }}>
                <div style={{ width: 90, flexShrink: 0, fontSize: 10, fontWeight: 700, color: '#9ca3af' }}>행 제어</div>
                <div style={{ width: 56, flexShrink: 0, fontSize: 10, fontWeight: 700, color: '#9ca3af' }}>유형</div>
                <div style={{ width: 158, flexShrink: 0, fontSize: 10, fontWeight: 700, color: '#9ca3af' }}>상품 🔍🧽</div>
                <div style={{ flex: 1, fontSize: 10, fontWeight: 700, color: '#9ca3af', minWidth: 0 }}>
                  {/* 행별로 다른 필드가 표시됨 */}
                  {items.length === 1 ? SVC_HINTS[items[0].productType] : '서비스별 입력 필드'}
                </div>
                <div style={{ width: 50, flexShrink: 0, fontSize: 10, fontWeight: 700, color: '#9ca3af', textAlign: 'center' }}>단위</div>
                <div style={{ width: 68, flexShrink: 0, fontSize: 10, fontWeight: 700, color: '#9ca3af', textAlign: 'center' }}>수량</div>
                <div style={{ width: 96, flexShrink: 0, fontSize: 10, fontWeight: 700, color: '#9ca3af', textAlign: 'center' }}>단가</div>
                <div style={{ width: 86, flexShrink: 0, fontSize: 10, fontWeight: 700, color: '#9ca3af', textAlign: 'right' }}>공급가액</div>
              </div>

              {/* 항목 행 목록 */}
              <div>
                {items.map((it, idx) => (
                  <QuoteItemRow key={idx}
                    it={it} idx={idx} total={items.length} vatType={vatType} products={products}
                    updateItem={updateItem} removeItem={removeItem}
                    addItemBelow={addItemBelow} moveItem={moveItem}
                  />
                ))}
              </div>

              {/* 항목 추가 버튼 */}
              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                {(['translation', 'interpretation', 'equipment', 'expense'] as ServiceType[]).map(type => {
                  const c = SVC_CFG[type];
                  return (
                    <button key={type} type="button"
                      onClick={() => setItems(prev => [...prev, { ...defaultItem(), ...defaultItemForType(type) }])}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: c.color, background: c.bg, border: `1px dashed ${c.border}`, borderRadius: 7, padding: '5px 12px', cursor: 'pointer', fontWeight: 600, transition: 'opacity 0.1s' }}
                      onMouseEnter={e => (e.currentTarget.style.opacity = '0.75')}
                      onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                    >
                      + {c.label} 항목
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── C. 금액 요약 ─────────────────────────────────────────────────── */}
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '16px 22px' }}>
              {sectionTitle('C', '#fffbeb', '#d97706', '금액 요약')}

              {/* 서비스 유형별 소계 */}
              {(() => {
                const groups = (['translation', 'interpretation', 'equipment', 'expense'] as ServiceType[])
                  .map(type => {
                    const typeItems = items.filter(it => it.productType === type);
                    if (typeItems.length === 0) return null;
                    const sub = calcTotals(typeItems, vatType);
                    const cfg = SVC_CFG[type];
                    return sub.supply > 0 ? (
                      <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 7 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: cfg.color }}>{cfg.label}</span>
                        <span style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>{sub.supply.toLocaleString()}원</span>
                      </div>
                    ) : null;
                  }).filter(Boolean);
                return groups.length > 1 ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>{groups}</div>
                ) : null;
              })()}

              <div style={{ display: 'flex', gap: 16, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ textAlign: 'right', padding: '8px 14px', borderRadius: 8, background: '#f8fafc' }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>공급가액</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#374151' }}>{totals.supply.toLocaleString()}원</div>
                </div>
                <div style={{ textAlign: 'right', padding: '8px 14px', borderRadius: 8, background: '#f8fafc' }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>부가세</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#374151' }}>{totals.tax.toLocaleString()}원</div>
                </div>
                <div style={{ textAlign: 'right', padding: '10px 18px', borderRadius: 10, background: '#eff6ff', border: '1.5px solid #bfdbfe' }}>
                  <div style={{ fontSize: 11, color: '#2563eb', fontWeight: 700, marginBottom: 2 }}>총 견적금액</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#1d4ed8' }}>{totals.total.toLocaleString()}원</div>
                </div>
              </div>
            </div>

            {/* ── D. 비고 / 버전 사유 ─────────────────────────────────────────── */}
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {sectionTitle('D', '#f5f3ff', '#7c3aed', '비고 / 기타')}
              <div>
                {lbl('비고')}
                <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="견적 관련 메모 또는 안내 사항" rows={2}
                  style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }} />
              </div>
              {projectId !== null && (
                <div style={{ background: '#fffbeb', borderRadius: 10, padding: '12px 16px', border: '1px solid #fde68a' }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: '#92400e', display: 'block', marginBottom: 6 }}>
                    버전 변경 사유
                    <span style={{ marginLeft: 6, fontWeight: 400, color: '#b45309' }}>— 저장 시 새 Version으로 기록됩니다</span>
                  </label>
                  <input value={versionReason} onChange={e => setVersionReason(e.target.value)}
                    placeholder="예: 최초 견적 / 일정 변경 / 금액 수정 / 고객 요청"
                    style={{ ...inp, background: '#fff' }} />
                </div>
              )}
            </div>

            {/* ── 하단 저장 버튼 ───────────────────────────────────────────────── */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <GhostBtn onClick={onClose} disabled={saving} style={{ fontSize: 14, padding: '10px 22px' }}>취소</GhostBtn>
              <button type="button" onClick={handleSave} disabled={saving}
                style={{ background: saving ? '#93c5fd' : '#2563eb', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 28px', fontSize: 14, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>
                {saving ? '저장 중…' : (isStandalone ? '💾 견적서 저장 (프로젝트 생성)' : '💾 견적 저장')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
