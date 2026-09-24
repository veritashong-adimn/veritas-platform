/**
 * VendorRegisterPage — 외주업체 등록 화면 (adminTab="vendor-register").
 *
 * 핵심 원칙(§3·§12): 외주업체는 company 를 복제하는 별도 회사 Master 가 아니다.
 * companies(identity SSOT)에 "외주업체 역할(is_vendor)" + vendor profile 을 additive 로 연결한다.
 *
 * 두 경로 제공:
 *   A. [기존 거래처에서 선택] — companies 검색 → 회사 선택 → 외주 역할/Profile 부여.
 *       이미 외주 역할이 있으면 중복 등록 차단.
 *   B. [신규 업체 등록] — 기존 CompanyForm(POST /admin/companies) 재사용해 company 생성
 *       (companyType=vendor → 서버가 is_vendor=true) → 이어서 외주 Profile 연결.
 *
 * 회사 생성/검색은 전부 기존 API 재사용. 계좌 지급정보는 기존 company_sensitive(/payment-account, 암호화) 재사용.
 */
import React, { useState, useCallback } from 'react';
import { api } from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn, ClickSelect } from '../ui';
import { PageHeader } from './PageHeader';
import { dsStickyPageHeader } from '../../lib/ds';
import { CompanyForm, emptyCompanyFormValues } from './CompanyForm';
import { OUTSOURCING_FIELD_OPTIONS } from './VendorManagementTab';

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #d1d5db', fontSize: 14, color: '#111827',
  outline: 'none', boxSizing: 'border-box', background: '#fff',
};
const labelStyle: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 };
const cardHead: React.CSSProperties = { padding: '10px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 8 };
const cardBar: React.CSSProperties = { width: 3, height: 18, background: '#7c3aed', borderRadius: 2, display: 'inline-block', flexShrink: 0 };
const cardTitle: React.CSSProperties = { margin: 0, fontSize: 14, fontWeight: 700, color: '#111827' };

interface SelectedCompany {
  id: number;
  name: string;
  businessNumber?: string | null;
  representativeName?: string | null;
  companyType?: string;
  isCustomer?: boolean;
}

interface CompanySearchRow {
  id: number;
  name: string;
  businessNumber?: string | null;
  representativeName?: string | null;
  companyType?: string;
  isVendor?: boolean;
  isCustomer?: boolean;
}

interface VendorRegisterPageProps {
  token: string;
  onToast: (msg: string) => void;
  hasPerm: (key: string | undefined) => boolean;
  /** 취소/완료 → 외주업체 목록으로 */
  onCancel: () => void;
  onDone: (companyId: number) => void;
  /** 유사 거래처 상세보기(CompanyForm 재사용) */
  onOpenCompany?: (id: number) => void;
}

type Path = 'existing' | 'new';
type Step = 'path' | 'company-new' | 'vendor-info';

export function VendorRegisterPage({ token, onToast, hasPerm, onCancel, onDone, onOpenCompany }: VendorRegisterPageProps) {
  const authHeaders = { Authorization: `Bearer ${token}` };

  const [path, setPath] = useState<Path>('existing');
  const [step, setStep] = useState<Step>('path');
  const [selected, setSelected] = useState<SelectedCompany | null>(null);

  // ── 기존 거래처 검색 ──
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<CompanySearchRow[]>([]);
  const [searched, setSearched] = useState(false);

  const runSearch = useCallback(async () => {
    const q = search.trim();
    if (!q) { setResults([]); setSearched(false); return; }
    setSearching(true);
    try {
      const res = await fetch(api(`/api/admin/companies?search=${encodeURIComponent(q)}&pageSize=20`), { headers: authHeaders });
      const data = await res.json();
      const rows: CompanySearchRow[] = Array.isArray(data?.rows) ? data.rows : Array.isArray(data) ? data : [];
      setResults(rows);
      setSearched(true);
    } catch { onToast('오류: 거래처 검색 실패'); }
    finally { setSearching(false); }
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  // 기존 회사 선택 → 외주역할 중복검사 후 외주정보 단계로
  const chooseExisting = async (row: CompanySearchRow) => {
    try {
      const res = await fetch(api(`/api/admin/companies/${row.id}/vendor-profile`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok && data?.vendorProfile) {
        onToast('이미 외주업체로 등록된 거래처입니다. 외주업체 목록에서 확인하세요.');
        return;
      }
    } catch { /* 조회 실패해도 진행 가능(등록 시 upsert가 안전) */ }
    setSelected({ id: row.id, name: row.name, businessNumber: row.businessNumber, representativeName: row.representativeName, companyType: row.companyType, isCustomer: row.isCustomer });
    setStep('vendor-info');
  };

  // ── 외주정보 폼(공통 마지막 단계) ──
  const [outsourcingField, setOutsourcingField] = useState('');
  const [mainWork, setMainWork] = useState('');
  const [memo, setMemo] = useState('');
  const [issuesTaxInvoice, setIssuesTaxInvoice] = useState(false);
  const [bankName, setBankName] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [accountHolder, setAccountHolder] = useState('');
  const [saving, setSaving] = useState(false);

  const saveVendorInfo = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      // 1) 외주 역할/Profile upsert — companies.isVendor=true 설정(서버).
      const res = await fetch(api(`/api/admin/companies/${selected.id}/vendor-profile`), {
        method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outsourcingField: outsourcingField || null,
          mainWork: mainWork.trim() || null,
          issuesTaxInvoice,
          memo: memo.trim() || null,
          status: 'active',
        }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data?.error ?? '외주 프로필 저장 실패'}`); return; }

      // 2) 지급계좌(선택) — 기존 company_sensitive(암호화) 재사용. 입력이 하나라도 있으면 저장.
      if (bankName.trim() || bankAccount.trim() || accountHolder.trim()) {
        const payRes = await fetch(api(`/api/admin/companies/${selected.id}/payment-account`), {
          method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ bankName: bankName.trim(), bankAccount: bankAccount.trim(), accountHolder: accountHolder.trim() }),
        });
        if (!payRes.ok) { onToast('외주 역할은 저장됐으나 지급계좌 저장에 실패했습니다. 상세에서 다시 시도하세요.'); }
      }

      onToast(`외주업체가 등록되었습니다: ${selected.name}`);
      onDone(selected.id);
    } catch { onToast('오류: 외주업체 등록 실패'); }
    finally { setSaving(false); }
  };

  // ─────────────────────────────────────────────────────────────────────────
  const backLabel = '외주업체 목록';

  return (
    <div style={{ background: '#f9fafb', minHeight: '100vh' }}>
      <PageHeader
        onBack={onCancel}
        backLabel={backLabel}
        testId="btn-vendor-register-back"
        title="외주업체 등록"
        style={dsStickyPageHeader()}
      />

      <div style={{ padding: '20px 0 64px', width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* ── 경로 선택(§4): 기존 거래처 / 신규 업체 ── */}
        {step !== 'vendor-info' && (
          <Card style={{ padding: '14px 16px' }}>
            <p style={{ margin: '0 0 10px', fontSize: 13, color: '#6b7280' }}>
              외주업체는 별도 회사가 아니라 <b style={{ color: '#7c3aed' }}>거래처(회사)에 외주 역할을 부여</b>하는 방식입니다.
              동일 사업자번호로 회사를 새로 만들지 않습니다.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              {([
                { v: 'existing', label: '기존 거래처에서 선택', desc: '이미 등록된 거래처에 외주 역할 부여' },
                { v: 'new', label: '신규 업체 등록', desc: '새 회사 생성 후 외주 역할 부여' },
              ] as { v: Path; label: string; desc: string }[]).map(opt => {
                const active = path === opt.v;
                return (
                  <button key={opt.v} type="button"
                    data-testid={`vendor-path-${opt.v}`}
                    onClick={() => { setPath(opt.v); setStep(opt.v === 'new' ? 'company-new' : 'path'); }}
                    style={{
                      flex: 1, textAlign: 'left', cursor: 'pointer', borderRadius: 10, padding: '12px 14px',
                      background: active ? '#f5f3ff' : '#fff',
                      border: `2px solid ${active ? '#7c3aed' : '#e5e7eb'}`,
                      boxShadow: active ? '0 0 0 3px #7c3aed20' : 'none', transition: 'all 0.15s',
                    }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: active ? '#6d28d9' : '#374151' }}>{opt.label}</div>
                    <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 3 }}>{opt.desc}</div>
                  </button>
                );
              })}
            </div>
          </Card>
        )}

        {/* ── A. 기존 거래처 검색/선택 ── */}
        {step === 'path' && path === 'existing' && (
          <Card style={{ padding: '14px 16px' }}>
            <div style={cardHead}><span style={cardBar} /><p style={cardTitle}>거래처 검색</p></div>
            <div style={{ display: 'flex', gap: 8, margin: '14px 0' }}>
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="상호, 사업자번호, 대표자로 검색"
                data-testid="vendor-company-search-input" aria-label="거래처 검색"
                style={{ ...inputStyle, flex: 1 }}
                onKeyDown={e => e.key === 'Enter' && runSearch()} />
              <PrimaryBtn onClick={runSearch} disabled={searching} data-testid="vendor-company-search-btn"
                style={{ padding: '9px 20px', fontSize: 13 }}>
                {searching ? '검색 중...' : '검색'}
              </PrimaryBtn>
            </div>
            {searched && results.length === 0 && !searching && (
              <div style={{ textAlign: 'center', padding: '24px', color: '#9ca3af', fontSize: 13 }}>
                검색 결과가 없습니다. 신규 업체로 등록하려면 상단에서 「신규 업체 등록」을 선택하세요.
              </div>
            )}
            {results.length > 0 && (
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                {results.map(row => (
                  <button key={row.id} type="button"
                    data-testid={`vendor-company-pick-${row.id}`}
                    onClick={() => chooseExisting(row)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                      width: '100%', textAlign: 'left', cursor: 'pointer', padding: '10px 14px',
                      background: '#fff', border: 'none', borderBottom: '1px solid #f3f4f6',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#faf5ff')}
                    onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>
                        {row.name}
                        {row.isVendor && (
                          <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: '#f5f3ff', color: '#7c3aed', border: '1px solid #ddd6fe' }}>외주 등록됨</span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                        {[row.businessNumber || null, row.representativeName || null].filter(Boolean).join(' · ') || '정보 없음'}
                      </div>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: row.isVendor ? '#9ca3af' : '#7c3aed', whiteSpace: 'nowrap' }}>
                      {row.isVendor ? '이미 등록' : '선택 →'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>
        )}

        {/* ── B. 신규 업체 등록: 기존 CompanyForm 재사용(companyType=vendor 고정 초기값) ── */}
        {step === 'company-new' && (
          <Card style={{ padding: '14px 16px' }}>
            <div style={cardHead}><span style={cardBar} /><p style={cardTitle}>신규 업체 기본정보</p></div>
            <p style={{ margin: '10px 0 0', fontSize: 12, color: '#9ca3af' }}>
              회사를 먼저 생성합니다. 다음 단계에서 외주분야·지급정보를 입력합니다.
            </p>
            <div style={{ marginTop: 10 }}>
              <CompanyForm
                mode="create"
                token={token}
                onToast={onToast}
                initialValues={{ ...emptyCompanyFormValues(), companyType: 'vendor' }}
                onSaved={(c) => { setSelected({ id: c.id, name: c.name, companyType: 'vendor' }); setStep('vendor-info'); }}
                onCancel={() => setStep('path')}
                onOpenCompany={onOpenCompany}
              />
            </div>
          </Card>
        )}

        {/* ── 마지막 단계: 외주정보 + 지급정보 ── */}
        {step === 'vendor-info' && selected && (
          <>
            {/* 선택된 회사 요약 */}
            <Card style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: '#9ca3af' }}>외주 역할을 부여할 거래처</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginTop: 2 }}>
                  {selected.name}
                  {selected.isCustomer && (
                    <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>고객 겸업</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                  {[selected.businessNumber || null, selected.representativeName || null].filter(Boolean).join(' · ') || ''}
                </div>
              </div>
              {path === 'existing' && (
                <GhostBtn onClick={() => { setSelected(null); setStep('path'); }} style={{ fontSize: 12, padding: '6px 12px' }}>다시 선택</GhostBtn>
              )}
            </Card>

            {/* 외주정보 */}
            <Card style={{ padding: 0, overflow: 'hidden' }}>
              <div style={cardHead}><span style={cardBar} /><p style={cardTitle}>외주정보</p></div>
              <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={labelStyle}>외주분야</label>
                  <ClickSelect
                    value={outsourcingField}
                    onChange={setOutsourcingField}
                    triggerStyle={{ fontSize: 14, padding: '9px 12px', borderRadius: 8, minWidth: 200 }}
                    options={[{ value: '', label: '선택 안 함' }, ...OUTSOURCING_FIELD_OPTIONS]}
                  />
                </div>
                <div>
                  <label style={labelStyle}>주요업무</label>
                  <input value={mainWork} onChange={e => setMainWork(e.target.value)}
                    placeholder="예: 영상 자막 번역, 동시통역 장비 대여"
                    data-testid="vendor-mainwork-input" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>메모</label>
                  <textarea value={memo} onChange={e => setMemo(e.target.value)} rows={2}
                    placeholder="외주업체 관련 특이사항"
                    data-testid="vendor-memo-input" style={{ ...inputStyle, resize: 'vertical' }} />
                </div>
              </div>
            </Card>

            {/* 지급정보 */}
            <Card style={{ padding: 0, overflow: 'hidden' }}>
              <div style={cardHead}><span style={cardBar} /><p style={cardTitle}>지급정보</p></div>
              <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600, color: '#374151', cursor: 'pointer' }}>
                  <input type="checkbox" checked={issuesTaxInvoice} onChange={e => setIssuesTaxInvoice(e.target.checked)}
                    data-testid="vendor-taxinvoice-checkbox" />
                  세금계산서 발행 업체
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 14px' }}>
                  <div>
                    <label style={labelStyle}>은행</label>
                    <input value={bankName} onChange={e => setBankName(e.target.value)} placeholder="국민은행"
                      data-testid="vendor-bank-input" style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>계좌번호</label>
                    <input value={bankAccount} onChange={e => setBankAccount(e.target.value)} placeholder="숫자만"
                      data-testid="vendor-account-input" style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>예금주</label>
                    <input value={accountHolder} onChange={e => setAccountHolder(e.target.value)} placeholder="예금주명"
                      data-testid="vendor-holder-input" style={inputStyle} />
                  </div>
                </div>
                <p style={{ margin: 0, fontSize: 11, color: '#9ca3af' }}>계좌번호는 기존 통번역사/거래처와 동일하게 암호화 저장됩니다.</p>
              </div>
            </Card>

            {/* 액션 */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <GhostBtn onClick={onCancel} style={{ fontSize: 14, padding: '9px 18px' }} data-testid="btn-vendor-register-cancel">취소</GhostBtn>
              <PrimaryBtn onClick={saveVendorInfo} disabled={saving || !hasPerm('company.update')}
                style={{ fontSize: 14, padding: '9px 24px' }} data-testid="btn-vendor-register-submit">
                {saving ? '등록 중...' : '외주업체 등록'}
              </PrimaryBtn>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
