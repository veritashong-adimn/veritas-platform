// ─── 판매관리 '미연결 관리' — 과거 CRM 판매 거래처·담당자 미연결 통합관리 ─────────────────────────────
// 서버: /api/admin/legacy-party/* (routes/legacyPartyManage.ts). 상태는 공통 연결 로직(planPartyLinks)의 현재 DB 기준 판정.
//  · 자동 연결 없음 — 직원이 대상 판매와 변경 전후를 확인하고 [연결 실행]을 눌렀을 때만 변경.
//  · 거래처 검색은 기존 거래처 목록 API(/api/admin/companies), 단건 담당자 검색·신규 등록은 기존 담당자 보완 팝업(SaleContactPicker) 재사용.
//  · 과거 CRM 미전환 판매의 거래처 연결은 '원본 거래처 표기'에 묶여 같은 표기의 판매가 함께 연결된다(대상 판매번호 표시).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/constants';
import { ModalOverlay, PrimaryBtn, GhostBtn } from '../ui';
import { Pagination } from '../ui/Paginator';
import { SaleContactPicker } from './SaleContactPicker';
import { fmtPhone } from './SaleContactInfoPanel';

type Status = 'company_missing' | 'contact_missing' | 'contact_conflict' | 'name_check' | 'individual_review' | 'linked';
type Row = {
  key: string; source: 'legacy' | 'current' | 'platform'; saleNo: string | null; saleRowId: number | null; projectId: number | null;
  saleDate: string | null; product: string | null; total: number | null; rawCompany: string | null;
  company: { id: number | null; name: string | null; brn: string | null; customerType: string | null; via: string | null };
  customerName: string | null; sourcePhones: string[]; sourceEmail: string | null;
  contact: { id: number; name: string; check: string } | null; proposal: { contactId: number; name: string; basis: string; why: string } | null;
  status: Status; detail: string; watchNote: string | null; sameRawCount: number; editable: boolean;
};
type Summary = { legacyTotal: number; legacyByStatus: Record<Status, number>; platformByStatus: Record<Status, number>; watch: number; labels: Record<Status, string> };
type ItemResult = { saleNo: string; ok: boolean; result: string; message?: string; affectedSaleNos?: string[] };
type CompanyHit = { id: number; name: string; businessNumber: string | null; representativeName: string | null; phone: string | null; mobile: string | null; email: string | null; customerType: string | null; contactCount: number };

