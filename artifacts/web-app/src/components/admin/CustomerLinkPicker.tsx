/**
 * CustomerLinkPicker — 의뢰건 접수 시 고객(거래처/담당자) 연결 + 원문 snapshot 입력.
 *
 * 두 가지 모드:
 *  · 기존 거래처/담당자 선택 : 기존 마스터를 검색·선택하여 companyId/contactId/divisionId 연결 + 담당자 정보 자동채움
 *  · 신규 고객 입력         : 마스터 연결 없이(=null) 원문 정보만 직접 입력
 *
 * 원칙:
 *  · 검색/조회는 lib/customerSearch(기존 서버 API 래퍼)만 사용 — 새 검색 시스템 미구현.
 *  · 자동채움된 값은 화면에서 수정 가능하나, 이는 "접수 당시 snapshot"일 뿐 마스터 DB를 덮어쓰지 않는다.
 *  · 세 케이스 지원: ①기존거래처+기존담당자 ②기존거래처+신규담당자(contactId=null) ③신규거래처+신규담당자(둘 다 null)
 *  · 검색/매칭 로직은 UI 비종속(customerSearch) 이라 향후 AI 자동접수에서 재사용 가능.
 */
import React, { useEffect, useRef, useState } from 'react';
import { CompanyHit, ContactHit, searchCompanies, listCompanyContacts } from '../../lib/customerSearch';

const label: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, outline: 'none' };
const field = (w?: string): React.CSSProperties => ({ flex: w ? `0 0 ${w}` : '1 1 200px', minWidth: 160 });
const sectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 800, color: '#111827', margin: '18px 0 10px', paddingBottom: 6, borderBottom: '1px solid #eef2f7' };
const row: React.CSSProperties = { display: 'flex', gap: 12, flexWrap: 'wrap' };

/** picker 가 읽고/쓰는 폼 필드 부분집합 (InquiryFormState 의 서브셋). */
export interface CustomerLinkFields {
  customerMode: string;
  companyId: string; contactId: string; divisionId: string;
  customerCompanyName: string; department: string; contactName: string; contactPosition: string;
  contactPhone: string; contactMobile: string; contactEmail: string;
}

