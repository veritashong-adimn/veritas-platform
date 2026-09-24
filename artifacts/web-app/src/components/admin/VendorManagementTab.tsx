import React, { useState, useCallback, useEffect } from 'react';
import { formatDisplayDate } from '../../lib/dateFormat';
import { api } from '../../lib/constants';
import { Card, PrimaryBtn, ClickSelect } from '../ui';
import { Pagination } from '../ui/Paginator';
import { CompanyDetailModal } from './CompanyDetailModal';
import './readTableView.css';

// 외주분야 코드 → 한글 라벨(§4). 서버 화이트리스트(translation|interpretation|equipment|etc)와 1:1.
export const OUTSOURCING_FIELD_LABELS: Record<string, string> = {
  translation: '번역',
  interpretation: '통역',
  equipment: '장비',
  etc: '기타',
};
export const OUTSOURCING_FIELD_OPTIONS = [
  { value: 'translation', label: '번역' },
  { value: 'interpretation', label: '통역' },
  { value: 'equipment', label: '장비' },
  { value: 'etc', label: '기타' },
];

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #d1d5db', fontSize: 14, color: '#111827',
  outline: 'none', boxSizing: 'border-box', background: '#fff',
};
const tableTh: React.CSSProperties = {
  padding: '10px 12px', textAlign: 'left', fontSize: 12,
  fontWeight: 600, color: '#6b7280', background: '#f9fafb',
  borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap',
};
const tableTd: React.CSSProperties = {
  padding: '9px 12px', fontSize: 13, color: '#374151',
  borderBottom: '1px solid #edf0f3', verticalAlign: 'middle',
};

