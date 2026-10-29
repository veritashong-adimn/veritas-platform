// ─── 과거 CRM 판매건 고객 담당자 보완(검색·선택·신규 등록) ─────────────────────────────
// 판매관리 통합목록의 '고객 담당자' 칸에서 연다. 과거 CRM 원본은 바꾸지 않고 별도 연결로 저장한다(서버 /admin/sales-contact/*).
//  · 해당 거래처에 등록된 담당자만 검색·선택한다(다른 거래처 담당자·동명이인 자동 연결 없음).
//  · 신규 등록은 거래처 연결 필수, 확인된 정보만 저장(이름만도 가능). 같은 이메일·휴대전화는 기존 담당자 선택을 요구하고,
//    같은 이름은 사용자 확인 후에만 등록한다.
//  · 같은 담당자(같은 거래처·이름·원본 전화번호)의 다른 과거 판매건은 미리 보여 주고, 관리자가 고른 건만 같은 Master 에 연결한다.
//  · 다른 거래처의 같은 이름·연락처 담당자는 소속 확인용으로만 표시한다(연결·소속 이전 없음).
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/constants';
import { ModalOverlay, PrimaryBtn, GhostBtn } from '../ui';
import { SaleContactInfoPanel, fmtPhone, type ContactInfo } from './SaleContactInfoPanel';

type Contact = { id: number; name: string; position: string | null; department: string | null; phone: string | null; mobile: string | null; email: string | null };
type Ctx = {
  source: 'legacy' | 'current'; id: number; saleNo: string | null; rawCompanyName: string | null;
  company: { id: number; name: string } | null; companyMatch: string;
  contact: Contact | null; contactSource: string | null; contacts: Contact[];
  evidence?: Array<{ id: number; date: string | null; product: string | null; total: string | null; customerName: string | null; tel: string | null; method: string }>;
  restoredName?: string | null;
  contactInfo?: ContactInfo | null;
  relatedSales?: RelatedSale[];
  otherCompanyMatches?: Array<Contact & { companyId: number | null; companyName: string | null; matchedBy: string[] }>;
  linkedAt?: { at: string; by: string | null } | null;
};
type RelatedSale = { legacyRowId: number; saleNo: string; date: string | null; product: string | null; total: string | null; rawCompanyName: string | null;
  status: 'linkable' | 'linked_same' | 'linked_other' | 'company_mismatch'; currentContact: { id: number; name: string } | null };
type Conflict = { code: 'IDENTIFIER_MATCH' | 'SAME_NAME' | 'SHARED_CONTACT' | 'ALREADY_LINKED'; message: string; existing: Contact[] };
const CONFLICT_CODES = ['IDENTIFIER_MATCH', 'SAME_NAME', 'SHARED_CONTACT', 'ALREADY_LINKED'];
const RELATED_LABEL: Record<RelatedSale['status'], string> = { linkable: '연결 가능', linked_same: '이미 연결됨', linked_other: '다른 담당자 연결', company_mismatch: '거래처 불일치' };
const MATCH_LABEL: Record<string, string> = { name: '이름', phone: '전화번호', email: '이메일' };
const fmtDateTime = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? iso : d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); };

const inp: React.CSSProperties = { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, width: '100%', boxSizing: 'border-box' };
const contactLine = (c: Contact) => [c.position, c.department, fmtPhone(c.phone), fmtPhone(c.mobile), c.email].filter(Boolean).join(' · ') || '연락처 정보 없음';

