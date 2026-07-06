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
  fileName:     string;
  fileFormat:   string;
  wordCount:    string;
  charCount:    string;
  // 통역 전용
  interpretDate:  string;
  startTime:      string;
  endTime:        string;
  interpretPlace: string;
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
  translation: '건', interpretation: '시간', equipment: '개', expense: '건',
};
const BASE_UNITS = ['건', '페이지', '시간', '일', '명', '개', '회', '식', '단어', '글자'];
function getUnitOptions(v: string) {
  return BASE_UNITS.includes(v) || !v ? BASE_UNITS : [v, ...BASE_UNITS];
}

// ─── 계산 ─────────────────────────────────────────────────────────────────────

function calcItem(it: QuoteItemForm, vat: VatType) {
  const p = Number(it.unitPrice.replace?.(/,/g, '') || 0);
  const q = Number(it.quantity || 1);
  const s = Math.round(q * p);
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
    quantity: '1', unit: '건', unitPrice: '', taxType: 'taxable', memo: '',
    fileName: '', fileFormat: '', wordCount: '', charCount: '',
    interpretDate: '', startTime: '', endTime: '', interpretPlace: '',
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
      const dur = [it.startTime, it.endTime].filter(Boolean).join('~');
      return { ...base, interpretDate: it.interpretDate || undefined, interpretPlace: it.interpretPlace || undefined, interpretDuration: dur || undefined, memo: it.memo || undefined };
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
  borderRadius: 6, padding: '4px 6px', fontSize: 12, outline: 'none', minWidth: 0, background: '#fff', ...x,
});
const sep_s: React.CSSProperties = { flexShrink: 0, fontSize: 11, color: '#9ca3af', userSelect: 'none' };

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

  const pad = compact ? '4px 6px' : '7px 10px';
  const fs  = compact ? 12 : 13;

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
    cursor: dis ? 'default' : 'pointer', fontSize: 10, lineHeight: 1,
    padding: '3px 5px', color: dis ? '#d1d5db' : '#6b7280',
  });
  const hov = (el: HTMLButtonElement, c: string) => { el.style.background = c; };
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
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
        style={{ display: 'flex', alignItems: 'center', gap: 3, background: cfg.bg, color: cfg.color, border: `1.5px solid ${cfg.border}`, borderRadius: 6, padding: '3px 7px', fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', width: 58 }}>
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

// ─── 단위 선택 ───────────────────────────────────────────────────────────────

function UnitSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const opts = getUnitOptions(value);
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 4px', fontSize: 12, outline: 'none', background: '#fff', cursor: 'pointer', height: 28 }}>
      {!value && <option value="">단위</option>}
      {opts.map(u => <option key={u} value={u}>{u}</option>)}
    </select>
  );
}

// ─── 서비스 유형별 동적 필드 ─────────────────────────────────────────────────

