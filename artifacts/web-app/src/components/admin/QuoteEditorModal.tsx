/**
 * QuoteEditorModal — 독립 견적서 작성 모달
 *
 * 사용 방식:
 *   - projectId=null  → 독립 견적서 생성 (프로젝트 없음 — approved 시 자동 생성)
 *   - projectId=number → 기존 프로젝트에 새 견적 추가
 *
 * 기존 ProjectDetailModal 의 견적 섹션 로직을 재사용 가능한 독립 컴포넌트로 분리한 버전.
 * 향후 AI 견적, 견적 복사, 고객 포털 모두 이 컴포넌트를 재사용한다.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, Product } from '../../lib/constants';
import { DraggableModal } from './DraggableModal';
import { PrimaryBtn, GhostBtn, ClickSelect, NumericInput } from '../ui';

// ─── 타입 ─────────────────────────────────────────────────────────────────────

type QuoteType = 'b2b_standard' | 'b2c_prepaid' | 'accumulated_batch';
type VatType   = 'taxable' | 'exempt' | 'zero_rate';

export interface QuoteItemForm {
  productId: number | null;
  productName: string;
  productType: 'translation' | 'interpretation' | 'equipment' | 'expense';
  sourceLanguage: string;
  targetLanguage: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  taxType: VatType;
  memo: string;
}

interface Company  { id: number; name: string; divisionNames?: string[] }
interface Contact  { id: number; name: string; companyId: number | null }
interface AdminUser { id: number; name: string | null; email: string }

// ─── 계산 ─────────────────────────────────────────────────────────────────────

function calcItem(it: QuoteItemForm, vatType: VatType) {
  const price = Number(it.unitPrice.replace?.(/,/g, '') || 0);
  const qty   = Number(it.quantity || 1);
  const supply = Math.round(qty * price);
  const tax    = vatType === 'taxable' ? Math.round(supply * 0.1) : 0;
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
  if (s || t) return `${s}→${t}`;
  return '';
}

// ─── 기본 견적 항목 ───────────────────────────────────────────────────────────

function defaultItem(): QuoteItemForm {
  return {
    productId: null, productName: '', productType: 'translation',
    sourceLanguage: '', targetLanguage: '',
    unit: '건', quantity: '1', unitPrice: '', taxType: 'taxable', memo: '',
  };
}

// ─── 간단한 inline SearchableSelect ──────────────────────────────────────────

function SearchableSelect({ items, value, onChange, placeholder = '검색…', accentBorder = '#6366f1' }: {
  items: { id: number; label: string; sub?: string }[];
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder?: string;
  accentBorder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const selected = items.find(i => i.id === value);

  const filtered = q.trim()
    ? items.filter(i => i.label.toLowerCase().includes(q.toLowerCase()) || (i.sub ?? '').toLowerCase().includes(q.toLowerCase())).slice(0, 20)
    : items.slice(0, 20);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const is = { width: '100%', boxSizing: 'border-box' as const, border: `1px solid ${open ? accentBorder : '#d1d5db'}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none', cursor: 'pointer', background: '#fff' };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => { setOpen(v => !v); setQ(''); }} style={{ ...is, textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ color: selected ? '#111827' : '#9ca3af' }}>{selected ? selected.label : placeholder}</span>
        <span style={{ fontSize: 10, color: '#9ca3af' }}>▼</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', zIndex: 999, top: '100%', left: 0, right: 0, background: '#fff', border: `1px solid ${accentBorder}`, borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', marginTop: 4, maxHeight: 220, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="검색…"
            style={{ border: 'none', borderBottom: '1px solid #e5e7eb', padding: '8px 12px', fontSize: 12, outline: 'none' }} />
          <div style={{ overflowY: 'auto' }}>
            {value !== null && <div onClick={() => { onChange(null); setOpen(false); }} style={{ padding: '8px 12px', fontSize: 12, color: '#9ca3af', cursor: 'pointer' }}>선택 해제</div>}
            {filtered.length === 0 && <div style={{ padding: '10px 12px', fontSize: 12, color: '#9ca3af' }}>결과 없음</div>}
            {filtered.map(i => (
              <div key={i.id} onClick={() => { onChange(i.id); setOpen(false); }}
                style={{ padding: '8px 12px', cursor: 'pointer', background: i.id === value ? '#eff6ff' : undefined }}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = '#f3f4f6'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = i.id === value ? '#eff6ff' : ''; }}>
                <div style={{ fontSize: 13, fontWeight: i.id === value ? 700 : 400, color: '#111827' }}>{i.label}</div>
                {i.sub && <div style={{ fontSize: 11, color: '#9ca3af' }}>{i.sub}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 인라인 스타일 ──────────────────────────────────────────────────────────────

const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none' };
const lbl = (txt: string) => <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>{txt}</label>;
const sHd: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em', paddingBottom: 6, borderBottom: '1px solid #e5e7eb', marginBottom: 10 };
const QUOTE_TYPE_LABEL: Record<QuoteType, string> = { b2b_standard: '일반 견적서', b2c_prepaid: '차감 견적서', accumulated_batch: '누적 견적서' };

// ─── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

export interface QuoteEditorModalProps {
  token: string;
  /** null = 독립 견적서 생성, number = 기존 프로젝트에 견적 추가 */
  projectId: number | null;
  /** 기존 프로젝트의 거래처 / 담당자 */
  initialCompanyId?: number | null;
  initialContactId?: number | null;
  /** 기존 프로젝트 제목 (projectId 있을 때) */
  initialTitle?: string;
  onClose: () => void;
  /** 저장 완료 후 콜백 — { quoteId, projectId? } 전달 */
  onSaved: (result: { quoteId: number; projectId: number | null }) => void;
  onToast: (msg: string) => void;
  adminList?: AdminUser[];
}