export function SaleContactPicker({ source, id, authHeaders, onClose, onSaved }: {
  source: 'legacy' | 'current'; id: number; authHeaders: Record<string, string>;
  onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<'select' | 'create'>('select');
  const [form, setForm] = useState({ name: '', position: '', department: '', phone: '', mobile: '', email: '' });
  const [conflict, setConflict] = useState<Conflict | null>(null);
  // 거래처가 원본명으로 확정되지 않은 판매(미일치·후보 복수) — 사용자가 거래처를 직접 고른다
  const [companyQuery, setCompanyQuery] = useState('');
  const [companyHits, setCompanyHits] = useState<Array<{ id: number; name: string }>>([]);
  const [pickedCompany, setPickedCompany] = useState<{ id: number; name: string } | null>(null);
  const [pickedContacts, setPickedContacts] = useState<Contact[]>([]);
  // 연결 후에도 창을 유지해 관련 판매건을 이어서 연결할 수 있게 한다 — 닫을 때 목록을 갱신하도록 마지막 결과 메시지를 기억
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [relatedPick, setRelatedPick] = useState<Set<string>>(new Set());

  const jsonH = { ...authHeaders, 'Content-Type': 'application/json' };

  const loadCtx = () => fetch(api(`/api/admin/sales-contact/context?source=${source}&id=${id}`), { headers: authHeaders })
      .then(async r => {
        const d = await r.json(); if (!r.ok) throw new Error(d?.error || '조회 실패'); setCtx(d);
        // 연결 가능한 관련 판매건은 기본 선택(실행은 관리자가 버튼으로 확정)
        setRelatedPick(new Set((d.relatedSales ?? []).filter((x: RelatedSale) => x.status === 'linkable').map((x: RelatedSale) => x.saleNo)));
        return d as Ctx;
      });

  useEffect(() => {
    loadCtx()
      .then(d => {
        if (d.restoredName && !d.contact) {
          setFilter(d.restoredName);
          // 신규 등록 자동 입력 — 복원 이름, 원본 개인번호(공용·대표번호 제외)
          const ci = d.contactInfo; const own = (ci?.sourcePhones ?? []).filter((p: any) => !p.shared && p.type !== 'unknown');
          const mob = own.find((p: any) => p.type === 'mobile'); const tel = own.find((p: any) => p.type !== 'mobile');
          // 이메일: 원본 이메일 → 거래처 이메일(업무용 — 여러 담당자 공유 허용) 자동 입력
          setForm({ name: d.restoredName, position: '', department: '', phone: tel?.raw ?? '', mobile: mob?.raw ?? '', email: ci?.sourceEmails?.[0] ?? ci?.companyEmail ?? '' });
          if (!(d.contacts ?? []).length && d.company) setMode('create');   // 거래처에 등록된 담당자가 없으면 신규 등록 화면부터
        }
      })
      .catch(e => setError(e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const company = ctx?.company ?? pickedCompany;
  const contacts = ctx?.company ? ctx.contacts : pickedContacts;
  const shown = useMemo(() => {
    const k = filter.replace(/\s/g, '').toLowerCase();
    return k ? contacts.filter(c => [c.name, c.email, c.mobile, c.phone, c.department].some(v => (v ?? '').replace(/\s/g, '').toLowerCase().includes(k))) : contacts;
  }, [contacts, filter]);

  const searchCompany = async () => {
    if (!companyQuery.trim()) return;
    const r = await fetch(api(`/api/admin/companies?search=${encodeURIComponent(companyQuery.trim())}`), { headers: authHeaders });
    const d = await r.json().catch(() => []);
    const list = Array.isArray(d) ? d : (d?.data ?? d?.rows ?? []);
    setCompanyHits(list.slice(0, 20).map((c: any) => ({ id: c.id, name: c.name })));
  };
  const pickCompany = async (c: { id: number; name: string }) => {
    setPickedCompany(c); setCompanyHits([]);
    const r = await fetch(api(`/api/admin/contacts?companyId=${c.id}`), { headers: authHeaders });
    const d = await r.json().catch(() => []);
    const list = Array.isArray(d) ? d : (d?.data ?? d?.rows ?? []);
    setPickedContacts(list.filter((x: any) => !x.deletedAt && x.isActive !== false));
  };

  const post = async (path: string, body: Record<string, unknown>) => {
    setBusy(true); setError(''); setConflict(null);
    try {
      const r = await fetch(api(path), { method: 'POST', headers: jsonH, body: JSON.stringify({ source, id, companyId: company?.id, ...body }) });
      const d = await r.json().catch(() => ({}));
      if (r.status === 409 && CONFLICT_CODES.includes(d.code)) { setConflict({ code: d.code, message: d.error, existing: d.existing ?? [] }); return; }
      if (!r.ok) throw new Error(d?.error || '저장 실패');
      const msg = d.changed === false ? '이미 연결된 담당자입니다.' : `고객 담당자 '${d.contact?.name}'을(를) ${d.created ? '등록하고 ' : ''}연결했습니다.`;
      // 같은 담당자의 연결 가능한 다른 판매건이 있으면 창을 유지해 이어서 확인·연결한다
      const next = await loadCtx().catch(() => null);
      if (next?.relatedSales?.some(x => x.status === 'linkable')) { setSavedMsg(msg); setMode('select'); setFilter(''); }
      else onSaved(msg);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const link = (contactId: number) => post('/api/admin/sales-contact/link', { contactId });
  const linkRelated = async () => {
    if (!ctx?.contact || relatedPick.size === 0) return;
    setBusy(true); setError('');
    try {
      const r = await fetch(api('/api/admin/sales-contact/link-related'), { method: 'POST', headers: jsonH,
        body: JSON.stringify({ source, id, contactId: ctx.contact.id, saleNos: [...relatedPick] }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || '관련 판매건 연결 실패');
      onSaved(`관련 판매건 ${d.linked?.length ?? 0}건을 '${ctx.contact.name}' 담당자에 연결했습니다.${d.skipped?.length ? ` (${d.skipped.length}건 제외)` : ''}`);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const close = () => (savedMsg ? onSaved(savedMsg) : onClose());
  const [confirmed, setConfirmed] = useState({ sameName: false, shared: false });
  const create = (c: Partial<typeof confirmed> = {}) => {
    const next = { ...confirmed, ...c }; setConfirmed(next);
    return post('/api/admin/sales-contact/create', { ...form, confirmSameName: next.sameName, confirmShared: next.shared });
  };

  const field = (k: keyof typeof form, label: string, required = false) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#374151' }}>
      <span>{label}{required && <b style={{ color: '#dc2626' }}> *</b>}</span>
      <input value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} style={inp}
        aria-label={label} data-testid={`sale-contact-new-${k}`} />
    </label>
  );

  return (
    <ModalOverlay onClose={busy ? undefined : close} maxWidth={620}>
      <div data-testid="sale-contact-picker">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: '#111827' }}>고객 담당자 보완</span>
          {ctx?.saleNo && <span style={{ fontSize: 12, color: '#6b7280' }}>판매번호 {ctx.saleNo}</span>}
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: '#6b7280' }}>과거 CRM 원본은 변경하지 않고 담당자 연결만 저장합니다. 기존 견적서 수신자는 자동으로 바뀌지 않습니다.</p>

        {!ctx && !error && <div style={{ padding: 20, color: '#6b7280', fontSize: 13 }}>불러오는 중…</div>}
        {error && <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#991b1b', fontSize: 13, marginBottom: 10 }} data-testid="sale-contact-error">{error}</div>}

        {savedMsg && <div style={{ padding: '8px 12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, color: '#166534', fontSize: 13, marginBottom: 10 }} data-testid="sale-contact-saved">{savedMsg}</div>}

        {ctx && (
          <>
            {/* Master 연결 상태 — 연결된 담당자·거래처·Master ID·연결 일시 */}
            <div style={{ marginBottom: 10, padding: '7px 10px', borderRadius: 8, fontSize: 12, background: ctx.contact ? '#eff6ff' : '#f9fafb', border: `1px solid ${ctx.contact ? '#bfdbfe' : '#e5e7eb'}` }} data-testid="sale-contact-link-status">
              {ctx.contact
                ? <><b style={{ color: '#1d4ed8' }}>연결 완료</b> · <b>{ctx.contact.name}</b> · {company?.name ?? '-'} · Master #{ctx.contact.id}
                    {ctx.linkedAt && <span style={{ color: '#6b7280' }}> · 연결 {fmtDateTime(ctx.linkedAt.at)}{ctx.linkedAt.by ? ` (${ctx.linkedAt.by})` : ''}</span>}</>
                : <><b style={{ color: '#6b7280' }}>미연결</b> <span style={{ color: '#6b7280' }}>— 담당자 Master 와 연결되지 않았습니다.</span></>}
            </div>

            {/* 연락처(출처 구분) — 판매 당시 원본 번호와 현재 Master 연락처를 나눠 표시 */}
            <div style={{ marginBottom: 12, padding: 10, border: '1px solid #e5e7eb', borderRadius: 8 }}>
              {ctx.contactInfo
                ? <SaleContactInfoPanel companyName={company?.name ?? ctx.rawCompanyName} info={ctx.contactInfo} />
                : <div style={{ fontSize: 13 }}>거래처 <b>{company?.name ?? ctx.rawCompanyName ?? '-'}</b> · 현재 담당자 {ctx.contact?.name ?? '-'}</div>}
              {!company && (
                <div style={{ marginTop: 6, fontSize: 12, color: '#b45309' }} data-testid="sale-contact-company">
                  거래처 확정 필요 — 원본 거래처명 '{ctx.rawCompanyName ?? '-'}'{ctx.companyMatch === 'ambiguous' ? '(후보 여러 곳)' : '(일치 거래처 없음)'}
                </div>
              )}
              {/* 연결 후보: 같은 거래처 동명 1명이지만 번호로 확인되지 않음 — 직원이 확인 후 명시적으로 연결 */}
              {!ctx.contact && ctx.contactInfo?.candidate && (
                <div style={{ marginTop: 8, padding: 8, background: '#f8fafc', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }} data-testid="sale-contact-candidate">
                  <span style={{ flex: 1 }}>
                    연결 후보: <b>{ctx.contactInfo.candidate.name}</b> (같은 거래처 동명 1명 — 번호가 일치하지 않거나 대조할 번호 없음)
                    <span style={{ color: '#6b7280' }}> · {[fmtPhone(ctx.contactInfo.candidate.mobile), fmtPhone(ctx.contactInfo.candidate.phone || ctx.contactInfo.candidate.officePhone), ctx.contactInfo.candidate.email].filter(Boolean).join(' · ') || '연락처 없음'}</span>
                  </span>
                  <PrimaryBtn onClick={() => link(ctx.contactInfo!.candidate!.id)} disabled={busy} style={{ fontSize: 12, padding: '4px 10px' }}
                    data-testid="btn-sale-contact-link-candidate" aria-label="연결 후보 확인 후 연결">확인 후 연결</PrimaryBtn>
                </div>
              )}
            </div>

            {/* 진행관리표 근거 — 복원 고객명과 원본 연락처(이 값으로만 신규 등록을 채운다) */}
            {!!ctx.evidence?.length && (
              <details style={{ marginBottom: 12, fontSize: 12 }} open={!ctx.contact} data-testid="sale-contact-evidence">
                <summary style={{ cursor: 'pointer', color: '#374151' }}>
                  진행관리표 근거 {ctx.evidence.length}행{ctx.restoredName ? <> — 복원 고객명 <b>{ctx.restoredName}</b>{ctx.contact ? '' : ' (담당자 Master 미연결)'}</> : ''}
                </summary>
                <div style={{ marginTop: 6, border: '1px solid #e5e7eb', borderRadius: 8 }}>
                  {ctx.evidence.map(e => (
                    <div key={e.id} style={{ display: 'flex', gap: 10, padding: '5px 8px', borderBottom: '1px solid #f3f4f6', color: '#4b5563' }}>
                      <span style={{ minWidth: 78 }}>{e.date ?? '-'}</span><span style={{ flex: 1 }}>{e.product ?? '-'}</span>
                      <span>{e.total ?? '-'}</span><b style={{ color: '#111827' }}>{e.customerName ?? '-'}</b><span>{e.tel ?? '-'}</span>
                    </div>
                  ))}
                </div>
                {ctx.restoredName && company && (
                  <GhostBtn onClick={() => {
                    const tel = (ctx.evidence ?? []).find(e => e.customerName === ctx.restoredName && e.tel)?.tel ?? '';
                    const isMobile = /^01[0-9]/.test(tel.replace(/\D/g, ''));
                    setForm({ name: ctx.restoredName!, position: '', department: '', phone: isMobile ? '' : tel, mobile: isMobile ? tel : '', email: '' });
                    setMode('create');
                  }} style={{ marginTop: 6, fontSize: 12, padding: '4px 10px' }} data-testid="btn-sale-contact-prefill" aria-label="원본 고객명으로 신규 등록 준비">
                    원본 고객명·연락처로 신규 등록 준비
                  </GhostBtn>
                )}
              </details>
            )}

            {/* 같은 담당자의 다른 과거 판매건 — 같은 거래처·이름·원본 전화번호가 모두 일치하는 건만. 관리자가 고른 건만 연결 */}
            {!!ctx.relatedSales?.length && (
              <div style={{ marginBottom: 12, padding: 10, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12 }} data-testid="sale-contact-related">
                <div style={{ fontWeight: 700, color: '#374151', marginBottom: 6 }}>
                  같은 담당자의 다른 판매건 {ctx.relatedSales.length}건 <span style={{ fontWeight: 400, color: '#6b7280' }}>(같은 거래처 · 이름 · 원본 전화번호 일치)</span>
                </div>
                {ctx.relatedSales.map(x => {
                  const selectable = x.status === 'linkable' && !!ctx.contact;
                  return (
                    <label key={x.saleNo} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px', borderBottom: '1px solid #f3f4f6', color: x.status === 'linkable' ? '#374151' : '#9ca3af' }}>
                      <input type="checkbox" disabled={!selectable || busy} checked={selectable && relatedPick.has(x.saleNo)}
                        onChange={e => setRelatedPick(prev => { const n = new Set(prev); if (e.target.checked) n.add(x.saleNo); else n.delete(x.saleNo); return n; })}
                        data-testid={`sale-contact-related-${x.saleNo}`} aria-label={`관련 판매건 ${x.saleNo} 선택`} />
                      <span style={{ minWidth: 112 }}>{x.saleNo}</span><span style={{ flex: 1 }}>{x.product ?? '-'}</span><span>{x.total ?? '-'}</span>
                      <span style={{ minWidth: 92, textAlign: 'right' }}>{RELATED_LABEL[x.status]}{x.status === 'linked_other' && x.currentContact ? ` (${x.currentContact.name})` : ''}</span>
                    </label>
                  );
                })}
                {ctx.contact
                  ? <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                      <PrimaryBtn onClick={linkRelated} disabled={busy || relatedPick.size === 0} style={{ fontSize: 12, padding: '5px 10px' }}
                        data-testid="btn-sale-contact-link-related" aria-label="선택한 관련 판매건 연결">선택한 {relatedPick.size}건을 {ctx.contact.name}에 연결</PrimaryBtn>
                    </div>
                  : <div style={{ marginTop: 6, color: '#6b7280' }}>이 판매건의 담당자를 먼저 연결하면 위 판매건을 같은 담당자에 함께 연결할 수 있습니다.</div>}
              </div>
            )}

            {/* 다른 거래처의 중복 후보 — 소속 확인용 표시만(자동 연결·소속 이전 없음) */}
            {!!ctx.otherCompanyMatches?.length && (
              <div style={{ marginBottom: 12, padding: 10, border: '1px solid #fde68a', background: '#fffbeb', borderRadius: 8, fontSize: 12 }} data-testid="sale-contact-other-company">
                <div style={{ fontWeight: 700, color: '#92400e', marginBottom: 4 }}>다른 거래처에 비슷한 담당자가 있습니다 — 같은 사람인지 소속을 확인하세요(자동 연결·이전하지 않음)</div>
                {ctx.otherCompanyMatches.map(c => (
                  <div key={c.id} style={{ padding: '3px 0', color: '#374151' }}>
                    <b>{c.name}</b> · {c.companyName ?? '거래처 없음'} · Master #{c.id} <span style={{ color: '#6b7280' }}>— {c.matchedBy.map(m => MATCH_LABEL[m] ?? m).join('·')} 일치 · {contactLine(c)}</span>
                  </div>
                ))}
              </div>
            )}

            {!company && (
              <div style={{ border: '1px solid #fde68a', background: '#fffbeb', borderRadius: 8, padding: 10, marginBottom: 12 }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input value={companyQuery} onChange={e => setCompanyQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') searchCompany(); }}
                    placeholder="거래처 검색" style={inp} aria-label="거래처 검색" data-testid="sale-contact-company-search" />
                  <GhostBtn onClick={searchCompany} data-testid="btn-sale-contact-company-search" aria-label="거래처 검색 실행">검색</GhostBtn>
                </div>
                {companyHits.map(c => (
                  <button key={c.id} type="button" onClick={() => pickCompany(c)} data-testid={`sale-contact-company-${c.id}`} aria-label={`거래처 ${c.name} 선택`}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', border: 'none', borderBottom: '1px solid #fef3c7', background: 'none', cursor: 'pointer', fontSize: 13 }}>{c.name}</button>
                ))}
              </div>
            )}

            {company && (
              <>
                <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                  <GhostBtn onClick={() => setMode('select')} style={mode === 'select' ? { background: '#eff6ff', color: '#1d4ed8' } : undefined}
                    data-testid="btn-sale-contact-mode-select" aria-label="기존 담당자 선택">기존 담당자 선택 ({contacts.length})</GhostBtn>
                  <GhostBtn onClick={() => setMode('create')} style={mode === 'create' ? { background: '#eff6ff', color: '#1d4ed8' } : undefined}
                    data-testid="btn-sale-contact-mode-create" aria-label="신규 담당자 등록">+ 신규 등록</GhostBtn>
                </div>

                {mode === 'select' && (
                  <>
                    <input value={filter} onChange={e => setFilter(e.target.value)} placeholder={`${company.name} 담당자 검색 (이름·이메일·전화)`}
                      style={{ ...inp, marginBottom: 6 }} aria-label="담당자 검색" data-testid="sale-contact-filter" />
                    <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
                      {shown.map(c => (
                        <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid #f3f4f6' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700 }}>{c.name}</div>
                            <div style={{ fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contactLine(c)}</div>
                          </div>
                          <PrimaryBtn onClick={() => link(c.id)} disabled={busy || ctx.contact?.id === c.id} style={{ fontSize: 12, padding: '5px 10px' }}
                            data-testid={`btn-sale-contact-link-${c.id}`} aria-label={`${c.name} 연결`}>{ctx.contact?.id === c.id ? '연결됨' : '연결'}</PrimaryBtn>
                        </div>
                      ))}
                      {shown.length === 0 && <div style={{ padding: 16, fontSize: 13, color: '#9ca3af', textAlign: 'center' }}>
                        {contacts.length && filter.trim() ? `'${filter.trim()}'과(와) 일치하는 담당자가 없습니다(거래처 담당자 ${contacts.length}명). 검색어를 지우거나 신규 등록을 이용하세요.` : '등록된 담당자가 없습니다. 신규 등록을 이용하세요.'}
                      </div>}
                    </div>
                  </>
                )}

                {mode === 'create' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {field('name', '담당자명', true)}{field('position', '직함')}
                    {field('department', '부서')}{field('phone', '전화번호')}
                    {field('mobile', '휴대전화')}{field('email', '이메일')}
                    <div style={{ gridColumn: 'span 2', fontSize: 12, color: '#6b7280' }}>
                      복원된 이름·연락처·이메일이 자동 입력됩니다. 거래처: <b>{company.name}</b>
                    </div>
                    <div style={{ gridColumn: 'span 2', display: 'flex', justifyContent: 'flex-end' }}>
                      <PrimaryBtn onClick={() => create()} disabled={busy || !form.name.trim()} data-testid="btn-sale-contact-create" aria-label="담당자 등록 후 연결">{busy ? '저장 중…' : '등록 후 연결'}</PrimaryBtn>
                    </div>
                  </div>
                )}

                {conflict && (
                  <div style={{ marginTop: 10, padding: 10, border: '1px solid #fde68a', background: '#fffbeb', borderRadius: 8, fontSize: 13 }} data-testid={`sale-contact-conflict-${conflict.code}`}>
                    <div style={{ color: '#92400e', fontWeight: 700, marginBottom: 6 }}>{conflict.message}</div>
                    {conflict.existing.map(c => (
                      <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                        <span style={{ flex: 1 }}><b>{c.name}</b> <span style={{ color: '#6b7280', fontSize: 12 }}>{contactLine(c)}</span></span>
                        <GhostBtn onClick={() => link(c.id)} disabled={busy} style={{ fontSize: 12, padding: '4px 8px' }}
                          data-testid={`btn-sale-contact-use-existing-${c.id}`} aria-label={`기존 담당자 ${c.name} 연결`}>이 담당자 연결</GhostBtn>
                      </div>
                    ))}
                    {conflict.code === 'SAME_NAME' && (
                      <div style={{ marginTop: 6, display: 'flex', justifyContent: 'flex-end' }}>
                        <GhostBtn onClick={() => create({ sameName: true })} disabled={busy} data-testid="btn-sale-contact-create-confirm" aria-label="다른 사람으로 확인하고 등록">다른 사람입니다 — 신규 등록</GhostBtn>
                      </div>
                    )}
                    {conflict.code === 'SHARED_CONTACT' && (
                      <div style={{ marginTop: 6, display: 'flex', justifyContent: 'flex-end' }}>
                        <GhostBtn onClick={() => create({ shared: true })} disabled={busy} data-testid="btn-sale-contact-create-shared" aria-label="공유 연락처 확인 후 등록">공유 연락처입니다 — 신규 등록</GhostBtn>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <GhostBtn onClick={close} disabled={busy} data-testid="btn-sale-contact-close" aria-label="닫기">닫기</GhostBtn>
        </div>
      </div>
    </ModalOverlay>
  );
}