export function CustomerLinkPicker({ token, f, set }: {
  token: string;
  f: CustomerLinkFields;
  set: (k: keyof CustomerLinkFields, v: string) => void;
}) {
  const isNew = f.customerMode === 'new';
  const hasCompany = !!f.companyId;

  // 거래처 검색
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CompanyHit[]>([]);
  const [searched, setSearched] = useState(false);   // 검색 실행 여부(결과 없음 안내용)
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);                              // 최신 응답만 반영(레이스 가드)

  // 담당자 목록
  const [contacts, setContacts] = useState<ContactHit[]>([]);
  const [contactFilter, setContactFilter] = useState('');

  // 신규 모드 중복후보
  const [dupes, setDupes] = useState<CompanyHit[]>([]);

  // 선택된 거래처 담당자 로드
  const loadContacts = async (companyId: number) => {
    const list = await listCompanyContacts(token, companyId);
    setContacts(list);
  };
  useEffect(() => {
    if (hasCompany && contacts.length === 0) { void loadContacts(Number(f.companyId)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.companyId]);

  // 거래처 검색(디바운스)
  useEffect(() => {
    if (isNew || hasCompany) { setResults([]); return; }
    const q = query.trim();
    if (!q) { setResults([]); setSearched(false); return; }
    const my = ++seq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      const hits = await searchCompanies(token, q, 8);
      if (my !== seq.current) return;
      setResults(hits); setSearched(true); setSearching(false);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, isNew, hasCompany]);

  // 신규 모드 유사 거래처 후보(중복방지) — 기존 검색 재사용, 자동 병합은 하지 않음
  useEffect(() => {
    if (!isNew) { setDupes([]); return; }
    const q = f.customerCompanyName.trim();
    if (q.length < 2) { setDupes([]); return; }
    const my = ++seq.current;
    const t = setTimeout(async () => {
      const hits = await searchCompanies(token, q, 3);
      if (my !== seq.current) return;
      setDupes(hits);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, f.customerCompanyName]);

  const clearContactFields = () => {
    set('contactId', ''); set('divisionId', '');
    set('department', ''); set('contactName', ''); set('contactPosition', '');
    set('contactPhone', ''); set('contactMobile', ''); set('contactEmail', '');
  };

  const selectCompany = (c: CompanyHit) => {
    set('customerMode', 'existing');
    set('companyId', String(c.id));
    set('customerCompanyName', c.name ?? '');
    clearContactFields();
    setContacts([]);
    setQuery(''); setResults([]); setSearched(false); setDupes([]);
    void loadContacts(c.id);
  };

  const changeCompany = () => {
    // 거래처 재선택 — 연결 해제 후 검색 상자 복귀(회사명으로 재검색 편의).
    // 이전 담당자 연결(contactId)뿐 아니라 담당자 snapshot(이름/부서/연락처)도 함께 비워
    // 기존 담당자 정보가 새 거래처에 잘못 연결되는 것을 방지한다(요구사항 #9).
    setQuery(f.customerCompanyName);
    set('companyId', '');
    clearContactFields();
    setContacts([]); setContactFilter('');
  };

  const selectContact = (val: string) => {
    if (val === '' || val === '__new__') { // 신규 담당자(직접입력) — companyId 유지, contactId=null
      set('contactId', ''); set('divisionId', '');
      // 자동채움 값만 초기화(회사명 유지)
      set('department', ''); set('contactName', ''); set('contactPosition', '');
      set('contactPhone', ''); set('contactMobile', ''); set('contactEmail', '');
      return;
    }
    const c = contacts.find(x => String(x.id) === val);
    if (!c) return;
    set('contactId', String(c.id));
    set('divisionId', c.divisionId != null ? String(c.divisionId) : '');
    set('contactName', c.name ?? '');
    set('department', c.department ?? '');
    set('contactPosition', c.position ?? '');
    set('contactPhone', c.phone ?? c.officePhone ?? '');
    set('contactMobile', c.mobile ?? '');
    set('contactEmail', c.email ?? '');
  };

  const switchMode = (mode: 'existing' | 'new') => {
    set('customerMode', mode);
    if (mode === 'new') {
      // 마스터 연결 해제(원문 snapshot 은 유지 → 직접 수정)
      set('companyId', ''); set('contactId', ''); set('divisionId', '');
      setContacts([]); setResults([]); setSearched(false);
    }
  };

  const goNewFromEmpty = () => {
    switchMode('new');
    // 검색어를 회사명 초안으로 이어받아 접수 흐름이 끊기지 않도록 함
    if (query.trim() && !f.customerCompanyName.trim()) set('customerCompanyName', query.trim());
    setQuery(''); setResults([]); setSearched(false);
  };

  const filteredContacts = contactFilter.trim()
    ? contacts.filter(c => `${c.name ?? ''} ${c.department ?? ''} ${c.position ?? ''}`.toLowerCase().includes(contactFilter.trim().toLowerCase()))
    : contacts;

  const modeBtn = (active: boolean): React.CSSProperties => ({
    padding: '8px 18px', fontSize: 13, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
    border: active ? '1px solid #2563eb' : '1px solid #d1d5db',
    background: active ? '#2563eb' : '#fff',
    color: active ? '#fff' : '#374151',
  });

  return (
    <div>
      <div style={sectionTitle}>고객 정보</div>

      {/* 모드 토글 */}
      <div role="tablist" aria-label="고객 정보 입력 방식" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button type="button" role="tab" aria-selected={!isNew} data-testid="inq-cust-mode-existing"
          onClick={() => switchMode('existing')} style={modeBtn(!isNew)}>기존 거래처/담당자 선택</button>
        <button type="button" role="tab" aria-selected={isNew} data-testid="inq-cust-mode-new"
          onClick={() => switchMode('new')} style={modeBtn(isNew)}>신규 고객 입력</button>
      </div>

      {/* ── 기존 거래처/담당자 선택 ── */}
      {!isNew && (
        <div data-testid="inq-cust-existing">
          {!hasCompany ? (
            <div style={{ position: 'relative', marginBottom: 12 }}>
              <label style={label}>거래처 검색 <span style={{ color: '#9ca3af', fontWeight: 400 }}>(거래처명·브랜드·사업자번호·담당자·전화·이메일)</span></label>
              <input
                value={query} onChange={e => setQuery(e.target.value)} data-testid="inq-company-search"
                placeholder="예: 한국큐로베리타스" style={input} autoComplete="off" />
              {searching && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>검색 중…</div>}
              {results.length > 0 && (
                <ul data-testid="inq-company-results" style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', maxHeight: 260, overflowY: 'auto' }}>
                  {results.map(c => (
                    <li key={c.id}>
                      <button type="button" onClick={() => selectCompany(c)} data-testid={`inq-company-hit-${c.id}`}
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none', borderBottom: '1px solid #f3f4f6', background: '#fff', cursor: 'pointer', fontSize: 13 }}>
                        <span style={{ fontWeight: 700, color: '#111827' }}>{c.name}</span>
                        <span style={{ marginLeft: 8, fontSize: 12, color: '#9ca3af' }}>
                          {[c.businessNumber, c.representativeName, c.phone || c.mobile].filter(Boolean).join(' · ')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {searched && !searching && results.length === 0 && query.trim() && (
                <div data-testid="inq-company-none" style={{ marginTop: 8, padding: '12px 14px', background: '#f9fafb', border: '1px dashed #d1d5db', borderRadius: 8, fontSize: 13, color: '#6b7280' }}>
                  등록된 거래처를 찾을 수 없습니다.
                  <button type="button" onClick={goNewFromEmpty} data-testid="inq-company-none-new"
                    style={{ marginLeft: 10, padding: '5px 12px', fontSize: 12, fontWeight: 700, color: '#fff', background: '#2563eb', border: 'none', borderRadius: 6, cursor: 'pointer' }}>신규 고객으로 입력</button>
                </div>
              )}
            </div>
          ) : (
            <div style={{ marginBottom: 12 }}>
              <label style={label}>거래처</label>
              <div data-testid="inq-company-selected" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: '#1e3a8a' }}>{f.customerCompanyName || '(거래처)'}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#2563eb', marginTop: 2 }}>기존 거래처 · #{f.companyId}</div>
                </div>
                <button type="button" onClick={changeCompany} data-testid="inq-company-change"
                  style={{ padding: '6px 14px', fontSize: 12, fontWeight: 700, color: '#2563eb', background: '#fff', border: '1px solid #bfdbfe', borderRadius: 7, cursor: 'pointer' }}>변경</button>
              </div>

              {/* 담당자 선택 */}
              <div style={{ marginTop: 12 }}>
                <label style={label}>담당자</label>
                {contacts.length === 0 ? (
                  <div data-testid="inq-contact-empty" style={{ padding: '10px 14px', background: '#fffdf5', border: '1px dashed #fcd34d', borderRadius: 8, fontSize: 12, color: '#92400e' }}>
                    등록된 담당자가 없습니다. 아래에 신규 담당자 정보를 직접 입력하세요. (담당자 미연결로 접수됩니다)
                  </div>
                ) : (
                  <div style={row}>
                    {contacts.length > 6 && (
                      <div style={field('180px')}>
                        <input value={contactFilter} onChange={e => setContactFilter(e.target.value)} data-testid="inq-contact-filter" placeholder="담당자 검색" style={input} />
                      </div>
                    )}
                    <div style={field('220px')}>
                      <select value={f.contactId} onChange={e => selectContact(e.target.value)} data-testid="inq-contact-select" style={input}>
                        <option value="">담당자 선택 / 신규 담당자 직접입력</option>
                        {filteredContacts.map(c => (
                          <option key={c.id} value={c.id}>
                            {c.name}{c.position ? ` (${c.position})` : ''}{c.department ? ` · ${c.department}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 신규 모드: 유사 거래처 후보(중복 방지) ── */}
      {isNew && dupes.length > 0 && (
        <div data-testid="inq-dupe-suggest" style={{ marginBottom: 12, padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: '#92400e', marginBottom: 6 }}>유사한 기존 거래처가 있습니다</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {dupes.map(c => (
              <button key={c.id} type="button" onClick={() => selectCompany(c)} data-testid={`inq-dupe-${c.id}`}
                style={{ padding: '6px 12px', fontSize: 12, fontWeight: 700, color: '#92400e', background: '#fff', border: '1px solid #fcd34d', borderRadius: 7, cursor: 'pointer' }}>
                {c.name} <span style={{ fontWeight: 400, color: '#b45309' }}>기존 거래처 사용</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── 원문 고객정보(snapshot) — 항상 표시·수정 가능 ── */}
      <div style={row}>
        <div style={field()}><label style={label}>회사명</label><input value={f.customerCompanyName} onChange={e => set('customerCompanyName', e.target.value)} data-testid="inq-company" style={input} placeholder="예: ABC 주식회사" /></div>
        <div style={field()}><label style={label}>부서</label><input value={f.department} onChange={e => set('department', e.target.value)} data-testid="inq-dept" style={input} /></div>
        <div style={field()}><label style={label}>담당자</label><input value={f.contactName} onChange={e => set('contactName', e.target.value)} data-testid="inq-contact" style={input} placeholder="예: 김철수" /></div>
        <div style={field('140px')}><label style={label}>직함</label><input value={f.contactPosition} onChange={e => set('contactPosition', e.target.value)} data-testid="inq-position" style={input} placeholder="예: 팀장" /></div>
      </div>
      <div style={{ ...row, marginTop: 12 }}>
        <div style={field()}><label style={label}>전화번호</label><input value={f.contactPhone} onChange={e => set('contactPhone', e.target.value)} data-testid="inq-phone" style={input} /></div>
        <div style={field()}><label style={label}>휴대폰</label><input value={f.contactMobile} onChange={e => set('contactMobile', e.target.value)} data-testid="inq-mobile" style={input} /></div>
        <div style={field()}><label style={label}>이메일</label><input value={f.contactEmail} onChange={e => set('contactEmail', e.target.value)} data-testid="inq-email" style={input} /></div>
      </div>
      {hasCompany && (
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
          ※ 위 정보는 접수 당시 원문(snapshot)으로 저장됩니다. 여기서 수정해도 거래처/담당자 마스터는 변경되지 않습니다.
        </div>
      )}
    </div>
  );
}

export default CustomerLinkPicker;