export function QuoteEditorModal({
  token, projectId, initialCompanyId = null, initialContactId = null, initialTitle = '',
  onClose, onSaved, onToast, adminList = [],
}: QuoteEditorModalProps) {
  const authH = { Authorization: `Bearer ${token}` };

  // ── 기본 정보 ───────────────────────────────────────────────────────────────
  const [title,        setTitle]        = useState(initialTitle);
  const [titleEdited,  setTitleEdited]  = useState(!!initialTitle); // 수동 편집 여부
  const [companyId,    setCompanyId]    = useState<number | null>(initialCompanyId);
  const [contactId,    setContactId]    = useState<number | null>(initialContactId);
  const [adminId,      setAdminId]      = useState<number | null>(null);
  const [issueDate,    setIssueDate]    = useState(() => dateOffset(0));
  const [quoteType,    setQuoteType]    = useState<QuoteType>('b2b_standard');
  const [vatType,      setVatType]      = useState<VatType>('taxable');
  const [note,         setNote]         = useState('');
  const [versionReason, setVersionReason] = useState('');

  // ── 견적 항목 ───────────────────────────────────────────────────────────────
  const [items, setItems] = useState<QuoteItemForm[]>([defaultItem()]);

  // ── 참조 데이터 ─────────────────────────────────────────────────────────────
  const [companies, setCompanies] = useState<Company[]>([]);
  const [contacts,  setContacts]  = useState<Contact[]>([]);
  const [products,  setProducts]  = useState<Product[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [saving,    setSaving]    = useState(false);

  // ── 데이터 로딩 ─────────────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(api('/api/admin/companies'),  { headers: authH }).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(api('/api/admin/contacts'),   { headers: authH }).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(api('/api/admin/products'),   { headers: authH }).then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([cos, cts, prds]) => {
      setCompanies(Array.isArray(cos) ? cos : []);
      setContacts(Array.isArray(cts) ? cts : []);
      setProducts(Array.isArray(prds) ? prds.filter((p: Product) => p.active) : []);
    }).finally(() => setLoading(false));
  }, [token]);

  // ── 견적서명 자동생성: {고객사명}_{대표상품명}_{작업일자} (미편집 상태에서만) ──
  useEffect(() => {
    if (titleEdited || projectId !== null) return;
    const company = companies.find(c => c.id === companyId);
    const validItems = items.filter(it => it.productName.trim());
    if (!company || validItems.length === 0) return;
    const dateStr = issueDate.replace(/-/g, '');
    const firstName = validItems[0].productName.trim();
    setTitle(`${company.name}_${firstName}_${dateStr}`);
  }, [companyId, items, issueDate, companies, titleEdited, projectId]);

  // ── 거래처 변경 시 담당자 초기화 ─────────────────────────────────────────────
  const handleCompanyChange = (cid: number | null) => {
    setCompanyId(cid);
    setContactId(null);
    setTitleEdited(false); // 거래처 바꾸면 자동생성 재활성화
  };

  const filteredContacts = contactId !== null || companyId === null
    ? contacts
    : contacts.filter(c => c.companyId === companyId);

  // ── 상품 검색 ───────────────────────────────────────────────────────────────
  const productOptions = products.map(p => ({
    id: p.id,
    label: p.displayName || p.name,
    sub: p.code ?? undefined,
  }));

  // ── 항목 조작 ───────────────────────────────────────────────────────────────
  const updateItem = (idx: number, patch: Partial<QuoteItemForm>) =>
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, ...patch } : it));

  const selectProduct = (idx: number, pid: number | null) => {
    const p = pid != null ? products.find(pr => pr.id === pid) : null;
    updateItem(idx, {
      productId:   p?.id ?? null,
      productName: p?.displayName || p?.name || '',
      productType: (p?.type as QuoteItemForm['productType']) ?? 'translation',
      unit: p?.defaultUnit ?? '건',
    });
  };

  const addItem    = () => setItems(prev => [...prev, defaultItem()]);
  const removeItem = (idx: number) => setItems(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);

  // ── 금액 계산 ───────────────────────────────────────────────────────────────
  const totals = calcTotals(items, vatType);

  // ── 저장 ────────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const validItems = items.filter(it => it.productName.trim() && Number(it.unitPrice.replace?.(/,/g,'') || 0) > 0);
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
      billingType:      'postpaid_per_project',
      taxDocumentType:  'tax_invoice',
      taxCategory:      'normal',
      issueDate,
      validUntil: (() => { const d = new Date(issueDate); d.setDate(d.getDate() + 30); return d.toISOString().split('T')[0]; })(),
      note: note.trim() || undefined,
    };

    setSaving(true);
    try {
      // ── 독립 견적서 생성 (프로젝트 없음) ──────────────────────────────────
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

      // ── 기존 프로젝트에 견적 추가 ──────────────────────────────────────────
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
  }, [items, projectId, title, companyId, contactId, adminId, issueDate, quoteType, vatType, note, token]);

  // ─────────────────────────────────────────────────────────────────────────────

  if (loading) return (
    <DraggableModal title="견적 작성" onClose={onClose} width={700} zIndex={600}>
      <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>데이터 불러오는 중…</div>
    </DraggableModal>
  );

  const isStandalone = projectId === null;

  return (
    <DraggableModal
      title={isStandalone ? '새 견적서 작성' : '견적 추가'}
      subtitle={isStandalone ? '거래처·상품 선택 시 견적서명이 자동 생성됩니다.' : '이 프로젝트에 새 견적을 작성합니다.'}
      onClose={onClose}
      width={780}
      zIndex={600}
      bodyPadding="20px 28px 28px"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* ── A. 기본정보 ────────────────────────────────────────────────────── */}
        <div>
          <p style={sHd}>A. 기본정보</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' }}>

            {/* 견적 유형 */}
            <div>
              {lbl('견적서 유형')}
              <ClickSelect
                value={quoteType}
                onChange={v => setQuoteType(v as QuoteType)}
                triggerStyle={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', width: '100%' }}
                options={[
                  { value: 'b2b_standard',    label: '일반 견적서',  sub: '일반 B2B 프로젝트' },
                  { value: 'b2c_prepaid',      label: '차감 견적서', sub: '기존 선입금 잔액에서 차감하는 견적' },
                  { value: 'accumulated_batch', label: '누적 견적서', sub: '월별 누적 청구' },
                ]}
              />
            </div>

            {/* 견적일 */}
            <div>
              {lbl('견적일')}
              <input type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} style={{ ...inp }} />
            </div>

            {/* 견적서명 (standalone 시에만) */}
            {isStandalone && (
              <div style={{ gridColumn: 'span 2' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  {lbl('견적서명 *')}
                  {!titleEdited && title && (
                    <span style={{ fontSize: 10, color: '#6b7280', fontStyle: 'italic' }}>자동생성됨</span>
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

            {/* 거래처 (standalone) or 표시용 (프로젝트 있을 때) */}
            {isStandalone ? (
              <div>
                {lbl('거래처')}
                <SearchableSelect
                  items={companies.map(c => ({ id: c.id, label: c.name, sub: c.divisionNames?.slice(0,2).join(' · ') }))}
                  value={companyId}
                  onChange={handleCompanyChange}
                  placeholder="회사명으로 검색…"
                  accentBorder="#6366f1"
                />
              </div>
            ) : null}

            {/* 담당자 */}
            {isStandalone && (
              <div>
                {lbl('담당자')}
                <SearchableSelect
                  items={filteredContacts.map(c => ({ id: c.id, label: c.name }))}
                  value={contactId}
                  onChange={setContactId}
                  placeholder="담당자 선택…"
                  accentBorder="#6366f1"
                />
              </div>
            )}

            {/* 담당 PM */}
            <div>
              {lbl('담당 PM')}
              <SearchableSelect
                items={adminList.map(u => ({ id: u.id, label: u.name ?? u.email }))}
                value={adminId}
                onChange={setAdminId}
                placeholder="PM 선택 (선택)"
                accentBorder="#6366f1"
              />
            </div>

            {/* 부가세 유형 */}
            <div>
              {lbl('부가세')}
              <ClickSelect
                value={vatType}
                onChange={v => setVatType(v as VatType)}
                triggerStyle={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', width: '100%' }}
                options={[
                  { value: 'taxable', label: '부가세 10%' },
                  { value: 'exempt',  label: '면세' },
                  { value: 'zero_rate', label: '영세율' },
                ]}
              />
            </div>

          </div>
        </div>

        {/* ── B. 견적 항목 ────────────────────────────────────────────────────── */}
        <div>
          <p style={sHd}>B. 견적 항목</p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  {['상품', '언어쌍 / 상품명', '단위', '수량', '단가', '공급가액', ''].map(h => (
                    <th key={h} style={{ padding: '6px 8px', fontSize: 11, fontWeight: 700, color: '#6b7280', textAlign: h === '공급가액' ? 'right' : 'left', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => {
                  const supply = calcItem(it, vatType).supply;
                  return (
                    <tr key={idx} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      {/* 상품 검색 */}
                      <td style={{ padding: '6px 8px', minWidth: 140 }}>
                        <SearchableSelect
                          items={productOptions}
                          value={it.productId}
                          onChange={pid => selectProduct(idx, pid)}
                          placeholder="상품 검색…"
                          accentBorder="#7c3aed"
                        />
                      </td>
                      {/* 언어쌍 / 상품명 */}
                      <td style={{ padding: '6px 8px', minWidth: 160 }}>
                        {it.productType === 'translation' ? (
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <input value={it.sourceLanguage} onChange={e => updateItem(idx, { sourceLanguage: e.target.value })}
                              placeholder="출발" style={{ ...inp, padding: '5px 6px', fontSize: 12, width: 60 }} />
                            <span style={{ color: '#9ca3af', fontSize: 11 }}>→</span>
                            <input value={it.targetLanguage} onChange={e => updateItem(idx, { targetLanguage: e.target.value })}
                              placeholder="도착" style={{ ...inp, padding: '5px 6px', fontSize: 12, width: 60 }} />
                          </div>
                        ) : (
                          <input value={it.productName} onChange={e => updateItem(idx, { productName: e.target.value })}
                            placeholder="상품명 직접 입력" style={{ ...inp, padding: '5px 8px', fontSize: 12 }} />
                        )}
                        {it.productType === 'translation' && (
                          <input value={it.productName} onChange={e => updateItem(idx, { productName: e.target.value })}
                            placeholder="상품명 (자동입력)" style={{ ...inp, padding: '4px 6px', fontSize: 11, marginTop: 3, color: '#6b7280' }} />
                        )}
                      </td>
                      {/* 단위 */}
                      <td style={{ padding: '6px 8px', minWidth: 70 }}>
                        <input value={it.unit} onChange={e => updateItem(idx, { unit: e.target.value })}
                          placeholder="건" style={{ ...inp, padding: '5px 6px', fontSize: 12 }} />
                      </td>
                      {/* 수량 */}
                      <td style={{ padding: '6px 8px', minWidth: 70 }}>
                        <NumericInput value={it.quantity} onChange={v => updateItem(idx, { quantity: v })}
                          placeholder="1" />
                      </td>
                      {/* 단가 */}
                      <td style={{ padding: '6px 8px', minWidth: 100 }}>
                        <NumericInput value={it.unitPrice} onChange={v => updateItem(idx, { unitPrice: v })}
                          placeholder="0" suffix="원" />
                      </td>
                      {/* 공급가액 */}
                      <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600, color: '#1e3a5f', fontSize: 12 }}>
                        {supply > 0 ? supply.toLocaleString() + '원' : '—'}
                      </td>
                      {/* 삭제 */}
                      <td style={{ padding: '6px 4px' }}>
                        <button type="button" onClick={() => removeItem(idx)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#e11d48', fontSize: 14, lineHeight: 1, padding: '2px 4px' }}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button type="button" onClick={addItem}
            style={{ marginTop: 8, fontSize: 12, color: '#6366f1', background: 'none', border: '1px dashed #c7d2fe', borderRadius: 7, padding: '5px 14px', cursor: 'pointer', fontWeight: 600 }}>
            + 항목 추가
          </button>
        </div>

        {/* ── C. 금액 요약 ────────────────────────────────────────────────────── */}
        <div style={{ background: '#f8fafc', borderRadius: 10, padding: '14px 18px', border: '1px solid #e5e7eb' }}>
          <p style={{ ...sHd, marginBottom: 10 }}>C. 금액 요약</p>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>공급가액</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#374151' }}>{totals.supply.toLocaleString()}원</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>부가세</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#374151' }}>{totals.tax.toLocaleString()}원</div>
            </div>
            <div style={{ textAlign: 'right', padding: '6px 12px', background: '#eff6ff', borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: '#2563eb', fontWeight: 700 }}>총 견적금액</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#1d4ed8' }}>{totals.total.toLocaleString()}원</div>
            </div>
          </div>
        </div>

        {/* 비고 */}
        <div>
          {lbl('비고')}
          <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="견적 관련 메모 또는 안내 사항"
            rows={2} style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }} />
        </div>

        {/* 버전 변경 사유 (projectId 있을 때만) */}
        {projectId !== null && (
          <div style={{ background: '#fffbeb', borderRadius: 8, padding: '10px 14px', border: '1px solid #fde68a' }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: '#92400e', display: 'block', marginBottom: 5 }}>
              버전 변경 사유
              <span style={{ marginLeft: 4, fontWeight: 400, color: '#b45309' }}>(저장 시 새 Version으로 기록됩니다)</span>
            </label>
            <input value={versionReason} onChange={e => setVersionReason(e.target.value)}
              placeholder="예: 최초 견적 / 일정 변경 / 금액 수정 / 고객 요청 / 장비 추가"
              style={{ ...inp, background: '#fff' }} />
          </div>
        )}

        {/* ── D. 액션 버튼 ───────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4, borderTop: '1px solid #f0f2f5' }}>
          <GhostBtn onClick={onClose} disabled={saving} style={{ fontSize: 13 }}>취소</GhostBtn>
          <button type="button" disabled={saving}
            onClick={handleSave}
            style={{ background: saving ? '#93c5fd' : '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 22px', fontSize: 14, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>
            {saving ? '저장 중…' : (isStandalone ? '견적 저장 (프로젝트 생성)' : '견적 저장')}
          </button>
        </div>

      </div>
    </DraggableModal>
  );
}
