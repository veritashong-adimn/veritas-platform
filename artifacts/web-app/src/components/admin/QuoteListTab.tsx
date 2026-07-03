import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/constants';
import { GhostBtn, PrimaryBtn, ClickSelect } from '../ui';
import { QuoteEditorModal } from './QuoteEditorModal';

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
}

export function QuoteListTab({ token, onToast, adminUsers = [] }: QuoteListTabProps) {
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

  // 검색 필터 (견적번호·견적서명·고객사·고객명·관리매니저·상품명)
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

  return (
    <div style={{ padding: '0 0 40px' }}>
      {/* ── 페이지 헤더 (제목 + 액션 버튼) ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>견적서 관리</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <PrimaryBtn onClick={() => setShowEditor(true)} style={{ fontSize: 13, padding: '7px 16px' }}>
            + 견적서 작성
          </PrimaryBtn>
          <GhostBtn onClick={fetchQuotes} style={{ fontSize: 12, padding: '7px 12px' }}>새로고침</GhostBtn>
        </div>
      </div>

      {/* ── 검색 · 필터 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {/* 통합검색 */}
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="견적번호 · 견적서명 · 고객사 · 고객명 · 관리매니저 · 상품명 검색"
          style={{ flex: '1 1 260px', padding: '7px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 7, outline: 'none' }}
        />

        {/* 상태 필터 */}
        <div style={{ width: 130 }}>
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

        {/* 유형 필터 */}
        <div style={{ width: 140 }}>
          <ClickSelect
            value={typeFilter}
            onChange={setTypeFilter}
            triggerStyle={{ fontSize: 12, padding: '6px 8px', width: '100%' }}
            options={[
              { value: 'all',              label: '전체 유형' },
              { value: 'b2b_standard',     label: '일반 견적서' },
              { value: 'b2c_prepaid',      label: '차감 견적서' },
              { value: 'accumulated_batch', label: '누적 견적서' },
            ]}
          />
        </div>
      </div>

      {/* ── 발행일 기간 검색 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap' }}>발행일</span>
        <input
          type="date"
          value={dateFrom}
          onChange={e => setDateFrom(e.target.value)}
          style={{ padding: '5px 8px', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 6, outline: 'none', color: dateFrom ? '#111827' : '#9ca3af' }}
        />
        <span style={{ fontSize: 12, color: '#9ca3af' }}>~</span>
        <input
          type="date"
          value={dateTo}
          onChange={e => setDateTo(e.target.value)}
          style={{ padding: '5px 8px', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 6, outline: 'none', color: dateTo ? '#111827' : '#9ca3af' }}
        />
        {(dateFrom || dateTo) && (
          <button
            onClick={() => { setDateFrom(''); setDateTo(''); }}
            style={{ fontSize: 11, color: '#6b7280', background: '#f3f4f6', border: 'none', borderRadius: 5, padding: '4px 8px', cursor: 'pointer' }}
          >
            초기화
          </button>
        )}
      </div>

      {/* ── 통계 요약 ── */}
      {quotes.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          {[
            { label: '전체', value: quotes.length, color: '#2563eb', bg: '#eff6ff' },
            { label: '대기', value: quotes.filter(q => q.status === 'pending').length, color: '#6b7280', bg: '#f3f4f6' },
            { label: '발송', value: quotes.filter(q => q.status === 'sent').length, color: '#2563eb', bg: '#dbeafe' },
            { label: '승인', value: quotes.filter(q => q.status === 'approved').length, color: '#15803d', bg: '#dcfce7' },
            { label: '거절', value: quotes.filter(q => q.status === 'rejected').length, color: '#dc2626', bg: '#fee2e2' },
          ].map(s => (
            <div key={s.label} style={{ padding: '6px 14px', background: s.bg, borderRadius: 8, textAlign: 'center', minWidth: 70 }}>
              <div style={{ fontSize: 10, color: s.color, fontWeight: 600 }}>{s.label}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: s.color }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── 테이블 ── */}
      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>조회 중…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
          {quotes.length === 0 ? '등록된 견적서가 없습니다.' : '검색 결과가 없습니다.'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e5e7eb' }}>
                {['견적번호', '발행일', '견적서명', '고객사', '고객명', '금액', '견적유형', '관리매니저', '상태', '상태변경'].map(h => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', whiteSpace: 'nowrap' }}>{h}</th>
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
                  : q.status === 'approved'
                  ? [{ value: 'pending', label: '대기로 되돌리기' }]
                  : [{ value: 'pending', label: '대기로 되돌리기' }];

                return (
                  <tr key={q.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    {/* 견적번호 */}
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#374151', fontWeight: 600 }}>
                        {q.quoteNumber ?? `#${q.id}`}
                      </span>
                    </td>

                    {/* 발행일 */}
                    <td style={{ padding: '8px 10px', fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>
                      {q.issueDate ?? '—'}
                    </td>

                    {/* 견적서명 */}
                    <td style={{ padding: '8px 10px', maxWidth: 220 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {q.title ?? q.projectTitle ?? '(미입력)'}
                      </div>
                    </td>

                    {/* 고객사 */}
                    <td style={{ padding: '8px 10px', maxWidth: 130 }}>
                      {q.companyName ? (
                        <span style={{ fontSize: 12, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                          {q.companyName}
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>
                      )}
                    </td>

                    {/* 고객명 */}
                    <td style={{ padding: '8px 10px', maxWidth: 100 }}>
                      {q.contactName ? (
                        <span style={{ fontSize: 12, color: '#374151', whiteSpace: 'nowrap' }}>
                          {q.contactName}
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>
                      )}
                    </td>

                    {/* 금액 */}
                    <td style={{ padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700, color: '#1e3a5f', fontSize: 13 }}>
                      {fmt(q.price)}원
                    </td>

                    {/* 견적유형 */}
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                      <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: '#f0f9ff', color: '#0369a1', fontWeight: 600 }}>
                        {QUOTE_TYPE_LABEL[q.quoteType] ?? q.quoteType}
                      </span>
                    </td>

                    {/* 관리매니저 */}
                    <td style={{ padding: '8px 10px', maxWidth: 90 }}>
                      {q.adminName ? (
                        <span style={{ fontSize: 12, color: '#374151', whiteSpace: 'nowrap' }}>
                          {q.adminName}
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>
                      )}
                    </td>

                    {/* 상태 */}
                    <td style={{ padding: '8px 10px' }}>
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, fontWeight: 700, background: sColor.bg, color: sColor.color }}>
                        {QUOTE_STATUS_LABEL[q.status] ?? q.status}
                      </span>
                    </td>

                    {/* 상태 변경 */}
                    <td style={{ padding: '8px 10px' }}>
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

      {/* ── 견적서 작성 모달 ── */}
      {showEditor && (
        <QuoteEditorModal
          token={token}
          projectId={null}
          onClose={() => setShowEditor(false)}
          onSaved={() => {
            setShowEditor(false);
            fetchQuotes();
          }}
          onToast={onToast}
          adminList={adminUsers}
        />
      )}
    </div>
  );
}
