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
import { Card, GhostBtn, PrimaryBtn, ClickSelect, NumericInput } from '../ui';
import {
  getPolicy, getActivePolicies, validateCounts, calcPagesFromStr,
  type ValidationResult,
} from '../../lib/languagePagePolicy';

// ─── 타입 ─────────────────────────────────────────────────────────────────────

type QuoteType    = 'b2b_standard' | 'b2c_prepaid' | 'accumulated_batch';
type VatType      = 'taxable' | 'exempt' | 'zero_rate';
type CreationMode = 'direct' | 'ai';
type ServiceType  = 'translation' | 'interpretation' | 'equipment' | 'expense';

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
  interpretPlace:   string;
  interpreterCount: string;  // 투입 인원
  // 장비 전용
  eventStartDate: string;
  itemLocation:   string;
  usagePeriod:    string;
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
const SVC_DEFAULT_UNIT: Record<ServiceType, string> = {
  translation: '페이지', interpretation: '일', equipment: '세트', expense: '건',
};
const SVC_UNITS: Record<ServiceType, string[]> = {
  translation:    ['페이지', '단어', '글자', '건', '개'],
  interpretation: ['일', '시간', '회', '건'],
  equipment:      ['세트', '개', '일', '회', '건'],
  expense:        ['건', '개', '회', '일'],
};
function getUnitOptions(serviceType: ServiceType, v: string): string[] {
  const list = SVC_UNITS[serviceType];
  return list.includes(v) || !v ? list : [v, ...list];
}

// ─── 계산 ─────────────────────────────────────────────────────────────────────

function calcItem(it: QuoteItemForm, vat: VatType) {
  const p   = Number(it.unitPrice.replace?.(/,/g, '') || 0);
  const q   = Number(it.quantity || 1);
  // 통역: 투입인원 × 수량 × 단가(1인 기준). 인원 미입력 시 1명으로 계산
  const cnt = it.productType === 'interpretation' ? (Number(it.interpreterCount) || 1) : 1;
  const s   = Math.round(cnt * q * p);
  return { supply: s, tax: vat === 'taxable' ? Math.round(s * 0.1) : 0, total: s + (vat === 'taxable' ? Math.round(s * 0.1) : 0) };
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
    interpretDate: '', interpretEndDate: '', startTime: '', endTime: '', interpretPlace: '', interpreterCount: '',
    eventStartDate: '', itemLocation: '', usagePeriod: '',
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
      return { ...base, memo: [it.memo, ref].filter(Boolean).join(' / ') || undefined };
    }
    case 'interpretation': {
      const cnt      = Number(it.interpreterCount) || 1;
      const dur      = [it.startTime, it.endTime].filter(Boolean).join('~');
      const countTag = it.interpreterCount ? `투입인원: ${it.interpreterCount}명` : '';
      const memo     = [countTag, it.memo].filter(Boolean).join(' / ');
      return {
        ...base,
        // 서버측 공급가액(quantity × unitPrice) 정합성 유지: 투입인원 × 수량을 quantity로 전송
        quantity:          cnt * (Number(it.quantity) || 1),
        interpretDate:     it.interpretDate     || undefined,
        interpretPlace:    it.interpretPlace    || undefined,
        interpretDuration: dur                  || undefined,
        eventEndDate:      it.interpretEndDate  || undefined,
        memo:              memo                 || undefined,
      };
    }
    case 'equipment':
      return { ...base, eventStartDate: it.eventStartDate || undefined, itemLocation: it.itemLocation || undefined, usagePeriod: it.usagePeriod || undefined, memo: it.memo || undefined };
    default:
      return { ...base, memo: it.memo || undefined };
  }
}

// ─── 공통 인풋 스타일 ─────────────────────────────────────────────────────────

const rinp = (w: number | string = '100%', x: React.CSSProperties = {}): React.CSSProperties => ({
  width: typeof w === 'number' ? w : w, boxSizing: 'border-box', border: '1px solid #d1d5db',
  borderRadius: 6, padding: '5px 7px', fontSize: 13, outline: 'none', minWidth: 0, background: '#fff', ...x,
});
const sep_s: React.CSSProperties = { flexShrink: 0, fontSize: 11, color: '#9ca3af', userSelect: 'none' };

// ─── 상품정보 Table Grid 정의 ─────────────────────────────────────────────────
// Header와 모든 Body Row가 동일한 grid-template-columns를 공유 → 컬럼 폭 변경 시 1곳만 수정
const TABLE_COLS = '82px 60px 170px 1fr 28px 72px 64px 112px 112px minmax(130px, 220px)';
const tblRow: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: TABLE_COLS,
  columnGap: 5, padding: '4px 8px', alignItems: 'center',
};

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
          {value !== null && <div onClick={() => { onSelect(null); onClose(); }} style={{ padding: '10px 18px', fontSize: 13, color: '#9ca3af', cursor: 'pointer', borderBottom: '1px solid #f8f9fa' }} onMouseEnter={e => (e.currentTarget.style.background = '#f8f9fa')} onMouseLeave={e => (e.currentTarget.style.background = '')}>선택 해제</div>}
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