function ServiceFields({ it, update }: { it: QuoteItemForm; update: (p: Partial<QuoteItemForm>) => void }) {
  switch (it.productType) {
    case 'translation':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
          <input value={it.fileName}   onChange={e => update({ fileName: e.target.value })}   placeholder="파일명"  style={{ ...rinp('auto'), flex: 1, minWidth: 80 }} title="원본 파일명" />
          <input value={it.fileFormat} onChange={e => update({ fileFormat: e.target.value })} placeholder="형식"   style={rinp(56)}  title="파일 형식 (예: docx, pdf)" />
          <input value={it.wordCount}  onChange={e => update({ wordCount: e.target.value })}  placeholder="단어수" style={rinp(60)}  title="단어수 (참고용)" />
          <input value={it.charCount}  onChange={e => update({ charCount: e.target.value })}  placeholder="글자수" style={rinp(60, { color: '#6b7280' })} title="글자수 (참고용)" />
        </div>
      );
    case 'interpretation':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
          <input type="date" value={it.interpretDate} onChange={e => update({ interpretDate: e.target.value })} style={rinp(98)} title="행사일" />
          <input value={it.startTime} onChange={e => update({ startTime: e.target.value })} placeholder="시작" style={rinp(50)} title="시작 시간 (예: 09:00)" />
          <span style={sep_s}>~</span>
          <input value={it.endTime} onChange={e => update({ endTime: e.target.value })} placeholder="종료" style={rinp(50)} title="종료 시간 (예: 18:00)" />
          <input value={it.interpretPlace} onChange={e => update({ interpretPlace: e.target.value })} placeholder="장소" style={{ ...rinp('auto'), flex: 1, minWidth: 60 }} title="행사 장소" />
        </div>
      );
    case 'equipment':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
          <input type="date" value={it.eventStartDate} onChange={e => update({ eventStartDate: e.target.value })} style={rinp(98)} title="장비 사용일" />
          <input value={it.itemLocation} onChange={e => update({ itemLocation: e.target.value })} placeholder="사용 장소" style={{ ...rinp('auto'), flex: 1, minWidth: 80 }} title="장비 사용 장소" />
          <input value={it.usagePeriod} onChange={e => update({ usagePeriod: e.target.value })} placeholder="사용기간" style={rinp(68)} title="사용 기간 (예: 1일, 반일)" />
        </div>
      );
    default:
      return <div style={{ flex: 1, minWidth: 0 }} />;
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
  const supply = calcItem(it, vatType).supply;
  const cfg    = SVC_CFG[it.productType];

  const selectProduct = (pid: number | null) => {
    const p = pid != null ? products.find(pr => pr.id === pid) : null;
    updateItem(idx, { productId: p?.id ?? null, productName: p?.name ?? '', productType: (p?.productType as ServiceType) ?? it.productType, unit: p?.unit ?? SVC_DEFAULT_UNIT[it.productType] });
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 8px', borderBottom: '1px solid #f0f2f5', minHeight: 40, transition: 'background 0.1s' }}
      onMouseEnter={e => (e.currentTarget.style.background = '#fafcff')} onMouseLeave={e => (e.currentTarget.style.background = '')}>

      {/* ① 행 제어 */}
      <div style={{ flexShrink: 0, width: 90 }}>
        <RowControls idx={idx} total={total} onRemove={removeItem} onAddBelow={addItemBelow}
          onMoveUp={i => moveItem(i, 'up')} onMoveDown={i => moveItem(i, 'down')} />
      </div>

      {/* ② 유형 */}
      <div style={{ flexShrink: 0, width: 60 }}>
        <ServiceTypeSelector value={it.productType}
          onChange={t => updateItem(idx, { ...defaultItemForType(t), productId: null, productName: '' })} />
      </div>

      {/* ③ 상품 */}
      <div style={{ flexShrink: 0, width: 150, display: 'flex' }}>
        <InlineSearchField items={products.map(p => ({ id: p.id, label: p.name, sub: p.code ?? undefined }))}
          value={it.productId} onChange={selectProduct} placeholder="상품 검색…" popupTitle="상품 검색"
          accentColor={cfg.border} compact />
      </div>

      {/* ④ 서비스별 동적 필드 */}
      <ServiceFields it={it} update={p => updateItem(idx, p)} />

      {/* ⑤ 수량 */}
      <div style={{ flexShrink: 0, width: 58 }}>
        <NumericInput value={it.quantity} onChange={v => updateItem(idx, { quantity: v })} placeholder="1" />
      </div>

      {/* ⑥ 단위 */}
      <div style={{ flexShrink: 0, width: 60 }}>
        <UnitSelect value={it.unit} onChange={v => updateItem(idx, { unit: v })} />
      </div>

      {/* ⑦ 단가 */}
      <div style={{ flexShrink: 0, width: 90 }}>
        <NumericInput value={it.unitPrice} onChange={v => updateItem(idx, { unitPrice: v })} placeholder="0" suffix="원" />
      </div>

      {/* ⑧ 공급가액 */}
      <div style={{ flexShrink: 0, width: 82, textAlign: 'right', fontWeight: 600, color: supply > 0 ? '#1e3a5f' : '#d1d5db', fontSize: 12, whiteSpace: 'nowrap' }}>
        {supply > 0 ? supply.toLocaleString() + '원' : '—'}
      </div>

      {/* ⑨ 비고 */}
      <div style={{ flexShrink: 0, width: 88 }}>
        <input value={it.memo} onChange={e => updateItem(idx, { memo: e.target.value })}
          placeholder="비고" style={rinp(88, { color: '#6b7280' })} title="긴급, 감수 포함, 출장비 별도 등" />
      </div>
    </div>
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

const COL_H: React.CSSProperties = { flexShrink: 0, fontSize: 10, fontWeight: 700, color: '#9ca3af', textAlign: 'center' };

const SVC_FIELD_HINTS: Record<ServiceType, string> = {
  translation:    '파일명 / 형식 / 단어수 / 글자수',
  interpretation: '행사일 / 시작 ~ 종료 / 장소',
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

        {/* 컬럼 헤더 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 8px 5px', borderBottom: '1.5px solid #e5e7eb', marginBottom: 2 }}>
          <div style={{ ...COL_H, width: 90 }}>행 제어</div>
          <div style={{ ...COL_H, width: 60 }}>유형</div>
          <div style={{ ...COL_H, width: 150, textAlign: 'left' }}>상품 🔍🧽</div>
          <div style={{ flex: 1, fontSize: 10, fontWeight: 700, color: '#9ca3af', minWidth: 0 }}>{fieldHint}</div>
          <div style={{ ...COL_H, width: 58 }}>수량</div>
          <div style={{ ...COL_H, width: 60 }}>단위</div>
          <div style={{ ...COL_H, width: 90 }}>단가</div>
          <div style={{ ...COL_H, width: 82, textAlign: 'right' }}>공급가액</div>
          <div style={{ ...COL_H, width: 88 }}>비고</div>
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
