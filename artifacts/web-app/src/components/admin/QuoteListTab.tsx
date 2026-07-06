import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/constants';
import { PrimaryBtn, ClickSelect } from '../ui';
import { QuoteEditorWorkspace } from './QuoteEditorWorkspace';

// ─── 타입 ──────────────────────────────────────────────────────────────────────
interface QuoteRow {
  id: number;
  projectId: number | null;
  quoteNumber: string | null;
  title: string | null;
  price: string;
  status: 'pending' | 'sent' | 'approved' | 'rejected';
  quoteType: string;
  billingType: string;
  issueDate: string | null;
  validUntil: string | null;
  createdAt: string;
  projectTitle: string | null;
  projectStatus: string | null;
  projectCompanyId: number | null;
  firstProductName: string | null;
  companyName: string | null;
  contactName: string | null;
  adminName: string | null;
}

// ─── 상수 ──────────────────────────────────────────────────────────────────────
const QUOTE_STATUS_LABEL: Record<string, string> = {
  pending:  '대기',
  sent:     '발송',
  approved: '승인',
  rejected: '거절',
};
const QUOTE_STATUS_COLOR: Record<string, { bg: string; color: string }> = {
  pending:  { bg: '#f3f4f6', color: '#6b7280' },
  sent:     { bg: '#eff6ff', color: '#2563eb' },
  approved: { bg: '#dcfce7', color: '#15803d' },
  rejected: { bg: '#fee2e2', color: '#dc2626' },
};
const QUOTE_TYPE_LABEL: Record<string, string> = {
  b2b_standard:      '일반 견적서',
  b2c_prepaid:       '차감 견적서',
  prepaid_deduction: '차감 견적서',
  accumulated_batch: '누적 견적서',
};

// ─── 컴포넌트 ──────────────────────────────────────────────────────────────────
interface QuoteListTabProps {
  token: string;
  onToast: (msg: string) => void;
  adminUsers?: Array<{ id: number; name: string | null; email: string }>;
  /** AdminDashboard fetchAll 호출 시 증가 — QuoteListTab 자동 재조회 트리거 */
  refreshTick?: number;
}