// ─── 인라인 검색 필드 ─────────────────────────────────────────────────────────

function InlineSearchField({ items, value, onChange, placeholder = '검색…', popupTitle = '검색', accentColor = '#6366f1', compact = false }: {
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
      <div ref={ref} style={{ position: 'relative', display: 'flex', alignItems: 'center', border: `1px solid ${open ? accentColor : '#d1d5db'}`, borderRadius: 7, background: '#fff', minWidth: 0, flex: 1, transition: 'border-color 0.12s' }}>
        <input value={open ? q : (selected?.label ?? '')} onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => { setOpen(true); if (selected) setQ(''); }} placeholder={placeholder}
          style={{ flex: 1, minWidth: 0, padding: pad, fontSize: fs, border: 'none', outline: 'none', background: 'transparent', color: selected && !open ? '#111827' : undefined }} />
        <button type="button" title="전체 검색" onClick={() => { setOpen(false); setShowPopup(true); }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', fontSize: 12, color: '#6366f1', flexShrink: 0 }}>🔍</button>
        {value !== null && <button type="button" title="초기화" onClick={() => { onChange(null); setQ(''); setOpen(false); }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', fontSize: 12, color: '#9ca3af', flexShrink: 0 }}>🧽</button>}
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
    cursor: dis ? 'default' : 'pointer', fontSize: 11, lineHeight: 1,
    padding: '3px 6px', color: dis ? '#d1d5db' : '#6b7280',
  });
  const hov = (el: HTMLButtonElement, c: string) => { el.style.background = c; };
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center', justifyContent: 'center' }}>
      <button type="button" title="행 삭제" onClick={() => onRemove(idx)} disabled={total <= 1}
        style={{ ...btn(total <= 1), color: total > 1 ? '#e11d48' : '#d1d5db', borderColor: total > 1 ? '#fca5a5' : '#e5e7eb' }}
        onMouseEnter={e => { if (total > 1) hov(e.currentTarget, '#fef2f2'); }} onMouseLeave={e => hov(e.currentTarget, 'none')}>−</button>
      <button type="button" title="아래 행 추가" onClick={() => onAddBelow(idx)} style={{ ...btn(false), color: '#2563eb', borderColor: '#bfdbfe' }}
        onMouseEnter={e => hov(e.currentTarget, '#eff6ff')} onMouseLeave={e => hov(e.currentTarget, 'none')}>+</button>
      <button type="button" title="위로 이동" onClick={() => onMoveUp(idx)} disabled={idx === 0} style={btn(idx === 0)}
        onMouseEnter={e => { if (idx > 0) hov(e.currentTarget, '#f3f4f6'); }} onMouseLeave={e => hov(e.currentTarget, 'none')}>▲</button>
      <button type="button" title="아래로 이동" onClick={() => onMoveDown(idx)} disabled={idx === total - 1} style={btn(idx === total - 1)}
        onMouseEnter={e => { if (idx < total - 1) hov(e.currentTarget, '#f3f4f6'); }} onMouseLeave={e => hov(e.currentTarget, 'none')}>▼</button>
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
        <div style={{ position: 'absolute', top: 'calc(100% + 2px)', left: 0, zIndex: 800, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9, boxShadow: '0 4px 20px rgba(0,0,0,0.12)', padding: 4, minWidth: 74 }}>
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
        style={{ width: '100%', height: 32, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, border: `1px solid ${open ? '#6366f1' : '#d1d5db'}`, borderRadius: 6, padding: '0 7px', fontSize: 13, background: '#fff', color: value ? '#111827' : '#9ca3af', cursor: 'pointer', outline: 'none' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value || '단위'}</span>
        <span style={{ fontSize: 8, color: '#9ca3af', flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 2px)', left: 0, zIndex: 900, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', minWidth: 72, padding: 4 }}>
          {opts.map(u => (
            <button key={u} type="button" onClick={() => { onChange(u); setOpen(false); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 9px', fontSize: 13, border: 'none', borderRadius: 6, cursor: 'pointer', background: value === u ? '#eff6ff' : 'none', color: value === u ? '#1d4ed8' : '#111827', fontWeight: value === u ? 700 : 400 }}
              onMouseEnter={e => { if (value !== u) (e.currentTarget as HTMLButtonElement).style.background = '#f8fafc'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = value === u ? '#eff6ff' : 'none'; }}>
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
function CountInput({ value, onChange, unit, placeholder, style }: {
  value:        string;
  onChange:     (raw: string) => void;
  unit:         string;
  placeholder?: string;
  style?:       React.CSSProperties;
}) {
  const [focused, setFocused] = useState(false);
  const num = Number(value.replace?.(/,/g, '') || 0);
  const displayVal = focused
    ? value
    : (value ? `${num.toLocaleString()}${unit}` : '');
  return (
    <input
      value={displayVal}
      onChange={e => onChange(e.target.value.replace(/[^\d]/g, ''))}
      onFocus={e => { setFocused(true); e.target.select(); }}
      onBlur={() => setFocused(false)}
      placeholder={placeholder}
      style={style}
    />
  );
}

// ─── 언어 선택 — Popover 기반 커스텀 드롭다운 ──────────────────────────────────
// native <select>는 blur 이벤트로 즉시 닫혀 캡처·검수 불가.
// mousedown 기반으로만 닫기 → 스크린샷/포커스 이동 시 목록 유지.

function LangSelect({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref             = useRef<HTMLDivElement>(null);
  const active          = getActivePolicies();
  const selected        = active.find(p => p.languageCode === value);

  useEffect(() => {
    if (!open) return;
    // mousedown만 감지 — blur/focusout 은 감지하지 않아 캡처·포커스 이동 시 안 닫힘
    const onMD = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onMD);
    document.addEventListener('keydown',   onKey);
    return () => {
      document.removeEventListener('mousedown', onMD);
      document.removeEventListener('keydown',   onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0, width: 110 }}>
      {/* 트리거 버튼 */}
      <button type="button" onClick={() => setOpen(v => !v)}
        style={{ width: '100%', height: 32, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, border: `1px solid ${open ? '#6366f1' : '#d1d5db'}`, borderRadius: 6, padding: '0 7px', fontSize: 12, background: value ? '#fff' : '#f9fafb', color: value ? '#111827' : '#9ca3af', cursor: 'pointer', outline: 'none' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'left' }}>
          {selected?.languageName ?? '언어'}
        </span>
        <span style={{ fontSize: 8, flexShrink: 0, color: '#9ca3af' }}>{open ? '▲' : '▼'}</span>
      </button>

      {/* 팝오버 목록 — mousedown 외부 클릭 시만 닫힘 */}
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 3px)', left: 0, zIndex: 900, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', minWidth: 180, padding: 4, maxHeight: 300, overflowY: 'auto' }}>
          {/* 선택 해제 */}
          {value && (
            <button type="button" onClick={() => { onChange(''); setOpen(false); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 9px', fontSize: 11, color: '#9ca3af', background: 'none', border: 'none', borderRadius: 6, cursor: 'pointer', marginBottom: 2, whiteSpace: 'nowrap' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
              선택 해제
            </button>
          )}
          {active.map(p => (
            <button key={p.languageCode} type="button"
              onClick={() => { onChange(p.languageCode); setOpen(false); }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', padding: '5px 9px', fontSize: 12, border: 'none', borderRadius: 6, cursor: 'pointer', background: value === p.languageCode ? '#eff6ff' : 'none', color: value === p.languageCode ? '#1d4ed8' : '#111827', fontWeight: value === p.languageCode ? 700 : 400, whiteSpace: 'nowrap' }}
              onMouseEnter={e => { if (value !== p.languageCode) (e.currentTarget as HTMLButtonElement).style.background = '#f8fafc'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = value === p.languageCode ? '#eff6ff' : 'none'; }}>
              <span style={{ fontSize: 9, color: '#9ca3af', flexShrink: 0 }}>{p.calcType === 'character' ? '글자' : '단어'}</span>
              {p.languageName}
            </button>
          ))}
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
      const policy = getPolicy(it.sourceLanguage);

      // 선택된 상품의 언어 정보 → 있으면 읽기 전용 표시, 없으면 수동 선택
      const product       = it.productId !== null ? products.find(p => p.id === it.productId) ?? null : null;
      const langFromProd  = !!product?.sourceLanguage;
      const langLabel     = getPolicy(it.sourceLanguage)?.languageName ?? it.sourceLanguage;

      // 언어 변경 → 해당 언어 기준으로 수량·단위 자동 재계산
      const handleLangChange = (code: string) => {
        const p = getPolicy(code);
        const upd: Partial<QuoteItemForm> = { sourceLanguage: code };
        if (p?.active) {
          const src = p.calcType === 'character' ? it.charCount : it.wordCount;
          if (src) {
            const n = calcPagesFromStr(src, p.standardValue);
            if (n !== null) { upd.quantity = String(n); upd.unit = '페이지'; }
          }
        }
        update(upd);
      };

      // 글자수 변경: char 기준 언어 or 언어 미지정(기본 700글자/페이지) → 수량 갱신
      const handleCharChange = (v: string) => {
        const upd: Partial<QuoteItemForm> = { charCount: v };
        if (v) {
          const std = (policy?.calcType === 'character' || !policy)
            ? (policy?.standardValue ?? 700)
            : null;
          if (std) {
            const n = calcPagesFromStr(v, std);
            if (n !== null) { upd.quantity = String(n); upd.unit = '페이지'; }
          }
        }
        update(upd);
      };

      // 단어수 변경: word 기준 언어 → 수량 갱신
      const handleWordChange = (v: string) => {
        const upd: Partial<QuoteItemForm> = { wordCount: v };
        if (v && policy?.calcType === 'word') {
          const n = calcPagesFromStr(v, policy.standardValue);
          if (n !== null) { upd.quantity = String(n); upd.unit = '페이지'; }
        }
        update(upd);
      };

      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {/* 언어: 상품에 언어 정보 있으면 읽기 전용 배지 / 없으면 수동 선택 */}
          {langFromProd ? (
            <div style={{ flexShrink: 0, width: 110, height: 32, display: 'flex', alignItems: 'center',
              background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6,
              padding: '0 8px', fontSize: 12, fontWeight: 600, color: '#1d4ed8',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={`상품에서 자동 설정: ${langLabel}`}>
              {langLabel}
            </div>
          ) : (
            <LangSelect value={it.sourceLanguage} onChange={handleLangChange} />
          )}
          {/* 파일명 */}
          <input value={it.fileName} onChange={e => update({ fileName: e.target.value })}
            placeholder="파일명" style={{ ...rinp('auto'), flex: 1, minWidth: 70 }} title="원본 파일명" />
          {/* 파일형식 */}
          <input value={it.fileFormat} onChange={e => update({ fileFormat: e.target.value })}
            placeholder="형식" style={rinp(54)} title="파일 형식 (예: docx, pdf)" />
          {/* 단어수 — 천 단위 콤마 + "단어". word 기준 언어 시 수량 자동 갱신 */}
          <CountInput value={it.wordCount} onChange={handleWordChange}
            unit="단어" placeholder="단어수" style={rinp(88)} />
          {/* 글자수 — 천 단위 콤마 + "글자". char 기준 언어 시 수량 자동 갱신 */}
          <CountInput value={it.charCount} onChange={handleCharChange}
            unit="글자" placeholder="글자수" style={rinp(88, { color: '#374151' })} />
        </div>
      );
    }
    case 'interpretation':
      return (
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
          {/* 날짜 / 시간 구분선 */}
          <span style={{ ...sep_s, color: '#d1d5db', fontSize: 15, flexShrink: 0 }}>|</span>
          {/* 시작시간 */}
          <input value={it.startTime}
            onChange={e => update({ startTime: e.target.value })}
            placeholder="시작시간" style={{ ...rinp(62), flexShrink: 0 }} title="시작 시간 (예: 09:00)" />
          <span style={sep_s}>~</span>
          {/* 종료시간 */}
          <input value={it.endTime}
            onChange={e => update({ endTime: e.target.value })}
            placeholder="종료시간" style={{ ...rinp(62), flexShrink: 0 }} title="종료 시간 (예: 18:00)" />
          {/* 장소 */}
          <input value={it.interpretPlace}
            onChange={e => update({ interpretPlace: e.target.value })}
            placeholder="장소" style={{ ...rinp('auto'), flex: 1, minWidth: 50 }} title="행사 장소" />
          {/* 투입 인원 */}
          <input value={it.interpreterCount}
            onChange={e => update({ interpreterCount: e.target.value.replace(/[^\d]/g, '') })}
            placeholder="인원" style={{ ...rinp(46), flexShrink: 0 }} title="투입 통역사 인원 수 (예: 2)" />
          <span style={{ ...sep_s, flexShrink: 0 }}>명</span>
        </div>
      );
    case 'equipment':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="date" value={it.eventStartDate} onChange={e => update({ eventStartDate: e.target.value })} style={rinp(98)} title="장비 사용일" />
          <input value={it.itemLocation} onChange={e => update({ itemLocation: e.target.value })} placeholder="사용 장소" style={{ ...rinp('auto'), flex: 1, minWidth: 80 }} title="장비 사용 장소" />
          <input value={it.usagePeriod} onChange={e => update({ usagePeriod: e.target.value })} placeholder="사용기간" style={rinp(68)} title="사용 기간 (예: 1일, 반일)" />
        </div>
      );
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
      unit: p?.unit ?? SVC_DEFAULT_UNIT[productType],
      ...(productType === 'translation' && p?.sourceLanguage
        ? { sourceLanguage: p.sourceLanguage }
        : {}),
    });
  };

  return (
    <>
      <div style={{ ...tblRow, borderBottom: '1px solid #f0f2f5', minHeight: 42, transition: 'background 0.1s' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#fafcff')} onMouseLeave={e => (e.currentTarget.style.background = '')}>

        {/* ① 행 제어 */}
        <div>
          <RowControls idx={idx} total={total} onRemove={removeItem} onAddBelow={addItemBelow}
            onMoveUp={i => moveItem(i, 'up')} onMoveDown={i => moveItem(i, 'down')} />
        </div>

        {/* ② 유형 */}
        <div>
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
            <span style={{ color: '#16a34a', fontSize: 12, fontWeight: 800, lineHeight: 1 }}
              title="AI 교차검증 완료 — 글자수·단어수 비율 정상">✓</span>
          )}
          {validation?.status === 'warning' && (
            <button type="button" onClick={() => setShowWarning(v => !v)}
              style={{
                background: showWarning ? (validation.severity === 'danger' ? '#fee2e2' : '#fef3c7') : 'none',
                border: 'none', cursor: 'pointer',
                color: validation.severity === 'danger' ? '#dc2626' : '#d97706',
                fontSize: 13, fontWeight: 800, padding: '1px 3px', borderRadius: 4, lineHeight: 1,
              }}
              title={`AI 교차검증: ${validation.message}`}>
              {validation.severity === 'danger' ? '✕' : '⚠'}
            </button>
          )}
        </div>

        {/* ⑥ 수량 */}
        <div>
          <NumericInput value={it.quantity} onChange={v => updateItem(idx, { quantity: v })} placeholder="1"
            style={rinp()} />
        </div>

        {/* ⑦ 단위 */}
        <div>
          <UnitSelect value={it.unit} onChange={v => updateItem(idx, { unit: v })} serviceType={it.productType} />
        </div>

        {/* ⑧ 단가 — 통역은 1인 기준 단가 */}
        <div title={it.productType === 'interpretation' ? '통역사 1인 기준 단가 (공급가액 = 투입인원 × 수량 × 단가)' : undefined}>
          <NumericInput value={it.unitPrice} onChange={v => updateItem(idx, { unitPrice: v })}
            placeholder={it.productType === 'interpretation' ? '1인 기준' : '0'} suffix="원"
            style={rinp()} />
        </div>

        {/* ⑨ 공급가액 */}
        <div style={{ textAlign: 'right', fontWeight: 600, color: supply > 0 ? '#1e3a5f' : '#d1d5db', fontSize: 13, whiteSpace: 'nowrap' }}>
          {supply > 0 ? supply.toLocaleString() + '원' : '—'}
        </div>

        {/* ⑩ 비고 */}
        <div>
          <input value={it.memo} onChange={e => updateItem(idx, { memo: e.target.value })}
            placeholder="비고 (긴급, 감수 포함, 출장비 별도 등)"
            style={{ ...rinp('100%'), color: '#6b7280' }}
            title="긴급, 감수 포함, DTP 포함, 출장비 별도, 장비 설치 포함 등" />
        </div>
      </div>

      {/* AI 경고 패널 — ⚠ 클릭 시 토글 */}
      {showWarning && validation?.status === 'warning' && (
        <div style={{
          background: validation.severity === 'danger' ? '#fff5f5' : '#fffbeb',
          border: `1px solid ${validation.severity === 'danger' ? '#fca5a5' : '#fde68a'}`,
          borderTop: 'none', borderRadius: '0 0 8px 8px', padding: '10px 16px', marginBottom: 2,
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: validation.severity === 'danger' ? '#991b1b' : '#92400e', marginBottom: 4 }}>
                {validation.severity === 'danger' ? '✕ 위험' : '⚠ 주의'} — AI 문서 검증 결과
              </div>
              {validation.detail && (
                <div style={{ fontSize: 11, color: validation.severity === 'danger' ? '#7f1d1d' : '#78350f', marginBottom: 6 }}>
                  {validation.detail.basis === 'character' ? '예상 단어수' : '예상 글자수'}:&nbsp;
                  <strong>{validation.detail.expectedVal.toLocaleString()}</strong>
                  &nbsp;/ 실제: <strong>{validation.detail.actualVal.toLocaleString()}</strong>
                  &nbsp;— 오차 <strong>{validation.detail.deviationPct.toFixed(0)}%</strong>
                </div>
              )}
              <div style={{ fontSize: 11, color: validation.severity === 'danger' ? '#991b1b' : '#92400e', lineHeight: 1.6 }}>
                <strong>예상 원인:</strong> {validation.causes?.join(' · ')}
              </div>
              <div style={{ fontSize: 11, color: validation.severity === 'danger' ? '#7f1d1d' : '#78350f', marginTop: 4 }}>
                내용을 확인한 후 견적을 진행해 주세요. PM이 수량을 직접 수정하면 해당 값이 우선 적용됩니다.
              </div>
            </div>
            <button onClick={() => setShowWarning(false)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: validation.severity === 'danger' ? '#991b1b' : '#92400e', flexShrink: 0, padding: '0 4px' }}>×</button>
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
    <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.06em', paddingBottom: 10, borderBottom: '1.5px solid #e5e7eb', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 20, height: 20, borderRadius: 6, background: badgeBg, color: badgeColor, fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{badge}</span>
      {title}
      {hint && <span style={{ fontSize: 10, fontWeight: 400, color: '#9ca3af', marginLeft: 4 }}>{hint}</span>}
    </div>
  );
}

// ─── 컬럼 헤더 레이블 스타일 ─────────────────────────────────────────────────

const COL_H: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#6b7280', textAlign: 'center' };

const SVC_FIELD_HINTS: Record<ServiceType, string> = {
  translation:    '언어 / 파일명 / 형식 / 단어수 / 글자수',
  interpretation: '시작일 ~ 종료일 / 시작시간 ~ 종료시간 / 장소 / 인원',
  equipment:      '사용일 / 사용장소 / 사용기간',
  expense:        '',
};

// ─── Props ────────────────────────────────────────────────────────────────────

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
  /** true: AdminDashboard 스크롤 영역 내 인라인 렌더링 (사이드바 유지) */
  asPage?:           boolean;
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────────

export function QuoteEditorWorkspace({
  token, projectId, initialCompanyId = null, initialContactId = null, initialTitle = '',
  onClose, onSaved, onToast, adminList = [], asPage = false,
}: QuoteEditorWorkspaceProps) {

  const authH = { Authorization: `Bearer ${token}` };
  const [creationMode, setCreationMode] = useState<CreationMode>('direct');
  const [title,          setTitle]         = useState(initialTitle);
  const [titleEdited,    setTitleEdited]   = useState(!!initialTitle);
  const [companyId,      setCompanyId]     = useState<number | null>(initialCompanyId);
  const [contactId,      setContactId]     = useState<number | null>(initialContactId);
  const [adminId,        setAdminId]       = useState<number | null>(null);
  const [issueDate,      setIssueDate]     = useState(() => dateOffset(0));
  const [quoteType,      setQuoteType]     = useState<QuoteType>('b2b_standard');
  const [vatType,        setVatType]       = useState<VatType>('taxable');
  const [note,           setNote]          = useState('');
  const [versionReason,  setVersionReason] = useState('');
  const [items,          setItems]         = useState<QuoteItemForm[]>([defaultItem()]);
  const [companies,      setCompanies]     = useState<Company[]>([]);
  const [contacts,       setContacts]      = useState<Contact[]>([]);
  const [products,       setProducts]      = useState<Product[]>([]);
  const [loading,        setLoading]       = useState(true);
  const [saving,         setSaving]        = useState(false);

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

  useEffect(() => {
    if (titleEdited || projectId !== null) return;
    const co = companies.find(c => c.id === companyId);
    const vi = items.filter(it => it.productName.trim());
    if (!co || vi.length === 0) return;
    setTitle(`${co.name}_${vi[0].productName.trim()}_${issueDate.replace(/-/g, '')}`);
  }, [companyId, items, issueDate, companies, titleEdited, projectId]);

  const handleCompanyChange = (cid: number | null) => { setCompanyId(cid); setContactId(null); setTitleEdited(false); };
  const isStandalone   = projectId === null;
  const companyOptions = companies.map(c => ({ id: c.id, label: c.name, sub: c.divisionNames?.slice(0, 2).join(' · ') }));
  const contactOptions = (contactId !== null || companyId === null ? contacts : contacts.filter(c => c.companyId === companyId)).map(c => ({ id: c.id, label: c.name }));
  const adminOptions   = adminList.map(u => ({ id: u.id, label: u.name ?? u.email }));

  const updateItem   = (idx: number, p: Partial<QuoteItemForm>) => setItems(prev => prev.map((it, i) => i === idx ? { ...it, ...p } : it));
  const addItemBelow = (idx: number) => setItems(prev => [...prev.slice(0, idx + 1), defaultItem(), ...prev.slice(idx + 1)]);
  const removeItem   = (idx: number) => setItems(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);
  const moveItem     = (idx: number, dir: 'up' | 'down') => setItems(prev => {
    const next = [...prev]; const swap = dir === 'up' ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= next.length) return prev;
    [next[idx], next[swap]] = [next[swap], next[idx]]; return next;
  });

  const totals = calcTotals(items, vatType);
  const fieldHint = (() => { const t = [...new Set(items.map(it => it.productType))]; return t.length === 1 ? SVC_FIELD_HINTS[t[0]] : '서비스별 상세 입력 필드'; })();

  const handleSave = useCallback(async () => {
    const vi = items.filter(it => it.productName.trim() && Number(it.unitPrice.replace?.(/,/g, '') || 0) > 0);
    if (vi.length === 0) { onToast('품목명과 단가를 입력하세요.'); return; }
    const itemsBody  = vi.map(it => toApiItem(it, vatType));
    const commonBody = {
      items: itemsBody, quoteType,
      billingType: 'postpaid_per_project', taxDocumentType: 'tax_invoice', taxCategory: 'normal',
      issueDate, validUntil: (() => { const d = new Date(issueDate); d.setDate(d.getDate() + 30); return d.toISOString().split('T')[0]; })(),
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
        onToast('견적서가 저장되었습니다.'); onSaved({ quoteId: data.id, projectId: null }); return;
      }
      const res = await fetch(api(`/api/admin/projects/${projectId}/quote`), {
        method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...commonBody, title: title.trim() || undefined, versionReason: versionReason.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`견적 저장 실패: ${data.error}`); return; }
      onToast('견적이 저장되었습니다.'); onSaved({ quoteId: data.id, projectId });
    } catch { onToast('견적 저장 중 오류가 발생했습니다.'); }
    finally { setSaving(false); }
  }, [items, projectId, title, companyId, contactId, adminId, issueDate, quoteType, vatType, note, versionReason, token]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 공통 Form 컨텐츠 ─────────────────────────────────────────────────────

  const inpSt: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none' };
  const fLbl  = (txt: string, req = false) => (
    <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>
      {txt}{req && <span style={{ color: '#e11d48', marginLeft: 2 }}>*</span>}
    </label>
  );

  const formContent = loading ? (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: '#9ca3af', fontSize: 14 }}>데이터 불러오는 중…</div>
  ) : (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      {/* ── A. 기본정보 ─────────────────────────────────────────────────── */}
      <Card>
        <CardSectionHeader badge="A" badgeBg="#eff6ff" badgeColor="#2563eb" title="기본정보" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px 20px' }}>
          <div>
            {fLbl('견적서 유형')}
            <ClickSelect value={quoteType} onChange={v => setQuoteType(v as QuoteType)}
              triggerStyle={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', width: '100%' }}
              options={[{ value: 'b2b_standard', label: '일반 견적서', sub: '일반 B2B 프로젝트' }, { value: 'b2c_prepaid', label: '차감 견적서', sub: '선입금 잔액 차감' }, { value: 'accumulated_batch', label: '누적 견적서', sub: '월별 누적 청구' }]} />
          </div>
          <div>
            {fLbl('견적일')}
            <input type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} style={inpSt} />
          </div>
          <div>
            {fLbl('부가세')}
            <ClickSelect value={vatType} onChange={v => setVatType(v as VatType)}
              triggerStyle={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', width: '100%' }}
              options={[{ value: 'taxable', label: '부가세 10%' }, { value: 'exempt', label: '면세' }, { value: 'zero_rate', label: '영세율' }]} />
          </div>
          {isStandalone && (
            <div style={{ gridColumn: 'span 3' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                {fLbl('견적서명', true)}
                {!titleEdited && title && <span style={{ fontSize: 10, color: '#6b7280', fontStyle: 'italic', marginBottom: 4 }}>자동생성됨</span>}
              </div>
              <input value={title} onChange={e => { setTitle(e.target.value); setTitleEdited(true); }} placeholder="예: 삼성전자_한영동시통역_20260715" style={inpSt} />
            </div>
          )}
          {isStandalone && (
            <div>
              {fLbl('거래처')}
              <InlineSearchField items={companyOptions} value={companyId} onChange={handleCompanyChange} placeholder="거래처 검색…" popupTitle="거래처 검색" />
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
        <div style={{ ...tblRow, padding: '0 8px 7px', borderBottom: '1.5px solid #e5e7eb', marginBottom: 3 }}>
          <div style={{ ...COL_H }}>행 제어</div>
          <div style={{ ...COL_H }}>유형</div>
          <div style={{ ...COL_H, textAlign: 'left' }}>상품 🔍🧽</div>
          <div style={{ ...COL_H, textAlign: 'left' }}>{fieldHint}</div>
          <div style={{ ...COL_H }}>AI</div>
          <div style={{ ...COL_H }}>수량</div>
          <div style={{ ...COL_H }}>단위</div>
          <div style={{ ...COL_H }}>단가</div>
          <div style={{ ...COL_H, textAlign: 'right' }}>공급가액</div>
          <div style={{ ...COL_H, textAlign: 'left' }}>비고</div>
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
                <span style={{ fontSize: 11, fontWeight: 700, color: c.color }}>{c.label}</span>
                <span style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>{s.supply.toLocaleString()}원</span>
              </div>
            ) : null;
          }).filter(Boolean);
          return gs.length > 1 ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>{gs}</div> : null;
        })()}
        <div style={{ display: 'flex', gap: 16, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {[{ label: '공급가액', value: totals.supply }, { label: '부가세', value: totals.tax }].map(r => (
            <div key={r.label} style={{ textAlign: 'right', padding: '8px 14px', borderRadius: 8, background: '#f8fafc' }}>
              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>{r.label}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#374151' }}>{r.value.toLocaleString()}원</div>
            </div>
          ))}
          <div style={{ textAlign: 'right', padding: '10px 18px', borderRadius: 10, background: '#eff6ff', border: '1.5px solid #bfdbfe' }}>
            <div style={{ fontSize: 11, color: '#2563eb', fontWeight: 700, marginBottom: 2 }}>총 견적금액</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#1d4ed8' }}>{totals.total.toLocaleString()}원</div>
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
            <div style={{ background: '#fffbeb', borderRadius: 10, padding: '12px 16px', border: '1px solid #fde68a' }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#92400e', display: 'block', marginBottom: 6 }}>
                버전 변경 사유 <span style={{ marginLeft: 4, fontWeight: 400, color: '#b45309' }}>— 저장 시 새 Version으로 기록됩니다</span>
              </label>
              <input value={versionReason} onChange={e => setVersionReason(e.target.value)}
                placeholder="예: 최초 견적 / 일정 변경 / 금액 수정 / 고객 요청" style={{ ...inpSt, background: '#fff' }} />
            </div>
          )}
        </div>
      </Card>

      {/* ── 하단 저장 버튼 ──────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingBottom: 8 }}>
        <GhostBtn onClick={onClose} disabled={saving} style={{ fontSize: 14, padding: '10px 22px' }}>취소</GhostBtn>
        <PrimaryBtn onClick={handleSave} disabled={saving} style={{ fontSize: 14, padding: '10px 28px' }}>
          {saving ? '저장 중…' : (isStandalone ? '💾 견적서 저장 (프로젝트 생성)' : '💾 견적 저장')}
        </PrimaryBtn>
      </div>
    </div>
  );

  // ─── 공통 Workspace 헤더 ─────────────────────────────────────────────────

  const wsHeader = (bg: string, border: string, shadow: string, padH: string) => (
    <div style={{ background: bg, borderBottom: border, padding: `0 ${padH}`, height: 52, display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0, boxShadow: shadow }}>
      <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: '#6b7280', fontSize: 13, padding: '4px 0' }}>
        ← 돌아가기
      </button>
      <div style={{ width: 1, height: 20, background: '#e5e7eb' }} />
      <div>
        <span style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>{isStandalone ? '새 견적서 작성' : '견적 작성'}</span>
        {projectId !== null && <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>프로젝트 #{projectId} — Version Engine</span>}
      </div>
      {/* AI 생성 토글 */}
      <div style={{ marginLeft: 'auto', marginRight: 'auto', display: 'flex', gap: 4, background: '#f1f5f9', borderRadius: 10, padding: 4 }}>
        <button type="button" disabled title="AI 견적 생성 (준비 중)"
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'not-allowed', background: creationMode === 'ai' ? '#6366f1' : 'transparent', color: '#9ca3af' }}>
          🤖 AI 견적 생성 <span style={{ fontSize: 10, fontWeight: 700, background: '#e0e7ff', color: '#6366f1', borderRadius: 4, padding: '1px 5px' }}>준비 중</span>
        </button>
        <button type="button" onClick={() => setCreationMode('direct')}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', background: creationMode === 'direct' ? '#fff' : 'transparent', color: creationMode === 'direct' ? '#111827' : '#6b7280', boxShadow: creationMode === 'direct' ? '0 1px 4px rgba(0,0,0,0.1)' : 'none' }}>
          ✏ 직접 작성
        </button>
      </div>
      {/* 저장 버튼 */}
      <div style={{ display: 'flex', gap: 8 }}>
        <GhostBtn onClick={onClose} disabled={saving} style={{ fontSize: 13, padding: '6px 14px' }}>취소</GhostBtn>
        <PrimaryBtn onClick={handleSave} disabled={saving} style={{ fontSize: 13, padding: '7px 18px' }}>
          {saving ? '저장 중…' : '💾 저장'}
        </PrimaryBtn>
      </div>
    </div>
  );

  // ─────────────────────────────────────────────────────────────────────────
  // asPage=true: AdminDashboard 스크롤 영역 내 인라인 렌더링
  //   → QuoteListTab이 margin: '-24px -28px' wrapper로 감싸줌
  // ─────────────────────────────────────────────────────────────────────────

  if (asPage) {
    return (
      <div style={{ background: '#f9fafb', minHeight: '100vh' }}>
        {/* 인라인 Workspace 헤더 — 스크롤 영역에서 sticky */}
        <div style={{ position: 'sticky', top: 0, zIndex: 20, background: '#fff', borderBottom: '1px solid #e5e7eb', height: 52, display: 'flex', alignItems: 'center', gap: 16, padding: '0 28px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: '#6b7280', fontSize: 13, padding: '4px 0' }}>
            ← 돌아가기
          </button>
          <div style={{ width: 1, height: 20, background: '#e5e7eb' }} />
          <div>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>{isStandalone ? '새 견적서 작성' : '견적 작성'}</span>
            {projectId !== null && <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>프로젝트 #{projectId} — Version Engine</span>}
          </div>
          <div style={{ marginLeft: 'auto', marginRight: 'auto', display: 'flex', gap: 4, background: '#f1f5f9', borderRadius: 10, padding: 4 }}>
            <button type="button" disabled title="AI 견적 생성 (준비 중)"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'not-allowed', background: creationMode === 'ai' ? '#6366f1' : 'transparent', color: '#9ca3af' }}>
              🤖 AI 견적 생성 <span style={{ fontSize: 10, fontWeight: 700, background: '#e0e7ff', color: '#6366f1', borderRadius: 4, padding: '1px 5px' }}>준비 중</span>
            </button>
            <button type="button" onClick={() => setCreationMode('direct')}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', background: creationMode === 'direct' ? '#fff' : 'transparent', color: creationMode === 'direct' ? '#111827' : '#6b7280', boxShadow: creationMode === 'direct' ? '0 1px 4px rgba(0,0,0,0.1)' : 'none' }}>
              ✏ 직접 작성
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <GhostBtn onClick={onClose} disabled={saving} style={{ fontSize: 13, padding: '6px 14px' }}>취소</GhostBtn>
            <PrimaryBtn onClick={handleSave} disabled={saving} style={{ fontSize: 13, padding: '7px 18px' }}>
              {saving ? '저장 중…' : '💾 저장'}
            </PrimaryBtn>
          </div>
        </div>

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
    <div style={{ position: 'fixed', inset: 0, zIndex: 800, background: '#f9fafb', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {wsHeader('#fff', '1px solid #e5e7eb', '0 1px 4px rgba(0,0,0,0.06)', '24px')}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 24px 64px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          {formContent}
        </div>
      </div>
    </div>
  );
}
