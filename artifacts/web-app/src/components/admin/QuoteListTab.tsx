import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/constants';
import { PrimaryBtn, ClickSelect } from '../ui';
import { QuoteEditorWorkspace, type QuoteItemForm, type VatType, type QuoteType, type ServiceType } from './QuoteEditorWorkspace';
import QuotePdfPreviewModal from './QuotePdfPreviewModal';
import { buildQuotePdfData, parseMemoInfo, type QuoteDetail, type QuoteDetailItem } from '../../lib/quotePdf';

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
  const [pdfData,    setPdfData]        = useState<{ data: ReturnType<typeof buildQuotePdfData>; title: string } | null>(null);
  const [pdfLoading, setPdfLoading]     = useState<number | null>(null);
  // 편집 모드
  const [editLoading,  setEditLoading]  = useState<number | null>(null);
  const [editQuoteId,  setEditQuoteId]  = useState<number | null>(null);
  const [editInitData, setEditInitData] = useState<{
    items: QuoteItemForm[]; title: string; note: string;
    quoteType: QuoteType; issueDate: string; vatType: VatType;
    companyId: number | null; contactId: number | null;
  } | null>(null);
  // 삭제(Soft Delete)
  const [deleteTarget, setDeleteTarget] = useState<QuoteRow | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleting, setDeleting]         = useState(false);

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

  // 판매전환 — 기존 승인 API(PATCH .../status {approved}) 재사용, 프로젝트 자동 생성
  // 확인창 → 요청 중 버튼 disabled(updatingId) 로 중복 클릭 방지
  const handleConvertToSale = async (quoteId: number) => {
    if (updatingId != null) return;
    if (!window.confirm('이 견적을 판매건으로 전환하시겠습니까? 판매관리에서 프로젝트가 생성됩니다.')) return;
    setUpdatingId(quoteId);
    try {
      const res = await fetch(api(`/api/admin/quotes/${quoteId}/status`), {
        method: 'PATCH',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`판매전환 실패: ${data.error ?? res.status}`); return; }
      const pid = data.project?.id ?? data.quote?.projectId ?? null;
      onToast(pid != null ? `판매건으로 전환되었습니다. (판매 #${pid})` : '판매건으로 전환되었습니다.');
      fetchQuotes();
    } catch {
      onToast('판매전환 중 오류가 발생했습니다. 다시 시도해 주세요.');
    } finally { setUpdatingId(null); }
  };

  // 견적 삭제(Soft Delete) — 삭제 사유 필수. 판매전환 완료 견적은 서버에서도 차단됨.
  const handleDeleteQuote = async () => {
    if (!deleteTarget || deleting) return;
    const reason = deleteReason.trim();
    if (reason.length < 2) { onToast('삭제 사유를 2자 이상 입력해 주세요.'); return; }
    setDeleting(true);
    try {
      const res = await fetch(api(`/api/admin/quotes/${deleteTarget.id}`), {
        method: 'DELETE',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`견적 삭제 실패: ${data.error ?? res.status}`); return; }
      onToast('견적이 삭제되었습니다.');
      setDeleteTarget(null);
      setDeleteReason('');
      fetchQuotes();
    } catch {
      onToast('견적 삭제 중 오류가 발생했습니다. 다시 시도해 주세요.');
    } finally { setDeleting(false); }
  };

  const DELETE_BLOCKED_MSG = '판매전환된 견적은 삭제할 수 없습니다. 먼저 판매취소를 진행해 주세요.';

  // PDF 미리보기 핸들러 — 단건 견적 상세 조회 후 모달 열기
  const handlePdfPreview = async (quoteId: number, title: string) => {
    setPdfLoading(quoteId);
    try {
      const res = await fetch(api(`/api/admin/quotes/${quoteId}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        onToast(`PDF 미리보기 실패: ${err.error ?? res.status}`);
        return;
      }
      const detail = await res.json() as QuoteDetail;
      if (!detail.items || detail.items.length === 0) {
        onToast('견적 품목이 없습니다. 품목을 먼저 입력해 주세요.');
        return;
      }
      setPdfData({ data: buildQuotePdfData(detail), title });
    } catch {
      onToast('PDF 생성에 실패했습니다. 다시 시도해 주세요.');
    } finally {
      setPdfLoading(null);
    }
  };

  // QuoteDetailItem → QuoteItemForm 변환 (기존 견적 편집 진입 시 폼 초기화용)
  function convertToFormItem(it: QuoteDetailItem & { productId?: number | null; taxType?: string | null }): QuoteItemForm {
    const type = (it.itemType ?? 'translation') as ServiceType;
    const taxType: VatType = (it.taxType === 'taxable' || it.taxType === 'exempt' || it.taxType === 'zero_rate') ? it.taxType : 'taxable';
    const { fields, userMemo } = parseMemoInfo(it.memo);
    // 통역 인원 복원:
    // 1) 비고의 "투입인원: N명" 우선 (Legacy 호환)
    // 2) 없으면 quantity ÷ serviceDays 역산 (신규 저장 포맷)
    const sd = (() => {
      if (type !== 'interpretation' || !it.interpretDate) return 0;
      const eDate = it.eventEndDate;
      if (!eDate || eDate === it.interpretDate) return 1;
      return Math.max(1, Math.round((new Date(eDate).getTime() - new Date(it.interpretDate).getTime()) / 86400000) + 1);
    })();
    const qty = Number(it.quantity) || 1;
    let interpreterCount = '';
    if (type === 'interpretation') {
      const memoCount = fields['투입인원'];
      if (memoCount && Number(memoCount) > 0) {
        interpreterCount = memoCount;        // Legacy: "투입인원: N명"에서 복원
      } else if (sd > 0) {
        interpreterCount = String(Math.round(qty / sd));  // 신규: billingQty ÷ days
      }
    }
    const [startTime = '', endTime = ''] = it.interpretDuration ? it.interpretDuration.split('~') : [];
    const sourceLanguage = it.languagePair ? it.languagePair.split('-')[0] : 'ko';
    return {
      productId:        it.productId ?? null,
      productName:      it.productName,
      productType:      type,
      quantity:         String(qty),
      unit:             it.unit,
      unitPrice:        String(Number(it.unitPrice)),
      taxType,
      memo:             userMemo,
      sourceLanguage,
      fileName:         fields['파일']   ?? '',
      fileFormat:       fields['형식']   ?? '',
      wordCount:        fields['단어수'] ?? '',
      charCount:        fields['글자수'] ?? '',
      interpretDate:    it.interpretDate     ?? '',
      interpretEndDate: it.eventEndDate      ?? '',
      startTime,
      endTime,
      interpretPlace:   it.interpretPlace    ?? '',
      interpreterCount,
      eventStartDate:   it.eventStartDate    ?? '',
      eventEndDate:     it.eventEndDate      ?? '',
      itemLocation:     it.itemLocation      ?? '',
      usagePeriod:      it.usagePeriod       ?? '',
      expenseType:      it.interpretType     ?? '',
    };
  }

  // 기존 견적 편집 진입
  const handleEditQuote = useCallback(async (quoteId: number, quoteTitle: string) => {
    setEditLoading(quoteId);
    try {
      const res = await fetch(api(`/api/admin/quotes/${quoteId}`), { headers: authH });
      if (!res.ok) { onToast('견적 조회 실패'); return; }
      const detail = await res.json() as QuoteDetail & { items: Array<QuoteDetailItem & { productId?: number | null; taxType?: string | null }> };
      const formItems = detail.items.map(it => convertToFormItem(it));
      // 부가세 유형: items 중 taxable이 있으면 taxable, 없으면 exempt
      const vatType: VatType = formItems.some(it => it.taxType === 'taxable') ? 'taxable' : 'exempt';
      setEditQuoteId(quoteId);
      setEditInitData({
        items:     formItems,
        title:     detail.title ?? quoteTitle,
        note:      detail.note  ?? '',
        quoteType: (detail.quoteType as QuoteType) ?? 'b2b_standard',
        issueDate: detail.issueDate ?? '',
        vatType,
        companyId: (detail as any).companyId ?? null,
        contactId: (detail as any).contactId ?? null,
      });
      setShowEditor(true);
    } finally { setEditLoading(null); }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // 편집 닫기 (state 초기화)
  const handleEditorClose = useCallback(() => {
    setShowEditor(false);
    setEditQuoteId(null);
    setEditInitData(null);
  }, []);

  const handleEditorSaved = useCallback(() => {
    setShowEditor(false);
    setEditQuoteId(null);
    setEditInitData(null);
    fetchQuotes();
  }, [fetchQuotes]);

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

  // ── 견적서 작성/편집 Workspace ──────────────────────────────────────────────
  if (showEditor) {
    return (
      <div style={{ margin: '-24px -28px' }}>
        <QuoteEditorWorkspace
          asPage
          token={token}
          projectId={null}
          onClose={handleEditorClose}
          onSaved={handleEditorSaved}
          onToast={onToast}
          adminList={adminUsers}
          // 편집 모드 데이터 (없으면 신규 작성)
          initialQuoteId={editQuoteId ?? undefined}
          initialItems={editInitData?.items}
          initialTitle={editInitData?.title ?? ''}
          initialNote={editInitData?.note}
          initialQuoteType={editInitData?.quoteType}
          initialIssueDate={editInitData?.issueDate}
          initialVatType={editInitData?.vatType}
          initialCompanyId={editInitData?.companyId ?? null}
          initialContactId={editInitData?.contactId ?? null}
        />
      </div>
    );
  }

  // 현황 KPI 데이터
  const kpiItems = [
    { label: '전체', value: 'all',      count: quotes.length,                                       color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' },
    { label: '대기', value: 'pending',  count: quotes.filter(q => q.status === 'pending').length,   color: '#6b7280', bg: '#f9fafb', border: '#e5e7eb' },
    { label: '승인', value: 'approved', count: quotes.filter(q => q.status === 'approved').length,  color: '#15803d', bg: '#dcfce7', border: '#86efac' },
  ];

  return (
    <>
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
                { value: 'approved', label: '승인' },
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
                  {['견적번호', '발행일', '견적서명', '고객사', '고객명', '금액', '견적유형', '담당PM', '상태', 'PDF', '상태변경'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(q => {
                  const sColor = QUOTE_STATUS_COLOR[q.status] ?? { bg: '#f3f4f6', color: '#6b7280' };
                  const isUpdating = updatingId === q.id;
                  // 판매전환 완료 판단 = quote.status === "approved" 기준.
                  // (projectId는 견적 저장 시점에 이미 연결되므로 전환 여부 판단에 사용하지 않는다)
                  // 상태변경 액션은 "판매전환" 하나만 유지한다(발송·거절 제거).
                  // 판매전환 이전의 모든 견적은 '대기'로 관리하며, 미체결 견적은 판매전환 안 된 상태로 판단한다.
                  const isConverted = q.status === 'approved';
                  // 삭제 가능 = 판매전환 완료가 아닌 견적(미전환 또는 판매취소 후 복귀).
                  // 판매전환 완료(활성 Project 연결) 견적은 삭제 불가 — 서버에서도 동일 검증.
                  const canDelete = !isConverted;

                  return (
                    <tr key={q.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      {/* 견적번호 — 클릭 시 편집 */}
                      <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                        <button
                          onClick={() => handleEditQuote(q.id, q.title ?? q.quoteNumber ?? `견적 #${q.id}`)}
                          disabled={editLoading === q.id}
                          style={{
                            fontFamily: 'monospace', fontSize: 12, color: '#2563eb', fontWeight: 700,
                            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                            textDecoration: 'underline', opacity: editLoading === q.id ? 0.5 : 1,
                          }}
                          data-testid={`btn-edit-quote-${q.id}`}
                          aria-label={`${q.quoteNumber ?? q.id} 편집`}
                        >
                          {editLoading === q.id ? '…' : (q.quoteNumber ?? `#${q.id}`)}
                        </button>
                      </td>
                      {/* 발행일 */}
                      <td style={{ padding: '6px 10px', fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>
                        {q.issueDate ?? '—'}
                      </td>
                      {/* 견적서명 — 클릭 시 편집 */}
                      <td style={{ padding: '6px 10px', maxWidth: 220 }}>
                        <button
                          onClick={() => handleEditQuote(q.id, q.title ?? q.quoteNumber ?? `견적 #${q.id}`)}
                          disabled={editLoading === q.id}
                          style={{
                            fontSize: 12, fontWeight: 600, color: '#111827',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            display: 'block', maxWidth: 220,
                            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                            textAlign: 'left',
                          }}
                        >
                          {q.title ?? q.projectTitle ?? '(미입력)'}
                        </button>
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
                      {/* PDF 미리보기 */}
                      <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                        <button
                          onClick={() => handlePdfPreview(q.id, q.title ?? q.quoteNumber ?? `견적 #${q.id}`)}
                          disabled={pdfLoading === q.id}
                          style={{
                            fontSize: 11, padding: '3px 9px', borderRadius: 5, cursor: 'pointer',
                            background: '#eff6ff', color: '#2563eb',
                            border: '1px solid #bfdbfe', fontWeight: 600,
                            opacity: pdfLoading === q.id ? 0.5 : 1,
                          }}
                          data-testid={`btn-pdf-preview-${q.id}`}
                          aria-label={`${q.quoteNumber ?? q.id} PDF 미리보기`}
                        >
                          {pdfLoading === q.id ? '…' : '📄 PDF'}
                        </button>
                      </td>
                      {/* 상태변경 */}
                      <td style={{ padding: '6px 10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                          {isConverted ? (
                            <span
                              style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, fontWeight: 700, background: '#dcfce7', color: '#15803d', whiteSpace: 'nowrap' }}
                              data-testid={`badge-quote-converted-${q.id}`}
                              aria-label={`${q.quoteNumber ?? q.id} 판매전환 완료`}
                            >
                              ✓ 판매전환 완료{q.projectId != null ? ` (판매 #${q.projectId})` : ''}
                            </span>
                          ) : (
                            <button
                              onClick={() => handleConvertToSale(q.id)}
                              disabled={isUpdating}
                              style={{
                                fontSize: 11, padding: '3px 8px', borderRadius: 5, cursor: 'pointer', whiteSpace: 'nowrap',
                                background: '#dcfce7', color: '#15803d',
                                border: 'none', fontWeight: 600, opacity: isUpdating ? 0.5 : 1,
                              }}
                              data-testid={`btn-quote-status-approved-${q.id}`}
                              aria-label={`${q.quoteNumber ?? q.id} 판매전환`}
                            >
                              {isUpdating ? '…' : '판매전환'}
                            </button>
                          )}
                          {/* 삭제 — 판매전환 완료 견적은 비활성 스타일 + 안내 (서버에서도 차단) */}
                          <button
                            onClick={() => canDelete ? setDeleteTarget(q) : onToast(DELETE_BLOCKED_MSG)}
                            title={canDelete ? '견적 삭제' : DELETE_BLOCKED_MSG}
                            aria-disabled={!canDelete}
                            data-testid={`btn-delete-quote-${q.id}`}
                            aria-label={`${q.quoteNumber ?? q.id} 삭제`}
                            style={{
                              fontSize: 11, padding: '3px 8px', borderRadius: 5, fontWeight: 600, whiteSpace: 'nowrap',
                              cursor: canDelete ? 'pointer' : 'not-allowed',
                              background: canDelete ? '#fef2f2' : '#f3f4f6',
                              color: canDelete ? '#dc2626' : '#9ca3af',
                              border: `1px solid ${canDelete ? '#fca5a5' : '#e5e7eb'}`,
                            }}
                          >
                            삭제
                          </button>
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

    {/* PDF 미리보기 모달 */}
    {pdfData && (
      <QuotePdfPreviewModal
        data={pdfData.data}
        quoteTitle={pdfData.title}
        onClose={() => setPdfData(null)}
      />
    )}

    {/* 견적 삭제 확인 모달 (Soft Delete) */}
    {deleteTarget && (
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onClick={() => { if (!deleting) { setDeleteTarget(null); setDeleteReason(''); } }}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{ background: '#fff', borderRadius: 14, padding: '26px 30px', width: 460, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}
          data-testid="modal-quote-delete"
        >
          <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 800, color: '#dc2626' }}>견적 삭제</h2>
          <p style={{ margin: '0 0 16px', fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
            삭제된 견적은 견적관리 목록에서 제거됩니다.
          </p>

          {/* 삭제 대상 정보 */}
          <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 14px', marginBottom: 16 }}>
            {[
              ['견적번호', deleteTarget.quoteNumber ?? `#${deleteTarget.id}`],
              ['견적서명', deleteTarget.title ?? deleteTarget.projectTitle ?? '(미입력)'],
              ['거래처',   deleteTarget.companyName ?? '—'],
              ['고객명',   deleteTarget.contactName ?? '—'],
              ['견적금액', `${fmt(deleteTarget.price)}원`],
            ].map(([label, value]) => (
              <div key={label} style={{ display: 'flex', gap: 10, fontSize: 12.5, padding: '3px 0' }}>
                <span style={{ width: 64, flexShrink: 0, color: '#9ca3af', fontWeight: 600 }}>{label}</span>
                <span style={{ color: '#111827', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
              </div>
            ))}
          </div>

          {/* 삭제 사유 (필수) */}
          <label style={{ display: 'block', fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 6 }}>
            삭제 사유 <span style={{ color: '#dc2626' }}>*</span>
          </label>
          <textarea
            value={deleteReason}
            onChange={e => setDeleteReason(e.target.value)}
            placeholder="예: 중복 견적 생성 / 고객 요청으로 견적 철회 / 잘못 작성된 견적"
            rows={3}
            data-testid="input-quote-delete-reason"
            aria-label="삭제 사유 입력"
            style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box', outline: 'none', resize: 'vertical', marginBottom: 4, fontFamily: 'inherit' }}
          />
          <p style={{ margin: '0 0 18px', fontSize: 11, color: '#9ca3af' }}>최소 2자 이상 입력해 주세요. (공백만 입력 불가)</p>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button
              onClick={() => { setDeleteTarget(null); setDeleteReason(''); }}
              disabled={deleting}
              data-testid="btn-quote-delete-cancel"
              style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: deleting ? 'not-allowed' : 'pointer', color: '#374151' }}
            >
              취소
            </button>
            <button
              onClick={handleDeleteQuote}
              disabled={deleteReason.trim().length < 2 || deleting}
              data-testid="btn-quote-delete-confirm"
              style={{
                padding: '9px 20px', borderRadius: 8, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700,
                background: deleteReason.trim().length >= 2 && !deleting ? '#dc2626' : '#fca5a5',
                cursor: deleteReason.trim().length >= 2 && !deleting ? 'pointer' : 'not-allowed',
              }}
            >
              {deleting ? '삭제 중…' : '삭제'}
            </button>
          </div>
        </div>
      </div>
    )}

    </>
  );
}