export function QuoteListTab({ token, onToast, adminUsers = [], refreshTick }: QuoteListTabProps) {
  const authH = { Authorization: `Bearer ${token}` };

  const [quotes, setQuotes]             = useState<QuoteRow[]>([]);
  const [loading, setLoading]           = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter]     = useState('all');
  const [search, setSearch]             = useState('');
  const [dateFrom, setDateFrom]         = useState('');
  const [dateTo, setDateTo]             = useState('');
  const [showEditor, setShowEditor]     = useState(false);
  const [updatingId, setUpdatingId]     = useState<number | null>(null);

  const fetchQuotes = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (typeFilter !== 'all')   params.set('quoteType', typeFilter);
      if (dateFrom)               params.set('dateFrom', dateFrom);
      if (dateTo)                 params.set('dateTo', dateTo);
      const res = await fetch(api(`/api/admin/quotes?${params}`), { headers: authH });
      if (!res.ok) { onToast('견적 목록 조회 실패'); return; }
      const data = await res.json();
      setQuotes(Array.isArray(data.quotes) ? data.quotes : []);
    } finally { setLoading(false); }
  }, [token, statusFilter, typeFilter, dateFrom, dateTo]);

  useEffect(() => { fetchQuotes(); }, [fetchQuotes]);
  useEffect(() => { if (refreshTick) fetchQuotes(); }, [refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // 견적 상태 변경
  const handleStatusChange = async (quoteId: number, newStatus: string) => {
    setUpdatingId(quoteId);
    try {
      const res = await fetch(api(`/api/admin/quotes/${quoteId}/status`), {
        method: 'PATCH',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`상태 변경 실패: ${data.error}`); return; }
      if (data.autoCreatedProject) {
        onToast(`승인 완료 — 프로젝트 #${data.project.id}가 자동 생성되었습니다.`);
      } else {
        onToast(`상태가 "${QUOTE_STATUS_LABEL[newStatus]}"로 변경되었습니다.`);
      }
      fetchQuotes();
    } finally { setUpdatingId(null); }
  };

  // 검색 필터 (견적번호·견적서명·고객사·고객명·담당PM·상품명)
  const filtered = quotes.filter(q => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      (q.quoteNumber ?? '').toLowerCase().includes(s) ||
      (q.title ?? '').toLowerCase().includes(s) ||
      (q.companyName ?? '').toLowerCase().includes(s) ||
      (q.contactName ?? '').toLowerCase().includes(s) ||
      (q.adminName ?? '').toLowerCase().includes(s) ||
      (q.firstProductName ?? '').toLowerCase().includes(s)
    );
  });

  const fmt = (v: string | null) => v ? Number(v).toLocaleString() : '—';
  const hasAnyFilter = !!(search || dateFrom || dateTo || statusFilter !== 'all' || typeFilter !== 'all');

  // ── 견적서 작성 Workspace: asPage 인라인 렌더링 (사이드바 유지) ──────────────
  if (showEditor) {
    return (
      // AdminDashboard 스크롤 컨텐츠 padding(24px 28px)을 상쇄 → 전체 폭 활용
      <div style={{ margin: '-24px -28px' }}>
        <QuoteEditorWorkspace
          asPage
          token={token}
          projectId={null}
          onClose={() => setShowEditor(false)}
          onSaved={() => { setShowEditor(false); fetchQuotes(); }}
          onToast={onToast}
          adminList={adminUsers}
        />
      </div>
    );
  }

  // 현황 KPI 데이터
  const kpiItems = [
    { label: '전체', value: 'all',      count: quotes.length,                                       color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' },
    { label: '대기', value: 'pending',  count: quotes.filter(q => q.status === 'pending').length,   color: '#6b7280', bg: '#f9fafb', border: '#e5e7eb' },
    { label: '발송', value: 'sent',     count: quotes.filter(q => q.status === 'sent').length,      color: '#2563eb', bg: '#dbeafe', border: '#93c5fd' },
    { label: '승인', value: 'approved', count: quotes.filter(q => q.status === 'approved').length,  color: '#15803d', bg: '#dcfce7', border: '#86efac' },
    { label: '거절', value: 'rejected', count: quotes.filter(q => q.status === 'rejected').length,  color: '#dc2626', bg: '#fee2e2', border: '#fca5a5' },
  ];

  return (
    <div style={{ padding: '0 0 48px' }}>

      {/* ── Card 1: 검색 및 필터 ────────────────────────────────────────────────── */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 16px', marginBottom: 8 }}>
        {/* 카드 헤더 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', letterSpacing: '0.2px' }}>검색 및 필터</span>
          <PrimaryBtn onClick={() => setShowEditor(true)} style={{ fontSize: 12, padding: '5px 12px' }}>
            + 견적서 작성
          </PrimaryBtn>
        </div>

        {/* 통합검색 + 드롭다운 */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="견적번호 · 견적서명 · 고객사 · 고객명 · 담당PM · 상품명 검색"
            style={{ flex: '1 1 240px', padding: '6px 10px', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 6, outline: 'none' }}
          />
          <div style={{ width: 120 }}>
            <ClickSelect
              value={statusFilter}
              onChange={setStatusFilter}
              triggerStyle={{ fontSize: 12, padding: '6px 8px', width: '100%' }}
              options={[
                { value: 'all',      label: '전체 상태' },
                { value: 'pending',  label: '대기' },
                { value: 'sent',     label: '발송' },
                { value: 'approved', label: '승인' },
                { value: 'rejected', label: '거절' },
              ]}
            />
          </div>
          <div style={{ width: 130 }}>
            <ClickSelect
              value={typeFilter}
              onChange={setTypeFilter}
              triggerStyle={{ fontSize: 12, padding: '6px 8px', width: '100%' }}
              options={[
                { value: 'all',               label: '전체 유형' },
                { value: 'b2b_standard',      label: '일반 견적서' },
                { value: 'b2c_prepaid',       label: '차감 견적서' },
                { value: 'accumulated_batch', label: '누적 견적서' },
              ]}
            />
          </div>
          {hasAnyFilter && (
            <button
              onClick={() => { setSearch(''); setDateFrom(''); setDateTo(''); setStatusFilter('all'); setTypeFilter('all'); }}
              style={{ fontSize: 11, fontWeight: 700, padding: '5px 9px', borderRadius: 6, border: '1px solid #fca5a5', background: '#fef2f2', color: '#dc2626', cursor: 'pointer' }}
            >
              ✕ 초기화
            </button>
          )}
        </div>

        {/* 발행일 기간 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap' }}>발행일</span>
          <input
            type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            style={{ padding: '4px 7px', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 5, outline: 'none', color: dateFrom ? '#111827' : '#9ca3af' }}
          />
          <span style={{ fontSize: 11, color: '#d1d5db' }}>~</span>
          <input
            type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            style={{ padding: '4px 7px', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 5, outline: 'none', color: dateTo ? '#111827' : '#9ca3af' }}
          />
          {(dateFrom || dateTo) && (
            <button
              onClick={() => { setDateFrom(''); setDateTo(''); }}
              style={{ fontSize: 11, color: '#6b7280', background: '#f3f4f6', border: 'none', borderRadius: 4, padding: '3px 7px', cursor: 'pointer' }}
            >
              초기화
            </button>
          )}
        </div>
      </div>

      {/* ── Card 2: 견적 현황 ────────────────────────────────────────────────────── */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 16px', marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', marginBottom: 8 }}>견적 현황</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {kpiItems.map(item => {
            const isActive = statusFilter === item.value;
            return (
              <button
                key={item.label}
                onClick={() => setStatusFilter(item.value)}
                style={{
                  flex: '1 1 70px', minWidth: 70, padding: '6px 8px',
                  background: isActive ? item.bg : '#fafafa',
                  border: `1.5px solid ${isActive ? item.border : '#e5e7eb'}`,
                  borderRadius: 8, textAlign: 'center', cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  boxShadow: isActive ? `0 0 0 2px ${item.border}50` : 'none',
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 600, color: isActive ? item.color : '#9ca3af', letterSpacing: '0.3px', marginBottom: 2 }}>
                  {item.label}
                </div>
                <div style={{ fontSize: 18, fontWeight: 800, color: isActive ? item.color : '#374151', lineHeight: 1 }}>
                  {item.count}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Card 3: 견적 목록 ────────────────────────────────────────────────────── */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 16px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', marginBottom: 10 }}>
          견적 목록
          <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 500, color: '#9ca3af' }}>({filtered.length})</span>
        </div>

        {loading ? (
          <div style={{ padding: '32px 0', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>조회 중…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '32px 0', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
            {quotes.length === 0 ? '등록된 견적서가 없습니다.' : '검색 결과가 없습니다.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e5e7eb' }}>
                  {['견적번호', '발행일', '견적서명', '고객사', '고객명', '금액', '견적유형', '담당PM', '상태', '상태변경'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(q => {
                  const sColor = QUOTE_STATUS_COLOR[q.status] ?? { bg: '#f3f4f6', color: '#6b7280' };
                  const isUpdating = updatingId === q.id;
                  const nextStatuses = q.status === 'pending'
                    ? [{ value: 'sent', label: '발송' }, { value: 'rejected', label: '거절' }]
                    : q.status === 'sent'
                    ? [{ value: 'approved', label: '승인' }, { value: 'pending', label: '대기로 되돌리기' }, { value: 'rejected', label: '거절' }]
                    : [{ value: 'pending', label: '대기로 되돌리기' }];

                  return (
                    <tr key={q.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      {/* 견적번호 */}
                      <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                        <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#374151', fontWeight: 600 }}>
                          {q.quoteNumber ?? `#${q.id}`}
                        </span>
                      </td>
                      {/* 발행일 */}
                      <td style={{ padding: '6px 10px', fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>
                        {q.issueDate ?? '—'}
                      </td>
                      {/* 견적서명 */}
                      <td style={{ padding: '6px 10px', maxWidth: 220 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {q.title ?? q.projectTitle ?? '(미입력)'}
                        </div>
                      </td>
                      {/* 고객사 */}
                      <td style={{ padding: '6px 10px', maxWidth: 130 }}>
                        {q.companyName
                          ? <span style={{ fontSize: 12, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{q.companyName}</span>
                          : <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>}
                      </td>
                      {/* 고객명 */}
                      <td style={{ padding: '6px 10px', maxWidth: 100 }}>
                        {q.contactName
                          ? <span style={{ fontSize: 12, color: '#374151', whiteSpace: 'nowrap' }}>{q.contactName}</span>
                          : <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>}
                      </td>
                      {/* 금액 */}
                      <td style={{ padding: '6px 10px', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700, color: '#1e3a5f', fontSize: 13 }}>
                        {fmt(q.price)}원
                      </td>
                      {/* 견적유형 */}
                      <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                        <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: '#f0f9ff', color: '#0369a1', fontWeight: 600 }}>
                          {QUOTE_TYPE_LABEL[q.quoteType] ?? q.quoteType}
                        </span>
                      </td>
                      {/* 담당PM */}
                      <td style={{ padding: '6px 10px', maxWidth: 90 }}>
                        {q.adminName
                          ? <span style={{ fontSize: 12, color: '#374151', whiteSpace: 'nowrap' }}>{q.adminName}</span>
                          : <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>}
                      </td>
                      {/* 상태 */}
                      <td style={{ padding: '6px 10px' }}>
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, fontWeight: 700, background: sColor.bg, color: sColor.color }}>
                          {QUOTE_STATUS_LABEL[q.status] ?? q.status}
                        </span>
                      </td>
                      {/* 상태변경 */}
                      <td style={{ padding: '6px 10px' }}>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {nextStatuses.map(ns => (
                            <button
                              key={ns.value}
                              onClick={() => handleStatusChange(q.id, ns.value)}
                              disabled={isUpdating}
                              style={{
                                fontSize: 11, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
                                background: ns.value === 'approved' ? '#dcfce7' : ns.value === 'rejected' ? '#fee2e2' : ns.value === 'sent' ? '#dbeafe' : '#f3f4f6',
                                color: ns.value === 'approved' ? '#15803d' : ns.value === 'rejected' ? '#dc2626' : ns.value === 'sent' ? '#2563eb' : '#6b7280',
                                border: 'none', fontWeight: 600, opacity: isUpdating ? 0.5 : 1,
                              }}
                            >
                              {isUpdating ? '…' : ns.label}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}
