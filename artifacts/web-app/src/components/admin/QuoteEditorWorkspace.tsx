/**
 * QuoteEditorWorkspace — AI-First 견적 작성 Workspace
 *
 * Popup 방식에서 독립 Workspace(Page) 형태로 전환된 견적 작성 화면.
 * 기존 QuoteEditorModal 저장 로직을 그대로 유지하면서 UX를 확장한다.
 *
 * 사용 방식:
 *   - projectId=null  → 독립 견적서 생성 (프로젝트 없음)
 *   - projectId=number → 기존 프로젝트에 새 견적 추가 (Version Engine)
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, Product } from '../../lib/constants';
import { PrimaryBtn, GhostBtn, ClickSelect, NumericInput } from '../ui';

// ─── 타입 ─────────────────────────────────────────────────────────────────────

type QuoteType = 'b2b_standard' | 'b2c_prepaid' | 'accumulated_batch';
type VatType   = 'taxable' | 'exempt' | 'zero_rate';
type CreationMode = 'direct' | 'ai';

export interface QuoteItemForm {
  productId:    number | null;
  productName:  string;
  productType:  'translation' | 'interpretation' | 'equipment' | 'expense';
  sourceLanguage: string;
  targetLanguage: string;
  unit:         string;
  quantity:     string;
  unitPrice:    string;
  taxType:      VatType;
  memo:         string;
}

interface Company   { id: number; name: string; divisionNames?: string[] }
interface Contact   { id: number; name: string; companyId: number | null }
interface AdminUser { id: number; name?: string | null; email: string }

// ─── 계산 ─────────────────────────────────────────────────────────────────────

function calcItem(it: QuoteItemForm, vatType: VatType) {
  const price   = Number(it.unitPrice.replace?.(/,/g, '') || 0);
  const qty     = Number(it.quantity || 1);
  const supply  = Math.round(qty * price);
  const tax     = vatType === 'taxable' ? Math.round(supply * 0.1) : 0;
  return { supply, tax, total: supply + tax };
}

function calcTotals(items: QuoteItemForm[], vatType: VatType) {
  return items.reduce(
    (acc, it) => {
      const r = calcItem(it, vatType);
      return { supply: acc.supply + r.supply, tax: acc.tax + r.tax, total: acc.total + r.total };
    },
    { supply: 0, tax: 0, total: 0 },
  );
}

function dateOffset(days: number) {
  const d = new Date(); d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function composeLang(it: QuoteItemForm): string {
  const s = it.sourceLanguage.trim(), t = it.targetLanguage.trim();
  return (s || t) ? `${s}→${t}` : '';
}

function defaultItem(): QuoteItemForm {
  return {
    productId: null, productName: '', productType: 'translation',
    sourceLanguage: '', targetLanguage: '',
    unit: '건', quantity: '1', unitPrice: '', taxType: 'taxable', memo: '',
  };
}

// ─── 하이브리드 검색 팝업 ──────────────────────────────────────────────────────

interface SearchPopupProps {
  title: string;
  items: { id: number; label: string; sub?: string }[];
  value: number | null;
  onSelect: (id: number | null) => void;
  onClose: () => void;
}

function SearchPopup({ title, items, value, onSelect, onClose }: SearchPopupProps) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = q.trim()
    ? items.filter(i =>
        i.label.toLowerCase().includes(q.toLowerCase()) ||
        (i.sub ?? '').toLowerCase().includes(q.toLowerCase())
      ).slice(0, 40)
    : items.slice(0, 40);

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: '#fff', borderRadius: 14, width: 480, maxHeight: '70vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        {/* 헤더 */}
        <div style={{ padding: '14px 18px 10px', borderBottom: '1px solid #f0f2f5', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, color: '#9ca3af', cursor: 'pointer', lineHeight: 1, padding: '0 4px' }}>×</button>
        </div>
        {/* 검색창 */}
        <div style={{ padding: '10px 18px', borderBottom: '1px solid #f0f2f5' }}>
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="검색어를 입력하세요…"
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', fontSize: 14, border: '1.5px solid #6366f1', borderRadius: 8, outline: 'none' }}
          />
        </div>
        {/* 결과 목록 */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {value !== null && (
            <div
              onClick={() => { onSelect(null); onClose(); }}
              style={{ padding: '10px 18px', fontSize: 13, color: '#9ca3af', cursor: 'pointer', borderBottom: '1px solid #f8f9fa' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={e => (e.currentTarget.style.background = '')}
            >
              선택 해제
            </div>
          )}
          {filtered.length === 0 && (
            <div style={{ padding: '24px 18px', textAlign: 'center', fontSize: 13, color: '#9ca3af' }}>검색 결과가 없습니다.</div>
          )}
          {filtered.map(item => (
            <div
              key={item.id}
              onClick={() => { onSelect(item.id); onClose(); }}
              style={{ padding: '10px 18px', cursor: 'pointer', background: item.id === value ? '#eff6ff' : undefined, borderBottom: '1px solid #f8f9fa' }}
              onMouseEnter={e => { if (item.id !== value) (e.currentTarget as HTMLDivElement).style.background = '#f8fafc'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = item.id === value ? '#eff6ff' : ''; }}
            >
              <div style={{ fontSize: 14, fontWeight: item.id === value ? 700 : 400, color: '#111827' }}>{item.label}</div>
              {item.sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{item.sub}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── 인라인 검색 필드 (하이브리드 검색 - 기본) ────────────────────────────────

interface InlineSearchFieldProps {
  items:       { id: number; label: string; sub?: string }[];
  value:       number | null;
  onChange:    (id: number | null) => void;
  placeholder?: string;
  popupTitle?: string;
  accentColor?: string;
}

function InlineSearchField({
  items, value, onChange, placeholder = '검색…', popupTitle = '검색', accentColor = '#6366f1',
}: InlineSearchFieldProps) {
  const [open, setOpen]         = useState(false);
  const [q, setQ]               = useState('');
  const [showPopup, setShowPopup] = useState(false);
  const containerRef            = useRef<HTMLDivElement>(null);

  const selected = items.find(i => i.id === value);

  const filtered = q.trim()
    ? items.filter(i =>
        i.label.toLowerCase().includes(q.toLowerCase()) ||
        (i.sub ?? '').toLowerCase().includes(q.toLowerCase())
      ).slice(0, 12)
    : items.slice(0, 12);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false); setQ('');
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const inp: React.CSSProperties = {
    flex: 1, minWidth: 0, padding: '7px 10px', fontSize: 13, border: 'none',
    outline: 'none', background: 'transparent', cursor: 'text',
  };

  const actionBtn: React.CSSProperties = {
    background: 'none', border: 'none', cursor: 'pointer', padding: '0 5px',
    fontSize: 13, lineHeight: 1, display: 'flex', alignItems: 'center',
    color: '#9ca3af', flexShrink: 0,
  };

  return (
    <>
      <div
        ref={containerRef}
        style={{ position: 'relative', display: 'flex', alignItems: 'center', border: `1px solid ${open ? accentColor : '#d1d5db'}`, borderRadius: 8, background: '#fff', transition: 'border-color 0.12s' }}
      >
        <input
          value={open ? q : (selected?.label ?? '')}
          onChange={e => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => { setOpen(true); if (selected) setQ(''); }}
          placeholder={placeholder}
          style={{ ...inp, color: selected && !open ? '#111827' : undefined }}
        />
        {/* 🔍 전체 검색 팝업 */}
        <button
          type="button"
          title="전체 검색"
          onClick={() => { setOpen(false); setShowPopup(true); }}
          style={{ ...actionBtn, color: '#6366f1' }}
        >
          🔍
        </button>
        {/* 🧽 필드 초기화 */}
        {value !== null && (
          <button
            type="button"
            title="초기화"
            onClick={() => { onChange(null); setQ(''); setOpen(false); }}
            style={{ ...actionBtn, color: '#9ca3af' }}
          >
            🧽
          </button>
        )}

        {/* 인라인 드롭다운 */}
        {open && (
          <div style={{ position: 'absolute', top: 'calc(100% + 3px)', left: 0, right: 0, zIndex: 700, background: '#fff', border: `1px solid ${accentColor}`, borderRadius: 10, boxShadow: '0 6px 20px rgba(0,0,0,0.1)', maxHeight: 200, overflowY: 'auto' }}>
            {value !== null && (
              <div
                onClick={() => { onChange(null); setQ(''); setOpen(false); }}
                style={{ padding: '7px 12px', fontSize: 12, color: '#9ca3af', cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f8f9fa')}
                onMouseLeave={e => (e.currentTarget.style.background = '')}
              >
                선택 해제
              </div>
            )}
            {filtered.length === 0 && (
              <div style={{ padding: '10px 12px', fontSize: 12, color: '#9ca3af' }}>
                결과 없음 — <span style={{ color: accentColor, cursor: 'pointer', fontWeight: 600 }} onClick={() => { setOpen(false); setShowPopup(true); }}>전체 검색 열기 🔍</span>
              </div>
            )}
            {filtered.map(item => (
              <div
                key={item.id}
                onClick={() => { onChange(item.id); setQ(''); setOpen(false); }}
                style={{ padding: '7px 12px', cursor: 'pointer', background: item.id === value ? '#eff6ff' : undefined }}
                onMouseEnter={e => { if (item.id !== value) (e.currentTarget as HTMLDivElement).style.background = '#f8fafc'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = item.id === value ? '#eff6ff' : ''; }}
              >
                <div style={{ fontSize: 13, fontWeight: item.id === value ? 700 : 400, color: '#111827' }}>{item.label}</div>
                {item.sub && <div style={{ fontSize: 11, color: '#9ca3af' }}>{item.sub}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {showPopup && (
        <SearchPopup
          title={popupTitle}
          items={items}
          value={value}
          onSelect={onChange}
          onClose={() => setShowPopup(false)}
        />
      )}
    </>
  );
}

// ─── Row 제어 버튼 ────────────────────────────────────────────────────────────

interface RowControlsProps {
  idx:        number;
  total:      number;
  onRemove:   (idx: number) => void;
  onAddBelow: (idx: number) => void;
  onMoveUp:   (idx: number) => void;
  onMoveDown: (idx: number) => void;
}

function RowControls({ idx, total, onRemove, onAddBelow, onMoveUp, onMoveDown }: RowControlsProps) {
  const btn: React.CSSProperties = {
    background: 'none', border: '1px solid #e5e7eb', borderRadius: 5,
    cursor: 'pointer', fontSize: 10, lineHeight: 1, padding: '3px 5px',
    color: '#6b7280', transition: 'all 0.1s',
  };
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center', whiteSpace: 'nowrap' }}>
      <button
        type="button" title="행 삭제"
        onClick={() => onRemove(idx)}
        disabled={total <= 1}
        style={{ ...btn, color: total > 1 ? '#e11d48' : '#d1d5db', borderColor: total > 1 ? '#fca5a5' : '#e5e7eb', cursor: total > 1 ? 'pointer' : 'default' }}
        onMouseEnter={e => { if (total > 1) { (e.currentTarget.style.background = '#fef2f2'); } }}
        onMouseLeave={e => { (e.currentTarget.style.background = 'none'); }}
      >
        −
      </button>
      <button
        type="button" title="아래 행 추가"
        onClick={() => onAddBelow(idx)}
        style={{ ...btn, color: '#2563eb', borderColor: '#bfdbfe' }}
        onMouseEnter={e => { (e.currentTarget.style.background = '#eff6ff'); }}
        onMouseLeave={e => { (e.currentTarget.style.background = 'none'); }}
      >
        +
      </button>
      <button
        type="button" title="위로 이동"
        onClick={() => onMoveUp(idx)}
        disabled={idx === 0}
        style={{ ...btn, color: idx === 0 ? '#d1d5db' : '#6b7280', cursor: idx === 0 ? 'default' : 'pointer' }}
        onMouseEnter={e => { if (idx > 0) (e.currentTarget.style.background = '#f3f4f6'); }}
        onMouseLeave={e => { (e.currentTarget.style.background = 'none'); }}
      >
        ▲
      </button>
      <button
        type="button" title="아래로 이동"
        onClick={() => onMoveDown(idx)}
        disabled={idx === total - 1}
        style={{ ...btn, color: idx === total - 1 ? '#d1d5db' : '#6b7280', cursor: idx === total - 1 ? 'default' : 'pointer' }}
        onMouseEnter={e => { if (idx < total - 1) (e.currentTarget.style.background = '#f3f4f6'); }}
        onMouseLeave={e => { (e.currentTarget.style.background = 'none'); }}
      >
        ▼
      </button>
    </div>
  );
}

// ─── 스타일 상수 ─────────────────────────────────────────────────────────────

const inp: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', border: '1px solid #d1d5db',
  borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none',
};
const lbl = (txt: string, required = false) => (
  <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>
    {txt}{required && <span style={{ color: '#e11d48', marginLeft: 2 }}>*</span>}
  </label>
);
const sectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase',
  letterSpacing: '0.06em', paddingBottom: 8, borderBottom: '1.5px solid #e5e7eb', marginBottom: 14,
  display: 'flex', alignItems: 'center', gap: 6,
};
const QUOTE_TYPE_LABEL: Record<QuoteType, string> = {
  b2b_standard:     '일반 견적서',
  b2c_prepaid:      '차감 견적서',
  accumulated_batch: '누적 견적서',
};

// ─── 메인 컴포넌트 Props ──────────────────────────────────────────────────────

export interface QuoteEditorWorkspaceProps {
  token:              string;
  /** null = 독립 견적서 생성, number = 기존 프로젝트에 견적 추가 (Version Engine) */
  projectId:          number | null;
  initialCompanyId?:  number | null;
  initialContactId?:  number | null;
  initialTitle?:      string;
  onClose:            () => void;
  onSaved:            (result: { quoteId: number; projectId: number | null }) => void;
  onToast:            (msg: string) => void;
  adminList?:         AdminUser[];
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

  // ── 견적서명 자동생성: {고객사명}_{대표상품명}_{작업일자} ────────────────────
  useEffect(() => {
    if (titleEdited || projectId !== null) return;
    const company = companies.find(c => c.id === companyId);
    const validItems = items.filter(it => it.productName.trim());
    if (!company || validItems.length === 0) return;
    const dateStr = issueDate.replace(/-/g, '');
    setTitle(`${company.name}_${validItems[0].productName.trim()}_${dateStr}`);
  }, [companyId, items, issueDate, companies, titleEdited, projectId]);

  // ── 거래처 변경 시 담당자 초기화 ───────────────────────────────────────────
  const handleCompanyChange = (cid: number | null) => {
    setCompanyId(cid);
    setContactId(null);
    setTitleEdited(false);
  };

  // ── 참조 데이터 옵션 ───────────────────────────────────────────────────────
  const isStandalone = projectId === null;

  const companyOptions = companies.map(c => ({
    id: c.id, label: c.name,
    sub: c.divisionNames?.slice(0, 2).join(' · '),
  }));

  const contactOptions = (contactId !== null || companyId === null
    ? contacts
    : contacts.filter(c => c.companyId === companyId)
  ).map(c => ({ id: c.id, label: c.name }));

  const productOptions = products.map(p => ({
    id: p.id,
    label: p.name,
    sub: p.code ?? undefined,
  }));

  const adminOptions = adminList.map(u => ({ id: u.id, label: u.name ?? u.email }));

  // ── 항목 조작 ──────────────────────────────────────────────────────────────
  const updateItem = (idx: number, patch: Partial<QuoteItemForm>) =>
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, ...patch } : it));

  const selectProduct = (idx: number, pid: number | null) => {
    const p = pid != null ? products.find(pr => pr.id === pid) : null;
    updateItem(idx, {
      productId:   p?.id ?? null,
      productName: p?.name || '',
      productType: (p?.productType as QuoteItemForm['productType']) ?? 'translation',
      unit: p?.unit ?? '건',
    });
  };

  const addItemBelow = (idx: number) =>
    setItems(prev => [...prev.slice(0, idx + 1), defaultItem(), ...prev.slice(idx + 1)]);

  const removeItem = (idx: number) =>
    setItems(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);

  const moveItem = (idx: number, dir: 'up' | 'down') => {
    setItems(prev => {
      const next = [...prev];
      const swap = dir === 'up' ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= next.length) return prev;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  };

  // ── 금액 계산 ──────────────────────────────────────────────────────────────
  const totals = calcTotals(items, vatType);

  // ── 저장 (기존 로직 그대로 유지) ──────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const validItems = items.filter(it => it.productName.trim() && Number(it.unitPrice.replace?.(/,/g, '') || 0) > 0);
    if (validItems.length === 0) { onToast('품목명과 단가를 입력하세요.'); return; }

    const itemsBody = validItems.map(it => ({
      productId:    it.productId ?? undefined,
      productName:  it.productName.trim(),
      languagePair: composeLang(it) || undefined,
      unit:         it.unit || '건',
      quantity:     Number(it.quantity) || 1,
      unitPrice:    Number(it.unitPrice.replace?.(/,/g, '') || 0),
      taxRate:      (vatType === 'taxable' ? 0.1 : 0) as 0 | 0.1,
      taxType:      vatType,
      itemType:     it.productType,
      memo:         it.memo || undefined,
    }));

    const commonBody = {
      items: itemsBody,
      quoteType,
      billingType:     'postpaid_per_project',
      taxDocumentType: 'tax_invoice',
      taxCategory:     'normal',
      issueDate,
      validUntil: (() => {
        const d = new Date(issueDate); d.setDate(d.getDate() + 30);
        return d.toISOString().split('T')[0];
      })(),
      note: note.trim() || undefined,
    };

    setSaving(true);
    try {
      if (projectId === null) {
        const t = title.trim();
        if (!t) { onToast('견적서명을 입력하세요.'); return; }
        const res = await fetch(api('/api/admin/quotes'), {
          method: 'POST',
          headers: { ...authH, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...commonBody, title: t, companyId: companyId ?? undefined, contactId: contactId ?? undefined, adminId: adminId ?? undefined }),
        });
        const data = await res.json();
        if (!res.ok) { onToast(`견적서 저장 실패: ${data.error}`); return; }
        onToast('견적서가 저장되었습니다.');
        onSaved({ quoteId: data.id, projectId: null });
        return;
      }

      const res = await fetch(api(`/api/admin/projects/${projectId}/quote`), {
        method: 'POST',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...commonBody, title: title.trim() || undefined, versionReason: versionReason.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`견적 저장 실패: ${data.error}`); return; }
      onToast('견적이 저장되었습니다.');
      onSaved({ quoteId: data.id, projectId });
    } catch { onToast('견적 저장 중 오류가 발생했습니다.'); }
    finally { setSaving(false); }
  }, [items, projectId, title, companyId, contactId, adminId, issueDate, quoteType, vatType, note, versionReason, token]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 테이블 컬럼 헤더 ────────────────────────────────────────────────────────
  const thStyle: React.CSSProperties = {
    padding: '7px 8px', fontSize: 11, fontWeight: 600, color: '#6b7280',
    background: '#f8fafc', borderBottom: '1.5px solid #e5e7eb', whiteSpace: 'nowrap',
    textAlign: 'left',
  };
  const tdStyle: React.CSSProperties = {
    padding: '5px 6px', verticalAlign: 'middle', borderBottom: '1px solid #f0f2f5',
  };

  // ────────────────────────────────────────────────────────────────────────────

  return (
    // 전체 화면 오버레이 Workspace
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 800, background: '#f1f5f9', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >

      {/* ── 상단 헤더 바 ─────────────────────────────────────────────────────── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '0 24px', height: 56, display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>

        {/* 뒤로가기 + 타이틀 */}
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: '#6b7280', fontSize: 13, padding: '4px 0' }}
        >
          ← 돌아가기
        </button>
        <div style={{ width: 1, height: 20, background: '#e5e7eb' }} />
        <div>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>
            {isStandalone ? '새 견적서 작성' : '견적 작성'}
          </span>
          {projectId !== null && (
            <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>
              프로젝트 #{projectId} — Version Engine 적용
            </span>
          )}
        </div>

        {/* ── 생성 방식 선택 (중앙) ── */}
        <div style={{ marginLeft: 'auto', marginRight: 'auto', display: 'flex', gap: 4, background: '#f1f5f9', borderRadius: 10, padding: 4 }}>
          {/* AI 견적 생성 — UI 준비, 기능 미구현 */}
          <button
            type="button"
            disabled
            title="AI 견적 생성 (준비 중)"
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 18px', borderRadius: 7, fontSize: 13, fontWeight: 600,
              border: 'none', cursor: 'not-allowed',
              background: creationMode === 'ai' ? '#6366f1' : 'transparent',
              color: creationMode === 'ai' ? '#fff' : '#9ca3af',
              transition: 'all 0.15s',
            }}
          >
            🤖 AI 견적 생성
            <span style={{ fontSize: 10, fontWeight: 700, background: '#e0e7ff', color: '#6366f1', borderRadius: 4, padding: '1px 5px' }}>준비 중</span>
          </button>

          {/* 직접 작성 */}
          <button
            type="button"
            onClick={() => setCreationMode('direct')}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 18px', borderRadius: 7, fontSize: 13, fontWeight: 600,
              border: 'none', cursor: 'pointer',
              background: creationMode === 'direct' ? '#fff' : 'transparent',
              color: creationMode === 'direct' ? '#111827' : '#6b7280',
              boxShadow: creationMode === 'direct' ? '0 1px 4px rgba(0,0,0,0.1)' : 'none',
              transition: 'all 0.15s',
            }}
          >
            ✏ 직접 작성
          </button>
        </div>

        {/* 저장 버튼 (우측) */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <GhostBtn onClick={onClose} disabled={saving} style={{ fontSize: 13, padding: '7px 16px' }}>취소</GhostBtn>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            style={{
              background: saving ? '#93c5fd' : '#2563eb', color: '#fff', border: 'none',
              borderRadius: 8, padding: '8px 20px', fontSize: 13, fontWeight: 700,
              cursor: saving ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {saving ? '저장 중…' : (isStandalone ? '💾 견적 저장' : '💾 견적 저장')}
          </button>
        </div>
      </div>

      {/* ── 본문 영역 (스크롤) ────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 24px 48px' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: '#9ca3af', fontSize: 14 }}>
            데이터 불러오는 중…
          </div>
        ) : (
          <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

            {/* ── A. 기본정보 ─────────────────────────────────────────────────── */}
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px' }}>
              <div style={sectionTitle}>
                <span style={{ width: 20, height: 20, borderRadius: 6, background: '#eff6ff', color: '#2563eb', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>A</span>
                기본정보
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px 20px' }}>

                {/* 견적서 유형 */}
                <div>
                  {lbl('견적서 유형')}
                  <ClickSelect
                    value={quoteType}
                    onChange={v => setQuoteType(v as QuoteType)}
                    triggerStyle={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', width: '100%' }}
                    options={[
                      { value: 'b2b_standard',    label: '일반 견적서',  sub: '일반 B2B 프로젝트' },
                      { value: 'b2c_prepaid',      label: '차감 견적서', sub: '선입금 잔액 차감' },
                      { value: 'accumulated_batch', label: '누적 견적서', sub: '월별 누적 청구' },
                    ]}
                  />
                </div>

                {/* 견적일 */}
                <div>
                  {lbl('견적일')}
                  <input type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} style={{ ...inp }} />
                </div>

                {/* 부가세 */}
                <div>
                  {lbl('부가세')}
                  <ClickSelect
                    value={vatType}
                    onChange={v => setVatType(v as VatType)}
                    triggerStyle={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', width: '100%' }}
                    options={[
                      { value: 'taxable',   label: '부가세 10%' },
                      { value: 'exempt',    label: '면세' },
                      { value: 'zero_rate', label: '영세율' },
                    ]}
                  />
                </div>

                {/* 견적서명 — standalone만 */}
                {isStandalone && (
                  <div style={{ gridColumn: 'span 3' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      {lbl('견적서명', true)}
                      {!titleEdited && title && (
                        <span style={{ fontSize: 10, color: '#6b7280', fontStyle: 'italic', marginBottom: 4 }}>자동생성됨</span>
                      )}
                    </div>
                    <input
                      value={title}
                      onChange={e => { setTitle(e.target.value); setTitleEdited(true); }}
                      placeholder="예: 삼성전자_한영동시통역_20260715"
                      style={{ ...inp }}
                    />
                  </div>
                )}

                {/* 거래처 — standalone만 */}
                {isStandalone && (
                  <div>
                    {lbl('거래처')}
                    <InlineSearchField
                      items={companyOptions}
                      value={companyId}
                      onChange={handleCompanyChange}
                      placeholder="거래처 검색…"
                      popupTitle="거래처 검색"
                      accentColor="#6366f1"
                    />
                  </div>
                )}

                {/* 담당자 — standalone만 */}
                {isStandalone && (
                  <div>
                    {lbl('담당자')}
                    <InlineSearchField
                      items={contactOptions}
                      value={contactId}
                      onChange={setContactId}
                      placeholder="담당자 검색…"
                      popupTitle="담당자 검색"
                      accentColor="#6366f1"
                    />
                  </div>
                )}

                {/* 담당 PM */}
                <div>
                  {lbl('담당 PM')}
                  <InlineSearchField
                    items={adminOptions}
                    value={adminId}
                    onChange={setAdminId}
                    placeholder="PM 검색 (선택)"
                    popupTitle="담당 PM 검색"
                    accentColor="#6366f1"
                  />
                </div>

              </div>
            </div>

            {/* ── B. 견적 항목 ────────────────────────────────────────────────── */}
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px' }}>
              <div style={sectionTitle}>
                <span style={{ width: 20, height: 20, borderRadius: 6, background: '#f0fdf4', color: '#16a34a', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>B</span>
                견적 항목
                <span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af', marginLeft: 4 }}>
                  ← 행 제어: − 삭제 / + 행 추가 / ▲▼ 순서 변경
                </span>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
                  <thead>
                    <tr>
                      {/* 행 제어 */}
                      <th style={{ ...thStyle, width: 90 }}>행 제어</th>
                      {/* 상품 */}
                      <th style={{ ...thStyle, minWidth: 180 }}>
                        상품
                        <span style={{ fontSize: 10, fontWeight: 400, color: '#9ca3af', marginLeft: 4 }}>🔍 검색</span>
                      </th>
                      {/* 언어쌍 / 상품명 */}
                      <th style={{ ...thStyle, minWidth: 180 }}>언어쌍 / 상품명</th>
                      {/* 단위 */}
                      <th style={{ ...thStyle, width: 72 }}>단위</th>
                      {/* 수량 */}
                      <th style={{ ...thStyle, width: 80 }}>수량</th>
                      {/* 단가 */}
                      <th style={{ ...thStyle, width: 120 }}>단가</th>
                      {/* 공급가액 */}
                      <th style={{ ...thStyle, width: 110, textAlign: 'right' }}>공급가액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => {
                      const supply = calcItem(it, vatType).supply;
                      return (
                        <tr key={idx} style={{ transition: 'background 0.1s' }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#fafcff')}
                          onMouseLeave={e => (e.currentTarget.style.background = '')}>

                          {/* ── 행 제어 (가장 왼쪽) ── */}
                          <td style={{ ...tdStyle, width: 90 }}>
                            <RowControls
                              idx={idx}
                              total={items.length}
                              onRemove={removeItem}
                              onAddBelow={addItemBelow}
                              onMoveUp={i => moveItem(i, 'up')}
                              onMoveDown={i => moveItem(i, 'down')}
                            />
                          </td>

                          {/* ── 상품 (하이브리드 검색) ── */}
                          <td style={{ ...tdStyle, minWidth: 180 }}>
                            <InlineSearchField
                              items={productOptions}
                              value={it.productId}
                              onChange={pid => selectProduct(idx, pid)}
                              placeholder="상품 검색…"
                              popupTitle="상품 검색"
                              accentColor="#7c3aed"
                            />
                          </td>

                          {/* ── 언어쌍 / 상품명 ── */}
                          <td style={{ ...tdStyle, minWidth: 180 }}>
                            {it.productType === 'translation' ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                                  <input
                                    value={it.sourceLanguage}
                                    onChange={e => updateItem(idx, { sourceLanguage: e.target.value })}
                                    placeholder="출발"
                                    style={{ ...inp, padding: '5px 6px', fontSize: 12, width: 68 }}
                                  />
                                  <span style={{ color: '#9ca3af', fontSize: 11 }}>→</span>
                                  <input
                                    value={it.targetLanguage}
                                    onChange={e => updateItem(idx, { targetLanguage: e.target.value })}
                                    placeholder="도착"
                                    style={{ ...inp, padding: '5px 6px', fontSize: 12, width: 68 }}
                                  />
                                </div>
                                <input
                                  value={it.productName}
                                  onChange={e => updateItem(idx, { productName: e.target.value })}
                                  placeholder="상품명 (자동입력)"
                                  style={{ ...inp, padding: '4px 6px', fontSize: 11, color: '#6b7280' }}
                                />
                              </div>
                            ) : (
                              <input
                                value={it.productName}
                                onChange={e => updateItem(idx, { productName: e.target.value })}
                                placeholder="상품명 직접 입력"
                                style={{ ...inp, padding: '5px 8px', fontSize: 12 }}
                              />
                            )}
                          </td>

                          {/* ── 단위 ── */}
                          <td style={{ ...tdStyle, width: 72 }}>
                            <input
                              value={it.unit}
                              onChange={e => updateItem(idx, { unit: e.target.value })}
                              placeholder="건"
                              style={{ ...inp, padding: '6px 6px', fontSize: 12 }}
                            />
                          </td>

                          {/* ── 수량 ── */}
                          <td style={{ ...tdStyle, width: 80 }}>
                            <NumericInput
                              value={it.quantity}
                              onChange={v => updateItem(idx, { quantity: v })}
                              placeholder="1"
                            />
                          </td>

                          {/* ── 단가 ── */}
                          <td style={{ ...tdStyle, width: 120 }}>
                            <NumericInput
                              value={it.unitPrice}
                              onChange={v => updateItem(idx, { unitPrice: v })}
                              placeholder="0"
                              suffix="원"
                            />
                          </td>

                          {/* ── 공급가액 ── */}
                          <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600, color: '#1e3a5f', fontSize: 12 }}>
                            {supply > 0 ? supply.toLocaleString() + '원' : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* 항목 추가 버튼 (최하단) */}
              <button
                type="button"
                onClick={() => addItemBelow(items.length - 1)}
                style={{ marginTop: 10, fontSize: 12, color: '#6366f1', background: 'none', border: '1.5px dashed #c7d2fe', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600 }}
              >
                + 항목 추가
              </button>
            </div>

            {/* ── C. 금액 요약 ────────────────────────────────────────────────── */}
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '16px 24px' }}>
              <div style={sectionTitle}>
                <span style={{ width: 20, height: 20, borderRadius: 6, background: '#fffbeb', color: '#d97706', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>C</span>
                금액 요약
              </div>
              <div style={{ display: 'flex', gap: 20, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ textAlign: 'right', padding: '8px 16px', borderRadius: 8, background: '#f8fafc' }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>공급가액</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#374151' }}>{totals.supply.toLocaleString()}원</div>
                </div>
                <div style={{ textAlign: 'right', padding: '8px 16px', borderRadius: 8, background: '#f8fafc' }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>부가세</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#374151' }}>{totals.tax.toLocaleString()}원</div>
                </div>
                <div style={{ textAlign: 'right', padding: '10px 20px', borderRadius: 10, background: '#eff6ff', border: '1.5px solid #bfdbfe' }}>
                  <div style={{ fontSize: 11, color: '#2563eb', fontWeight: 700, marginBottom: 2 }}>총 견적금액</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#1d4ed8' }}>{totals.total.toLocaleString()}원</div>
                </div>
              </div>
            </div>

            {/* ── D. 비고 / 버전 변경 사유 ────────────────────────────────────── */}
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={sectionTitle}>
                <span style={{ width: 20, height: 20, borderRadius: 6, background: '#f5f3ff', color: '#7c3aed', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>D</span>
                비고 / 기타
              </div>

              <div>
                {lbl('비고')}
                <textarea
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="견적 관련 메모 또는 안내 사항"
                  rows={2}
                  style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }}
                />
              </div>

              {/* 버전 변경 사유 — projectId 있을 때만 */}
              {projectId !== null && (
                <div style={{ background: '#fffbeb', borderRadius: 10, padding: '12px 16px', border: '1px solid #fde68a' }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: '#92400e', display: 'block', marginBottom: 6 }}>
                    버전 변경 사유
                    <span style={{ marginLeft: 6, fontWeight: 400, color: '#b45309' }}>— 저장 시 새 Version으로 기록됩니다</span>
                  </label>
                  <input
                    value={versionReason}
                    onChange={e => setVersionReason(e.target.value)}
                    placeholder="예: 최초 견적 / 일정 변경 / 금액 수정 / 고객 요청"
                    style={{ ...inp, background: '#fff' }}
                  />
                </div>
              )}
            </div>

            {/* ── E. 하단 저장 버튼 ────────────────────────────────────────────── */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 4 }}>
              <GhostBtn onClick={onClose} disabled={saving} style={{ fontSize: 14, padding: '10px 22px' }}>취소</GhostBtn>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                style={{
                  background: saving ? '#93c5fd' : '#2563eb', color: '#fff', border: 'none',
                  borderRadius: 10, padding: '10px 28px', fontSize: 14, fontWeight: 700,
                  cursor: saving ? 'not-allowed' : 'pointer',
                }}
              >
                {saving ? '저장 중…' : (isStandalone ? '💾 견적서 저장 (프로젝트 생성)' : '💾 견적 저장')}
              </button>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