function fieldBadge(field: string | null): React.ReactNode {
  const base: React.CSSProperties = {
    display: 'inline-block', fontSize: 11, fontWeight: 600, padding: '1px 7px',
    borderRadius: 4, lineHeight: 1.4, whiteSpace: 'nowrap',
    background: '#f5f3ff', color: '#7c3aed', border: '1px solid #ddd6fe',
  };
  return <span style={base}>{field ? (OUTSOURCING_FIELD_LABELS[field] ?? field) : '미지정'}</span>;
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

interface VendorRow {
  id: number;
  name: string;
  businessNumber: string | null;
  representativeName: string | null;
  phone: string | null;
  email: string | null;
  companyType: string;
  isCustomer: boolean;
  isVendor: boolean;
  registeredAt: string | null;
  createdAt: string | null;
  profileId: number;
  outsourcingField: string | null;
  mainWork: string | null;
  issuesTaxInvoice: boolean;
  vendorStatus: string;
  memo: string | null;
}

interface VendorManagementTabProps {
  token: string;
  onToast: (msg: string) => void;
  onOpenProject: (id: number) => void;
  /** 외주업체 등록 화면으로 이동 */
  onRegister: () => void;
  hasPerm: (key: string | undefined) => boolean;
}

/**
 * VendorManagementTab — 외주업체 목록(역할 뷰, §2·§12).
 *
 * companies 는 identity SSOT. 이 화면은 is_vendor=true 회사를 외주 Profile 과 조인해 보여준다.
 * 회사 자체의 삭제/수정은 거래처 화면에서 처리하고, 여기서는 외주 역할 관점의 조회만 담당한다.
 * 행 클릭 시 기존 거래처 상세 모달(CompanyDetailModal)을 그대로 재사용한다.
 */
export function VendorManagementTab({ token, onToast, onOpenProject, onRegister, hasPerm }: VendorManagementTabProps) {
  const authHeaders = { Authorization: `Bearer ${token}` };

  const [rows, setRows] = useState<VendorRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [fieldFilter, setFieldFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('active');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [companyModal, setCompanyModal] = useState<number | null>(null);

  const fetchVendors = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      if (appliedSearch.trim()) params.set('search', appliedSearch.trim());
      if (fieldFilter !== 'all') params.set('outsourcingField', fieldFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const res = await fetch(api(`/api/admin/vendors?${params.toString()}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) {
        const list: VendorRow[] = Array.isArray(data?.rows) ? data.rows : Array.isArray(data) ? data : [];
        setRows(list);
        setTotal(typeof data?.total === 'number' ? data.total : list.length);
        if (list.length === 0 && (data?.total ?? 0) > 0 && page > 1) setPage(p => Math.max(1, p - 1));
      } else {
        onToast(`오류: 외주업체 조회 실패 (${res.status})`);
      }
    } catch { onToast('오류: 외주업체 조회 실패'); }
    finally { setLoading(false); }
  }, [token, page, pageSize, appliedSearch, fieldFilter, statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchVendors(); }, [fetchVendors]);

  const runSearch = useCallback(() => { setAppliedSearch(search.trim()); setPage(1); }, [search]);

  return (
    <>
      {companyModal !== null && (
        <CompanyDetailModal
          companyId={companyModal}
          token={token}
          onClose={() => setCompanyModal(null)}
          onToast={onToast}
          onOpenProject={(id) => { setCompanyModal(null); onOpenProject(id); }}
          onRefresh={fetchVendors}
          onDeleted={() => { setCompanyModal(null); fetchVendors(); }}
        />
      )}

      <Section title={`외주업체 목록 (${total.toLocaleString()})`} action={
        hasPerm('company.create') ? (
          <PrimaryBtn onClick={onRegister} style={{ fontSize: 13, padding: '7px 14px' }}
            data-testid="vendor-register-btn" aria-label="외주업체 등록">
            + 외주업체 등록
          </PrimaryBtn>
        ) : undefined
      }>
        {/* 필터 + 검색 */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#6d28d9', whiteSpace: 'nowrap' }}>외주분야</span>
            <ClickSelect
              value={fieldFilter}
              onChange={v => { setFieldFilter(v); setPage(1); }}
              triggerStyle={{ fontSize: 12, padding: '5px 11px', borderRadius: 20, lineHeight: '1.4' }}
              options={[{ value: 'all', label: '전체 분야' }, ...OUTSOURCING_FIELD_OPTIONS]}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap' }}>상태</span>
            <ClickSelect
              value={statusFilter}
              onChange={v => { setStatusFilter(v); setPage(1); }}
              triggerStyle={{ fontSize: 12, padding: '5px 11px', borderRadius: 20, lineHeight: '1.4' }}
              options={[
                { value: 'active', label: '활성' },
                { value: 'inactive', label: '비활성' },
                { value: 'all', label: '전체' },
              ]}
            />
          </div>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="상호, 사업자번호, 대표자..."
            style={{ ...inputStyle, maxWidth: 320, flex: '1 1 200px', padding: '8px 12px', fontSize: 13 }}
            data-testid="vendor-search-input" aria-label="외주업체 검색"
            onKeyDown={e => e.key === 'Enter' && runSearch()} />
          <PrimaryBtn onClick={runSearch} disabled={loading} style={{ padding: '8px 16px', fontSize: 13 }}
            data-testid="vendor-search-btn">
            {loading ? '검색 중...' : '검색'}
          </PrimaryBtn>
        </div>

        {/* 목록 */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: '#9ca3af', fontSize: 14 }}>불러오는 중...</div>
        ) : rows.length === 0 ? (
          // 필터/검색이 걸린 경우와 "아직 한 건도 없음"을 구분(§3). 전자는 조건 안내, 후자는 등록 유도.
          (() => {
            const filtered = appliedSearch.trim() !== '' || fieldFilter !== 'all' || statusFilter !== 'active';
            return (
              <Card style={{ textAlign: 'center', padding: '40px 32px', color: '#6b7280', fontSize: 14 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                  {filtered ? '조건에 맞는 외주업체가 없습니다.' : '등록된 외주업체가 없습니다.'}
                </div>
                <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: filtered ? 0 : 16 }}>
                  {filtered ? '검색어·필터를 변경해 보세요.' : '기존 거래처에 외주 역할을 부여하거나 신규 업체를 등록하세요.'}
                </div>
                {!filtered && hasPerm('company.create') && (
                  <PrimaryBtn onClick={onRegister} style={{ fontSize: 13, padding: '8px 18px' }}
                    data-testid="vendor-empty-register-btn" aria-label="외주업체 등록">
                    + 외주업체 등록
                  </PrimaryBtn>
                )}
              </Card>
            );
          })()
        ) : (
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table className="veritas-read-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['상호', '사업자번호', '대표자', '외주분야', '세금계산서', '상태', '연락처', '등록일'].map(h => (
                      <th key={h} style={tableTh}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(v => (
                    <tr key={v.id} onClick={() => setCompanyModal(v.id)}
                      data-testid={`vendor-row-${v.id}`}
                      style={{ cursor: 'pointer', opacity: v.vendorStatus === 'inactive' ? 0.55 : 1 }}>
                      <td style={{ ...tableTd, minWidth: 200 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>
                          {v.name}
                          {v.isCustomer && (
                            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
                              고객 겸업
                            </span>
                          )}
                        </div>
                        {v.mainWork && (
                          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{v.mainWork}</div>
                        )}
                      </td>
                      <td style={{ ...tableTd, fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{v.businessNumber || '-'}</td>
                      <td style={{ ...tableTd, fontSize: 12, color: '#374151' }}>{v.representativeName || '-'}</td>
                      <td style={{ ...tableTd, width: 1, whiteSpace: 'nowrap' }}>{fieldBadge(v.outsourcingField)}</td>
                      <td style={{ ...tableTd, textAlign: 'center', width: 1, whiteSpace: 'nowrap' }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: v.issuesTaxInvoice ? '#15803d' : '#9ca3af' }}>
                          {v.issuesTaxInvoice ? 'O' : 'X'}
                        </span>
                      </td>
                      <td style={{ ...tableTd, width: 1, whiteSpace: 'nowrap' }}>
                        <span style={{
                          fontSize: 11, fontWeight: 600, padding: '1px 8px', borderRadius: 10,
                          background: v.vendorStatus === 'inactive' ? '#f3f4f6' : '#f0fdf4',
                          color: v.vendorStatus === 'inactive' ? '#6b7280' : '#15803d',
                        }}>
                          {v.vendorStatus === 'inactive' ? '비활성' : '활성'}
                        </span>
                      </td>
                      <td style={{ ...tableTd, fontSize: 12, color: '#6b7280' }}>
                        {[v.phone || null, v.email || null].filter(Boolean).join(' · ') || '-'}
                      </td>
                      <td style={{ ...tableTd, fontSize: 12, color: '#9ca3af', whiteSpace: 'nowrap' }}>
                        {v.registeredAt ? formatDisplayDate(v.registeredAt) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
        {total > 0 && (
          <Pagination
            idPrefix="vendor"
            page={page}
            pageSize={pageSize}
            total={total}
            unit="건"
            disabled={loading}
            onPageChange={setPage}
            onPageSizeChange={s => { setPageSize(s); setPage(1); }}
          />
        )}
      </Section>
    </>
  );
}