const STATUS_ORDER: Status[] = ['company_missing', 'contact_missing', 'contact_conflict', 'name_check', 'individual_review', 'linked'];
const STATUS_COLOR: Record<Status, string> = { company_missing: '#b91c1c', contact_missing: '#b45309', contact_conflict: '#7c3aed', name_check: '#0369a1', individual_review: '#be185d', linked: '#15803d' };
const inp: React.CSSProperties = { padding: '6px 9px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' };
const th: React.CSSProperties = { padding: '7px 8px', textAlign: 'left', fontSize: 12, color: '#6b7280', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap', background: '#f9fafb' };
const td: React.CSSProperties = { padding: '7px 8px', fontSize: 12.5, borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' };
const won = (n: number | null) => (n == null ? '-' : Math.round(n).toLocaleString());
const stripIndividual = (raw: string) => {
  const m = /^\s*(개인고객|개인 고객|개인)\s*[(（]\s*(.+?)\s*[)）]\s*$/.exec(raw) ?? /^\s*(.+?)\s*[(（]\s*(개인고객|개인 고객|개인)\s*[)）]\s*$/.exec(raw);
  return m ? { name: (m[2] && !/^(개인|개인고객|개인 고객)$/.test(m[2]) ? m[2] : m[1]).replace(/\s*(고객님|고객|님)$/, '').trim(), individual: true } : { name: raw.trim(), individual: false };
};

function ResultBox({ results, onClose }: { results: ItemResult[]; onClose: () => void }) {
  const ok = results.filter(r => r.ok).length, ng = results.length - ok;
  return (
    <div data-testid="lpm-result" style={{ marginTop: 10, padding: 10, borderRadius: 8, background: ng ? '#fffbeb' : '#f0fdf4', border: `1px solid ${ng ? '#fde68a' : '#bbf7d0'}`, fontSize: 12.5 }}>
      <b>처리 결과: 성공 {ok}건 · 실패(보류) {ng}건</b>
      {results.filter(r => !r.ok).map(r => <div key={r.saleNo} style={{ color: '#92400e' }}>· {r.saleNo}: {r.message}</div>)}
      {results.some(r => r.affectedSaleNos && r.affectedSaleNos.length > 1) && <div style={{ color: '#374151' }}>같은 원본 표기 판매도 함께 연결됨: {[...new Set(results.flatMap(r => r.affectedSaleNos ?? []))].length}건</div>}
      <div style={{ marginTop: 6 }}><GhostBtn onClick={onClose} style={{ fontSize: 12, padding: '4px 10px' }} data-testid="btn-lpm-result-close" aria-label="결과 닫기">닫기</GhostBtn></div>
    </div>
  );
}

// ── 거래처 연결·신규 등록 ──────────────────────────────────────────────────────
function CompanyDialog({ targets, authHeaders, onClose, onDone }: { targets: Row[]; authHeaders: Record<string, string>; onClose: () => void; onDone: () => void }) {
  const raws = [...new Map(targets.map(t => [t.rawCompany ?? '', t])).values()];
  const first = stripIndividual(raws[0]?.rawCompany ?? '');
  const [query, setQuery] = useState(first.name);
  const [hits, setHits] = useState<CompanyHit[]>([]);
  const [picked, setPicked] = useState<CompanyHit | null>(null);
  const [mode, setMode] = useState<'search' | 'create'>('search');
  const firstPhone = targets.flatMap(t => t.sourcePhones)[0] ?? '';
  const [form, setForm] = useState({ name: first.name, customerType: first.individual ? 'INDIVIDUAL' : 'CORPORATE', businessNumber: '', phone: '', mobile: first.individual && /^01/.test(firstPhone) ? firstPhone : '', email: '' });
  const [dups, setDups] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [results, setResults] = useState<ItemResult[] | null>(null);
  const jsonH = { ...authHeaders, 'Content-Type': 'application/json' };
  const saleNos = targets.map(t => t.saleNo!).filter(Boolean);
  const affected = raws.reduce((n, r) => n + (r.source === 'legacy' ? r.sameRawCount : 1), 0);

  const search = async () => {
    setErr(''); if (!query.trim()) return;
    const r = await fetch(api(`/api/admin/companies?search=${encodeURIComponent(query.trim())}&page=1&pageSize=20`), { headers: authHeaders });
    const d = await r.json().catch(() => ({})); if (!r.ok) { setErr(d?.error ?? '검색 실패'); return; }
    setHits(d.rows ?? []);
  };
  useEffect(() => { search(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const link = async () => {
    if (!picked || busy) return;
    if (!window.confirm(`판매 ${saleNos.length}건(같은 원본 표기 포함 약 ${affected}건)을 '${picked.name}'(#${picked.id})에 연결합니다. 계속할까요?`)) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch(api('/api/admin/legacy-party/link-company'), { method: 'POST', headers: jsonH, body: JSON.stringify({ companyId: picked.id, saleNos }) });
      const d = await r.json().catch(() => ({})); if (!r.ok) { setErr(d?.error ?? '연결 실패'); return; }
      setResults(d.results); onDone();
    } finally { setBusy(false); }
  };
  const create = async (confirmDuplicate = false) => {
    if (busy) return; setBusy(true); setErr('');
    try {
      const r = await fetch(api('/api/admin/legacy-party/create-company'), { method: 'POST', headers: jsonH, body: JSON.stringify({ ...form, saleNos, confirmDuplicate }) });
      const d = await r.json().catch(() => ({}));
      if (r.status === 409 && d.code === 'POSSIBLE_DUPLICATE') { setDups(d.duplicates ?? []); setErr(d.error); return; }
      if (!r.ok) { setErr(d?.error ?? '등록 실패'); if (d.duplicates) setDups(d.duplicates); return; }
      setResults(d.results); onDone();
    } finally { setBusy(false); }
  };

  return (
    <ModalOverlay onClose={onClose} maxWidth={980}>
      <div style={{ padding: 18 }} data-testid="lpm-company-dialog">
        <h3 style={{ margin: '0 0 10px', fontSize: 16 }}>거래처 연결 · 신규 등록</h3>
        <div style={{ fontSize: 12.5, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 10 }}>
          <div><b>대상 판매 {saleNos.length}건</b>: {saleNos.join(', ')}</div>
          {raws.map(r => <div key={r.key}>CRM 원본 거래처명 <b>'{r.rawCompany}'</b>{r.source === 'legacy' ? ` — 같은 표기 판매 ${r.sameRawCount}건이 함께 연결됨` : ' — 운영 전환 판매(이 판매만)'}</div>)}
          <div>CRM 고객: {[...new Set(targets.map(t => `${t.customerName ?? '-'}${t.sourcePhones.length ? ` ${t.sourcePhones.map(fmtPhone).join('·')}` : ''}${t.sourceEmail ? ` ${t.sourceEmail}` : ''}`))].join(' / ')}</div>
          <div style={{ color: '#6b7280' }}>이름이 같거나 비슷하다는 이유만으로 연결하지 마세요. 사업자번호·담당자·연락처를 비교해 같은 거래처일 때만 연결합니다.</div>
        </div>
        <div style={{ display: 'flex', gap: 6, margin: '10px 0' }}>
          {(['search', 'create'] as const).map(m => <GhostBtn key={m} onClick={() => setMode(m)} style={{ fontSize: 12, padding: '5px 10px', ...(mode === m ? { borderColor: '#0ea5e9', color: '#0369a1' } : {}) }}
            data-testid={`btn-lpm-mode-${m}`} aria-label={m === 'search' ? '기존 거래처 검색' : '신규 거래처 등록'}>{m === 'search' ? '기존 거래처 검색·연결' : '신규 거래처 / 개인고객 등록'}</GhostBtn>)}
        </div>
        {mode === 'search' ? (
          <>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} style={{ ...inp, flex: 1 }} placeholder="거래처명·사업자번호·전화·담당자명"
                data-testid="input-lpm-company-search" aria-label="거래처 검색어" />
              <GhostBtn onClick={search} data-testid="btn-lpm-company-search" aria-label="거래처 검색">검색</GhostBtn>
            </div>
            <div style={{ maxHeight: 300, overflow: 'auto', marginTop: 8, border: '1px solid #e5e7eb', borderRadius: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['', '기존 Master 거래처명', '유형', '사업자등록번호', '대표자', '연락처', '이메일', '담당자'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {hits.map(c => (
                    <tr key={c.id} onClick={() => setPicked(c)} style={{ cursor: 'pointer', background: picked?.id === c.id ? '#e0f2fe' : undefined }} data-testid={`lpm-company-hit-${c.id}`}>
                      <td style={td}><input type="radio" checked={picked?.id === c.id} onChange={() => setPicked(c)} aria-label={`${c.name} 선택`} /></td>
                      <td style={td}><b>{c.name}</b> <span style={{ color: '#9ca3af' }}>#{c.id}</span></td>
                      <td style={td}>{c.customerType === 'INDIVIDUAL' ? '개인고객' : c.customerType === 'PUBLIC' ? '공공' : '법인'}</td>
                      <td style={td}>{c.businessNumber || '-'}</td><td style={td}>{c.representativeName || '-'}</td>
                      <td style={td}>{[c.phone, c.mobile].filter(Boolean).map(v => fmtPhone(v)).join(' · ') || '-'}</td>
                      <td style={td}>{c.email || '-'}</td><td style={td}>{c.contactCount}</td>
                    </tr>
                  ))}
                  {!hits.length && <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: '#9ca3af' }}>검색 결과 없음</td></tr>}
                </tbody>
              </table>
            </div>
            {picked && <div style={{ fontSize: 12.5, marginTop: 8 }}>변경: <b>미연결</b> → <b>{picked.name}(#{picked.id})</b></div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 }}>
              <GhostBtn onClick={onClose} data-testid="btn-lpm-company-cancel" aria-label="닫기">닫기</GhostBtn>
              <PrimaryBtn onClick={link} disabled={!picked || busy || !!results} data-testid="btn-lpm-company-link" aria-label="거래처 연결 실행">{busy ? '처리 중…' : '연결 실행'}</PrimaryBtn>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
              <label style={{ fontSize: 12 }}>거래처명(개인은 이름)<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={{ ...inp, width: '100%' }} data-testid="input-lpm-new-name" aria-label="거래처명" /></label>
              <label style={{ fontSize: 12 }}>유형<select value={form.customerType} onChange={e => setForm({ ...form, customerType: e.target.value })} style={{ ...inp, width: '100%' }} data-testid="select-lpm-new-type" aria-label="거래처 유형">
                <option value="CORPORATE">법인·기관</option><option value="INDIVIDUAL">개인고객</option></select></label>
              <label style={{ fontSize: 12 }}>사업자등록번호<input value={form.businessNumber} onChange={e => setForm({ ...form, businessNumber: e.target.value })} style={{ ...inp, width: '100%' }} data-testid="input-lpm-new-brn" aria-label="사업자등록번호" /></label>
              <label style={{ fontSize: 12 }}>대표전화<input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} style={{ ...inp, width: '100%' }} data-testid="input-lpm-new-phone" aria-label="대표전화" /></label>
              <label style={{ fontSize: 12 }}>휴대전화<input value={form.mobile} onChange={e => setForm({ ...form, mobile: e.target.value })} style={{ ...inp, width: '100%' }} data-testid="input-lpm-new-mobile" aria-label="휴대전화" /></label>
              <label style={{ fontSize: 12 }}>이메일<input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} style={{ ...inp, width: '100%' }} data-testid="input-lpm-new-email" aria-label="이메일" /></label>
            </div>
            <div style={{ fontSize: 11.5, color: '#6b7280', marginTop: 6 }}>원본에 없는 사업자번호·대표자·주소·이메일은 확인된 값만 입력하세요. 같은 사업자번호의 거래처가 있으면 등록되지 않습니다.</div>
            {dups && dups.length > 0 && (
              <div data-testid="lpm-dups" style={{ marginTop: 8, padding: 8, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12.5 }}>
                기존 거래처 후보: {dups.map(d => `${d.name}(#${d.id}${d.businessNumber ? `, ${d.businessNumber}` : ''})`).join(', ')}
                <div style={{ marginTop: 4 }}>같은 거래처면 [기존 거래처 검색·연결]에서 연결하세요.</div>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 }}>
              <GhostBtn onClick={onClose} data-testid="btn-lpm-create-cancel" aria-label="닫기">닫기</GhostBtn>
              {dups && dups.length > 0 && <GhostBtn onClick={() => window.confirm('기존 후보와 다른 거래처임을 확인했습니까?') && create(true)} disabled={busy || !!results}
                data-testid="btn-lpm-create-confirm" aria-label="다른 거래처로 확인 후 등록">다른 거래처 — 확인 후 등록</GhostBtn>}
              <PrimaryBtn onClick={() => create(false)} disabled={busy || !form.name.trim() || !!results} data-testid="btn-lpm-create" aria-label="신규 등록 후 연결">{busy ? '처리 중…' : '등록 후 연결'}</PrimaryBtn>
            </div>
          </>
        )}
        {err && <div style={{ color: '#b91c1c', fontSize: 12.5, marginTop: 6 }} data-testid="lpm-company-error">{err}</div>}
        {results && <ResultBox results={results} onClose={onClose} />}
      </div>
    </ModalOverlay>
  );
}

// ── 담당자 일괄 연결(같은 거래처) ──────────────────────────────────────────────
function ContactDialog({ targets, authHeaders, onClose, onDone, onCreate }: { targets: Row[]; authHeaders: Record<string, string>; onClose: () => void; onDone: () => void; onCreate: (r: Row) => void }) {
  const companyId = targets[0].company.id!;
  const names = [...new Set(targets.map(t => t.customerName).filter(Boolean) as string[])];
  const tels = new Set(targets.flatMap(t => t.sourcePhones));
  const [data, setData] = useState<{ company: any; contacts: any[]; otherCompanySameName: any[] } | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [results, setResults] = useState<ItemResult[] | null>(null);
  useEffect(() => {
    fetch(api(`/api/admin/legacy-party/company-contacts?companyId=${companyId}&names=${encodeURIComponent(names.join(','))}`), { headers: authHeaders })
      .then(r => r.json().then(d => (r.ok ? setData(d) : setErr(d?.error ?? '조회 실패'))));
  }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = (s: string) => s.replace(/\s/g, '').toLowerCase();
  const digits = (v: string | null) => String(v ?? '').replace(/\D/g, '');
  const mark = (c: any) => {
    const nameHit = names.some(n => key(n).startsWith(key(c.name)) || key(c.name).startsWith(key(n)));
    const telHit = [c.phone, c.mobile, c.officePhone].map(digits).some((t: string) => t && tels.has(t));
    const mailHit = targets.some(t => t.sourceEmail && t.sourceEmail === String(c.email ?? '').toLowerCase());
    return nameHit && (telHit || mailHit) ? '이름+연락처 일치' : nameHit ? '이름만 일치(확인 필요)' : telHit ? '연락처만 일치(다른 이름)' : '';
  };
  const run = async () => {
    if (!picked || busy) return;
    const c = data?.contacts.find(x => x.id === picked);
    if (!window.confirm(`판매 ${targets.length}건의 담당자를 '${c?.name}'(#${picked})로 연결합니다. 이미 다른 담당자가 연결된 판매는 건너뜁니다. 계속할까요?`)) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch(api('/api/admin/legacy-party/link-contact'), { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ contactId: picked, saleNos: targets.map(t => t.saleNo) }) });
      const d = await r.json().catch(() => ({})); if (!r.ok) { setErr(d?.error ?? '연결 실패'); return; }
      setResults(d.results); onDone();
    } finally { setBusy(false); }
  };
  return (
    <ModalOverlay onClose={onClose} maxWidth={900}>
      <div style={{ padding: 18 }} data-testid="lpm-contact-dialog">
        <h3 style={{ margin: '0 0 10px', fontSize: 16 }}>담당자 연결 — {data?.company?.name ?? targets[0].company.name}</h3>
        <div style={{ fontSize: 12.5, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 10 }}>
          <div><b>대상 판매 {targets.length}건</b>: {targets.map(t => `${t.saleNo}${t.contact ? `(현재 ${t.contact.name})` : ''}`).join(', ')}</div>
          <div>CRM 원본 고객: {[...new Set(targets.map(t => `${t.customerName ?? '-'}${t.sourcePhones.length ? ` ${t.sourcePhones.map(fmtPhone).join('·')}` : ''}${t.sourceEmail ? ` ${t.sourceEmail}` : ''}`))].join(' / ')}</div>
          <div style={{ color: '#6b7280' }}>이 거래처 소속 담당자만 연결할 수 있습니다. 기존 담당자 정보는 바뀌지 않습니다.</div>
        </div>
        <div style={{ maxHeight: 280, overflow: 'auto', marginTop: 8, border: '1px solid #e5e7eb', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['', '담당자', '휴대전화', '일반전화', '이메일', '원본과 비교'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {(data?.contacts ?? []).map(c => (
                <tr key={c.id} onClick={() => setPicked(c.id)} style={{ cursor: 'pointer', background: picked === c.id ? '#e0f2fe' : undefined }} data-testid={`lpm-contact-${c.id}`}>
                  <td style={td}><input type="radio" checked={picked === c.id} onChange={() => setPicked(c.id)} aria-label={`${c.name} 선택`} /></td>
                  <td style={td}><b>{c.name}</b> <span style={{ color: '#9ca3af' }}>#{c.id}</span></td>
                  <td style={td}>{fmtPhone(c.mobile) || '-'}</td><td style={td}>{fmtPhone(c.phone || c.officePhone) || '-'}</td><td style={td}>{c.email || '-'}</td>
                  <td style={{ ...td, color: mark(c).startsWith('이름+') ? '#15803d' : '#92400e' }}>{mark(c)}</td>
                </tr>
              ))}
              {data && !data.contacts.length && <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: '#9ca3af' }}>등록된 담당자 없음</td></tr>}
            </tbody>
          </table>
        </div>
        {data && data.otherCompanySameName.length > 0 && (
          <div data-testid="lpm-other-same-name" style={{ marginTop: 8, padding: 8, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12.5 }}>
            ⚠ 다른 거래처의 동명이인: {data.otherCompanySameName.slice(0, 8).map(c => `${c.name}(${c.companyName}${c.mobile ? `, ${fmtPhone(c.mobile)}` : ''})`).join(', ')} — 연결 대상 아님
          </div>
        )}
        {targets.some(t => t.sourceEmail) && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>CRM 원본 이메일은 담당자 Master 에 자동 반영되지 않습니다(필요 시 담당자 정보에서 직접 보완).</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 }}>
          <GhostBtn onClick={() => onCreate(targets[0])} data-testid="btn-lpm-contact-create" aria-label="신규 담당자 등록">신규 담당자 등록(판매 {targets[0].saleNo})</GhostBtn>
          <GhostBtn onClick={onClose} data-testid="btn-lpm-contact-cancel" aria-label="닫기">닫기</GhostBtn>
          <PrimaryBtn onClick={run} disabled={!picked || busy || !!results} data-testid="btn-lpm-contact-link" aria-label="담당자 연결 실행">{busy ? '처리 중…' : '연결 실행'}</PrimaryBtn>
        </div>
        {err && <div style={{ color: '#b91c1c', fontSize: 12.5, marginTop: 6 }}>{err}</div>}
        {results && <ResultBox results={results} onClose={onClose} />}
      </div>
    </ModalOverlay>
  );
}

export function LegacyPartyManager({ authHeaders, onClose, onOpenSale }: { authHeaders: Record<string, string>; onClose: () => void; onOpenSale: (r: { source: string; saleRowId: number | null; projectId: number | null }) => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [pg, setPg] = useState({ page: 1, pageSize: 50, total: 0, totalPages: 1 });
  const [f, setF] = useState({ status: 'unlinked', company: '', contact: '', phone: '', email: '', saleNo: '', from: '', to: '' });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false); const [err, setErr] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'company' | 'contact'; targets: Row[] } | null>(null);
  const [picker, setPicker] = useState<{ source: 'legacy' | 'current'; id: number } | null>(null);

  const load = useCallback(async (page = 1, pageSize = pg.pageSize, refresh = false) => {
    setLoading(true); setErr('');
    try {
      const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
      if (refresh) p.set('refresh', '1');
      const [s, l] = await Promise.all([
        fetch(api(`/api/admin/legacy-party/summary${refresh ? '?refresh=1' : ''}`), { headers: authHeaders }).then(r => r.json()),
        fetch(api(`/api/admin/legacy-party/list?${p}`), { headers: authHeaders }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d?.error ?? '조회 실패'); return d; }),
      ]);
      setSummary(s); setRows(l.rows); setPg(l.pagination); setSel(new Set());
    } catch (e: any) { setErr(e?.message ?? '조회 실패'); }
    finally { setLoading(false); }
  }, [f, pg.pageSize, authHeaders]);
  useEffect(() => { load(1); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = useMemo(() => rows.filter(r => sel.has(r.key)), [rows, sel]);
  const selectable = (r: Row) => r.source !== 'platform' && r.editable;
  const canCompany = selected.length > 0 && selected.every(r => !r.company.id && selectable(r));
  const canContact = selected.length > 0 && selected.every(r => selectable(r) && r.company.id && r.company.customerType !== 'INDIVIDUAL') && new Set(selected.map(r => r.company.id)).size === 1;
  const setStatus = (status: string) => { setF(prev => ({ ...prev, status })); };
  useEffect(() => { load(1); }, [f.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const afterChange = () => load(pg.page, pg.pageSize, true);
  const chip = (key: string, label: string, n: number | undefined, color = '#374151') => (
    <div key={key} role="button" onClick={() => setStatus(key)} data-testid={`lpm-chip-${key}`} aria-label={`${label} 보기`}
      style={{ padding: '6px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, border: f.status === key ? `2px solid ${color}` : '1px solid #e5e7eb', color, background: f.status === key ? '#f8fafc' : '#fff' }}>
      {label} <span style={{ fontVariantNumeric: 'tabular-nums' }}>{n == null ? '…' : n.toLocaleString()}</span>
    </div>
  );
  const unlinkedTotal = summary ? STATUS_ORDER.filter(s => s !== 'linked').reduce((n, s) => n + (summary.legacyByStatus[s] ?? 0) + (summary.platformByStatus[s] ?? 0), 0) : undefined;

  return (
    <ModalOverlay onClose={onClose} maxWidth={1400}>
      <div style={{ padding: 18 }} data-testid="legacy-party-manager">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>미연결 관리 — 거래처·담당자</h2>
          <span style={{ fontSize: 12, color: '#6b7280' }}>과거 CRM {summary?.legacyTotal.toLocaleString() ?? '…'}건 · 현재 DB 연결 상태 기준(판매 1건 = 1상태)</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <GhostBtn onClick={() => load(pg.page, pg.pageSize, true)} disabled={loading} style={{ fontSize: 12, padding: '5px 10px' }} data-testid="btn-lpm-refresh" aria-label="새로고침">새로고침</GhostBtn>
            <GhostBtn onClick={onClose} style={{ fontSize: 12, padding: '5px 10px' }} data-testid="btn-lpm-close" aria-label="닫기">닫기</GhostBtn>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {chip('unlinked', '미연결 전체', unlinkedTotal, '#111827')}
          {STATUS_ORDER.map(s => chip(s, summary?.labels?.[s] ?? s, summary ? (summary.legacyByStatus[s] ?? 0) + (summary.platformByStatus[s] ?? 0) : undefined, STATUS_COLOR[s]))}
          {chip('watch', '특별 확인', summary?.watch, '#be185d')}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {([['company', '거래처명'], ['contact', '담당자명'], ['phone', '전화번호'], ['email', '이메일'], ['saleNo', '판매번호']] as const).map(([k, l]) => (
            <input key={k} value={(f as any)[k]} onChange={e => setF({ ...f, [k]: e.target.value })} onKeyDown={e => e.key === 'Enter' && load(1)} placeholder={l}
              style={{ ...inp, width: 130 }} data-testid={`input-lpm-${k}`} aria-label={l} />
          ))}
          <input type="date" value={f.from} onChange={e => setF({ ...f, from: e.target.value })} style={inp} data-testid="input-lpm-from" aria-label="기간 시작" />
          <input type="date" value={f.to} onChange={e => setF({ ...f, to: e.target.value })} style={inp} data-testid="input-lpm-to" aria-label="기간 끝" />
          <PrimaryBtn onClick={() => load(1)} disabled={loading} style={{ fontSize: 12.5, padding: '6px 14px' }} data-testid="btn-lpm-search" aria-label="검색">검색</PrimaryBtn>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, fontSize: 12.5 }}>
          <span>선택 {selected.length}건</span>
          <GhostBtn onClick={() => setDialog({ kind: 'company', targets: selected })} disabled={!canCompany} style={{ fontSize: 12, padding: '5px 10px' }}
            data-testid="btn-lpm-bulk-company" aria-label="선택 건 거래처 연결">선택 건 거래처 연결·등록</GhostBtn>
          <GhostBtn onClick={() => setDialog({ kind: 'contact', targets: selected })} disabled={!canContact} style={{ fontSize: 12, padding: '5px 10px' }}
            data-testid="btn-lpm-bulk-contact" aria-label="선택 건 담당자 연결">선택 건 담당자 연결(같은 거래처)</GhostBtn>
          <span style={{ color: '#9ca3af' }}>거래처 연결은 거래처 미연결 판매, 담당자 연결은 같은 거래처 판매만 선택할 수 있습니다.</span>
        </div>
        {err && <div style={{ color: '#b91c1c', fontSize: 12.5, marginBottom: 8 }}>{err}</div>}
        <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1200 }}>
            <thead><tr>
              <th style={th}><input type="checkbox" aria-label="전체 선택" data-testid="lpm-check-all" checked={rows.filter(selectable).length > 0 && rows.filter(selectable).every(r => sel.has(r.key))}
                onChange={e => setSel(e.target.checked ? new Set(rows.filter(selectable).map(r => r.key)) : new Set())} /></th>
              {['판매번호', '판매일', 'CRM 원본 거래처', '연결 거래처', 'CRM 고객(연락처·이메일)', '연결 담당자', '상태', '내용', '작업'].map(h => <th key={h} style={th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.key} data-testid={`lpm-row-${r.key}`} style={{ background: sel.has(r.key) ? '#f0f9ff' : undefined }}>
                  <td style={td}><input type="checkbox" disabled={!selectable(r)} checked={sel.has(r.key)} aria-label={`${r.saleNo ?? r.key} 선택`}
                    onChange={e => { const n = new Set(sel); if (e.target.checked) n.add(r.key); else n.delete(r.key); setSel(n); }} /></td>
                  <td style={td}>{r.saleNo ?? `판매 #${r.projectId}`}{r.source !== 'legacy' && <div style={{ fontSize: 10.5, color: '#92400e' }}>{r.source === 'current' ? '운영 전환' : '플랫폼 판매'}</div>}</td>
                  <td style={td}>{r.saleDate ?? '-'}</td>
                  <td style={td}>{r.rawCompany ?? '-'}{r.sameRawCount > 1 && r.source === 'legacy' && <div style={{ fontSize: 10.5, color: '#6b7280' }}>같은 표기 {r.sameRawCount}건</div>}</td>
                  <td style={td}>{r.company.name ? <>{r.company.name}{r.company.customerType === 'INDIVIDUAL' && <span style={{ color: '#be185d' }}> (개인)</span>}<div style={{ fontSize: 10.5, color: '#6b7280' }}>{r.company.brn ?? '사업자번호 없음'}</div></> : <span style={{ color: '#b91c1c' }}>미연결</span>}</td>
                  <td style={td}>{r.customerName ?? '-'}<div style={{ fontSize: 10.5, color: '#6b7280' }}>{[...r.sourcePhones.map(fmtPhone), r.sourceEmail].filter(Boolean).join(' · ')}</div></td>
                  <td style={td}>{r.contact ? <>{r.contact.name}{r.contact.check !== 'verified' && <div style={{ fontSize: 10.5, color: r.contact.check === 'conflict' ? '#7c3aed' : '#92400e' }}>{r.contact.check === 'conflict' ? '충돌' : '이름만 일치'}</div>}</> : r.proposal ? <span style={{ color: '#0369a1' }}>후보 {r.proposal.name}</span> : '-'}</td>
                  <td style={{ ...td, color: STATUS_COLOR[r.status], fontWeight: 700, whiteSpace: 'nowrap' }}>{summary?.labels?.[r.status] ?? r.status}</td>
                  <td style={{ ...td, maxWidth: 260 }}>{r.watchNote && <div style={{ color: '#be185d', fontWeight: 700 }}>★ {r.watchNote}</div>}<span style={{ color: '#6b7280' }}>{r.detail}</span></td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {selectable(r) && !r.company.id && <GhostBtn onClick={() => setDialog({ kind: 'company', targets: [r] })} style={{ fontSize: 11.5, padding: '3px 8px' }} data-testid={`btn-lpm-company-${r.key}`} aria-label="거래처 연결">거래처</GhostBtn>}
                    {selectable(r) && r.company.id && r.company.customerType !== 'INDIVIDUAL' && <GhostBtn onClick={() => setPicker({ source: r.source === 'current' ? 'current' : 'legacy', id: r.source === 'current' ? r.projectId! : r.saleRowId! })}
                      style={{ fontSize: 11.5, padding: '3px 8px', marginLeft: 4 }} data-testid={`btn-lpm-contact-${r.key}`} aria-label="담당자 연결">담당자</GhostBtn>}
                    <GhostBtn onClick={() => onOpenSale({ source: r.source, saleRowId: r.saleRowId, projectId: r.projectId })} style={{ fontSize: 11.5, padding: '3px 8px', marginLeft: 4 }} data-testid={`btn-lpm-open-${r.key}`} aria-label="판매 열기">열기</GhostBtn>
                  </td>
                </tr>
              ))}
              {!rows.length && !loading && <tr><td colSpan={10} style={{ ...td, textAlign: 'center', color: '#9ca3af', padding: 24 }}>해당하는 판매가 없습니다.</td></tr>}
              {loading && <tr><td colSpan={10} style={{ ...td, textAlign: 'center', color: '#9ca3af', padding: 24 }}>불러오는 중… (처음 조회는 전체 판정 때문에 몇 초 걸릴 수 있습니다)</td></tr>}
            </tbody>
          </table>
        </div>
        {pg.total > 0 && <Pagination idPrefix="lpm" page={pg.page} pageSize={pg.pageSize} total={pg.total} unit="건" disabled={loading}
          onPageChange={p => load(p)} onPageSizeChange={s => load(1, s)} />}
      </div>
      {dialog?.kind === 'company' && <CompanyDialog targets={dialog.targets} authHeaders={authHeaders} onClose={() => setDialog(null)} onDone={afterChange} />}
      {dialog?.kind === 'contact' && <ContactDialog targets={dialog.targets} authHeaders={authHeaders} onClose={() => setDialog(null)} onDone={afterChange}
        onCreate={r => { setDialog(null); setPicker({ source: r.source === 'current' ? 'current' : 'legacy', id: r.source === 'current' ? r.projectId! : r.saleRowId! }); }} />}
      {picker && <SaleContactPicker source={picker.source} id={picker.id} authHeaders={authHeaders} onClose={() => { setPicker(null); afterChange(); }} onSaved={() => afterChange()} />}
    </ModalOverlay>
  );
}
