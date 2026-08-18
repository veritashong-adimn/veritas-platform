import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/constants';
import { PrimaryBtn, ClickSelect } from '../ui';
import { QuoteEditorWorkspace, type QuoteItemForm, type VatType, type QuoteType } from './QuoteEditorWorkspace';
import QuotePdfPreviewModal from './QuotePdfPreviewModal';
import { QuoteTrashTab } from './QuoteTrashTab';
import { buildQuotePdfData, type QuoteDetail, type QuoteDetailItem } from '../../lib/quotePdf';
import { convertToFormItem } from '../../lib/quoteItemForm';
import { renderQuoteTitle, formatDocNumber } from '../../lib/quoteTitle';
import { bulkBtnStyle } from './product/productShared';
import { stickyBulkBarStyle } from './bulkListShared';

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
  approved: '판매',
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
  adminUsers?: Array<{ id: number; name?: string | null; email: string }>;
  /** AdminDashboard fetchAll 호출 시 증가 — QuoteListTab 자동 재조회 트리거 */
  refreshTick?: number;
  /** 관리자 여부 — 휴지통 영구삭제 버튼 노출 제어(서버에서도 별도 검증) */
  isAdmin?: boolean;
  /** 상세 화면 '판매관리 보기' → 판매관리(프로젝트) 탭으로 이동 */
  onNavigateToSales?: () => void;
  /** 견적 상세 판매전환 성공 시 자동 생성된 판매 상세페이지(/sales/:id)로 이동 */
  onOpenSalesDetail?: (projectId: number) => void;
  /** 판매전환 권한 충족 여부(기본 true) — 견적 상세 판매전환 버튼 활성 제어 */
  canConvert?: boolean;
}

export function QuoteListTab({ token, onToast, adminUsers = [], refreshTick, isAdmin = false, onNavigateToSales, onOpenSalesDetail, canConvert: convertPerm = true }: QuoteListTabProps) {
  const authH = { Authorization: `Bearer ${token}` };

  const [quotes, setQuotes]             = useState<QuoteRow[]>([]);
  const [loading, setLoading]           = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter]     = useState('all');
  const [search, setSearch]             = useState('');
  const [dateFrom, setDateFrom]         = useState('');
  const [dateTo, setDateTo]             = useState('');
  const [showEditor, setShowEditor]     = useState(false);
  const [showTrash, setShowTrash]       = useState(false);
  const [pdfData,    setPdfData]        = useState<{ data: ReturnType<typeof buildQuotePdfData>; title: string } | null>(null);
  const [pdfLoading, setPdfLoading]     = useState<number | null>(null);
  // 편집 모드
  const [editLoading,  setEditLoading]  = useState<number | null>(null);
  const [editQuoteId,  setEditQuoteId]  = useState<number | null>(null);
  const [editInitData, setEditInitData] = useState<{
    items: QuoteItemForm[]; title: string; note: string;
    quoteType: QuoteType; issueDate: string; vatType: VatType;
    companyId: number | null; contactId: number | null; divisionId: number | null;
    status: string;
  } | null>(null);
  // 선택 기반 일괄 관리
  const [selectedIds, setSelectedIds]   = useState<Set<number>>(new Set());
  const [bulkConvertOpen, setBulkConvertOpen]   = useState(false);
  const [bulkConverting, setBulkConverting]     = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen]     = useState(false);
  const [bulkDeleteReason, setBulkDeleteReason] = useState('');
  const [bulkDeleting, setBulkDeleting]         = useState(false);

  const fetchQuotes = useCallback(async () => {
    setLoading(true);
    setSelectedIds(new Set()); // 재조회(필터/작업 후) 시 선택 초기화
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

  // PDF 미리보기 핸들러 — 단건 견적 상세 조회 후 모달 열기
  const handlePdfPreview = async (quoteId: number, title: string) => {
    setPdfLoading(quoteId);
    try {
      const res = await fetch(api(`/api/admin/quotes/${quoteId}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        onToast(`견적서 미리보기 실패: ${err.error ?? res.status}`);
        return;
      }
      const detail = await res.json() as QuoteDetail;
      if (!detail.items || detail.items.length === 0) {
        onToast('견적 품목이 없습니다. 품목을 먼저 입력해 주세요.');
        return;
      }
      setPdfData({ data: buildQuotePdfData(detail), title });
    } catch {
      onToast('견적서 생성에 실패했습니다. 다시 시도해 주세요.');
    } finally {
      setPdfLoading(null);
    }
  };

  // QuoteDetailItem → QuoteItemForm 변환은 lib/quoteItemForm.convertToFormItem 로 공용화
  // (판매관리 읽기전용 뷰와 동일 로직 재사용).

  // 기존 견적 편집 진입 — status는 목록 행 값을 기본으로 하되 상세 응답에 있으면 우선 사용(판매전환 표시용)
  const handleEditQuote = useCallback(async (quoteId: number, quoteTitle: string, rowStatus?: string) => {
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
        divisionId: (detail as any).divisionId ?? null,
        status: (detail as any).status ?? rowStatus ?? 'pending',
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
      formatDocNumber('Q', q.quoteNumber, q.issueDate).toLowerCase().includes(s) ||  // 새 표시 형식(Q260716-008)으로도 검색
      (q.title ?? '').toLowerCase().includes(s) ||
      (q.companyName ?? '').toLowerCase().includes(s) ||
      (q.contactName ?? '').toLowerCase().includes(s) ||
      (q.adminName ?? '').toLowerCase().includes(s) ||
      (q.firstProductName ?? '').toLowerCase().includes(s)
    );
  });

  const fmt = (v: string | null) => v ? Number(v).toLocaleString() : '—';
  const hasAnyFilter = !!(search || dateFrom || dateTo || statusFilter !== 'all' || typeFilter !== 'all');

  // ── 선택 기반 일괄 관리 ─────────────────────────────────────────────────────
  // 검색(클라이언트) 변경 시 선택 초기화 (필터/재조회는 fetchQuotes 에서 초기화)
  useEffect(() => { setSelectedIds(new Set()); }, [search]);

  const selectedQuotes = filtered.filter(q => selectedIds.has(q.id)); // 현재 표시된 것만
  const selectedCount = selectedQuotes.length;
  // 판매전환 가능 = 선택 1건+ 이며 선택 전부가 미전환(대기). 이미 판매전환(approved)된 건이 섞이면 비활성.
  // (전환 여부 판단은 status 기준 — projectId는 견적 저장 시 거래처 연결용으로 미리 붙을 수 있어 사용하지 않음)
  const convertBlockedReason = selectedCount === 0
    ? undefined
    : selectedQuotes.some(q => q.status === 'approved')
      ? '이미 판매전환된 견적이 포함되어 있습니다. 판매전환은 대기 상태의 견적만 가능합니다.'
      : undefined;
  const canConvert = selectedCount > 0 && !convertBlockedReason;
  const allSelected = filtered.length > 0 && filtered.every(q => selectedIds.has(q.id));
  const toggleSelect = (id: number) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleSelectAll = () => setSelectedIds(allSelected ? new Set() : new Set(filtered.map(q => q.id)));

  const editRow = (q: QuoteRow) => handleEditQuote(q.id, q.title ?? q.quoteNumber ?? `견적 #${q.id}`, q.status);
  const handleDetailSelected = () => { if (selectedCount === 1) editRow(selectedQuotes[0]); };

  // 일괄 판매전환 — 이미 전환된(approved) 건 섞이면 전체 차단
  const openBulkConvert = () => {
    if (selectedCount === 0) return;
    if (selectedQuotes.some(q => q.status === 'approved')) { onToast('선택한 견적 중 이미 판매전환된 건이 포함되어 있습니다.'); return; }
    setBulkConvertOpen(true);
  };
  const handleBulkConvert = async () => {
    const targets = selectedQuotes.filter(q => q.status !== 'approved');
    setBulkConverting(true);
    try {
      const results = await Promise.all(targets.map(async q => {
        try {
          const res = await fetch(api(`/api/admin/quotes/${q.id}/status`), {
            method: 'PATCH', headers: { ...authH, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved' }),
          });
          const d = await res.json().catch(() => null);
          return { q, ok: res.ok, error: d?.error as string | undefined };
        } catch { return { q, ok: false, error: '네트워크 오류' }; }
      }));
      const ok = results.filter(r => r.ok).length;
      const fails = results.filter(r => !r.ok);
      setBulkConvertOpen(false);
      let msg = `${ok}건 판매전환되었습니다.`;
      if (fails.length) msg += ` ${fails.length}건 실패 — ` + fails.map(f => `${f.q.quoteNumber ?? f.q.id}: ${f.error ?? '실패'}`).join(' / ');
      onToast(msg);
      fetchQuotes();
    } finally { setBulkConverting(false); }
  };

  // 일괄 선택삭제 — 판매전환 완료(approved)는 삭제 불가, 섞이면 차단. 삭제사유 필수(≥2자).
  const openBulkDelete = () => {
    if (selectedCount === 0) return;
    if (selectedQuotes.some(q => q.status === 'approved')) { onToast('선택한 견적 중 삭제할 수 없는 상태(판매전환 완료)가 포함되어 있습니다. 먼저 판매취소가 필요합니다.'); return; }
    setBulkDeleteReason('');
    setBulkDeleteOpen(true);
  };
  const handleBulkDelete = async () => {
    const reason = bulkDeleteReason.trim();
    if (reason.length < 2) { onToast('삭제 사유를 2자 이상 입력해 주세요.'); return; }
    const targets = selectedQuotes.filter(q => q.status !== 'approved');
    setBulkDeleting(true);
    try {
      const results = await Promise.all(targets.map(async q => {
        try {
          const res = await fetch(api(`/api/admin/quotes/${q.id}`), {
            method: 'DELETE', headers: { ...authH, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
          });
          const d = await res.json().catch(() => null);
          return { q, ok: res.ok, error: d?.error as string | undefined };
        } catch { return { q, ok: false, error: '네트워크 오류' }; }
      }));
      const ok = results.filter(r => r.ok).length;
      const fails = results.filter(r => !r.ok);
      setBulkDeleteOpen(false);
      setBulkDeleteReason('');
      let msg = `${ok}건의 견적을 삭제했습니다.`;
      if (fails.length) msg += ` ${fails.length}건 실패 — ` + fails.map(f => `${f.q.quoteNumber ?? f.q.id}: ${f.error ?? '실패'}`).join(' / ');
      onToast(msg);
      fetchQuotes();
    } finally { setBulkDeleting(false); }
  };

  // ── 견적서 작성/편집 Workspace ──────────────────────────────────────────────
  if (showEditor) {
    // full-bleed sticky 헤더는 QuoteEditorWorkspace 내부에서 dsStickyPageHeader()로
    // 스크롤 패딩을 상쇄하므로, 여기서 별도의 음수 margin wrapper가 필요 없다.
    return (
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
        initialDivisionId={editInitData?.divisionId ?? null}
        initialStatus={editInitData?.status}
        onConverted={fetchQuotes}
        onNavigateToSales={onNavigateToSales}
        onOpenSalesDetail={onOpenSalesDetail}
        canConvert={convertPerm}
      />
    );
  }

  // ── 견적 휴지통 페이지 ───────────────────────────────────────────────────────
  // QuoteTrashTab 헤더도 dsStickyPageHeader()로 full-bleed 처리 → wrapper 불필요.
  if (showTrash) {
    return (
      <QuoteTrashTab
        token={token}
        isAdmin={isAdmin}
        onToast={onToast}
        onBack={() => { setShowTrash(false); fetchQuotes(); }}
      />
    );
  }

  // 현황 KPI 데이터
  const kpiItems = [
    { label: '전체', value: 'all',      count: quotes.length,                                       color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' },
    { label: '대기', value: 'pending',  count: quotes.filter(q => q.status === 'pending').length,   color: '#6b7280', bg: '#f9fafb', border: '#e5e7eb' },
    { label: '판매', value: 'approved', count: quotes.filter(q => q.status === 'approved').length,  color: '#15803d', bg: '#dcfce7', border: '#86efac' },
  ];

  return (
    <>
    <div style={{ padding: '0 0 48px' }}>

      {/* ── Card 1: 검색 및 필터 ────────────────────────────────────────────────── */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 16px', marginBottom: 8 }}>
        {/* 카드 헤더 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', letterSpacing: '0.2px' }}>검색 및 필터</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <PrimaryBtn onClick={() => setShowEditor(true)} style={{ fontSize: 12, padding: '5px 12px' }}>
              + 견적서 작성
            </PrimaryBtn>
            {/* 휴지통 — 삭제된(휴지통) 견적 전용 페이지로 이동 (사이드바 메뉴 추가 없음) */}
            <button type="button" onClick={() => setShowTrash(true)}
              data-testid="btn-quote-trash" aria-label="견적 휴지통"
              style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, cursor: 'pointer', background: '#fff', color: '#6b7280', border: '1px solid #d1d5db', fontWeight: 600 }}
              onMouseEnter={e => { e.currentTarget.style.background = '#f9fafb'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}>
              🗑 휴지통
            </button>
          </div>
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
                { value: 'approved', label: '판매' },
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

        {/* 선택 기반 공통 작업 바 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10, padding: '9px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, ...stickyBulkBarStyle }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#374151', cursor: 'pointer', fontWeight: 600 }}>
            <input type="checkbox" checked={allSelected} onChange={toggleSelectAll}
              aria-label="현재 페이지 전체 선택" data-testid="quote-bulk-select-all"
              style={{ width: 15, height: 15, cursor: 'pointer' }} />
            현재 페이지 전체선택
          </label>
          <span data-testid="quote-selected-count" style={{ fontSize: 12.5, fontWeight: 700, color: selectedCount > 0 ? '#2563eb' : '#9ca3af' }}>
            선택 {selectedCount}건
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={handleDetailSelected} disabled={selectedCount !== 1}
            title={selectedCount >= 2 ? '상세보기는 하나의 견적만 선택할 수 있습니다.' : undefined}
            data-testid="quote-bulk-detail" style={bulkBtnStyle(selectedCount === 1, '#2563eb', '#eff6ff', '#bfdbfe', { padding: '6px 14px' })}>
            상세보기
          </button>
          <button onClick={openBulkConvert} disabled={!canConvert}
            title={convertBlockedReason}
            data-testid="quote-bulk-convert" style={bulkBtnStyle(canConvert, '#15803d', '#f0fdf4', '#86efac', { padding: '6px 14px' })}>
            판매전환
          </button>
          <button onClick={openBulkDelete} disabled={selectedCount < 1}
            data-testid="quote-bulk-delete" style={bulkBtnStyle(selectedCount >= 1, '#dc2626', '#fef2f2', '#fecaca', { padding: '6px 14px' })}>
            선택삭제
          </button>
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
                  <th style={{ padding: '6px 10px', textAlign: 'center', width: 36 }}>
                    <input type="checkbox" checked={allSelected} onChange={toggleSelectAll}
                      aria-label="현재 페이지 전체 선택" data-testid="quote-select-all"
                      style={{ width: 15, height: 15, cursor: 'pointer' }} />
                  </th>
                  {['견적번호', '발행일', '견적서명', '고객사', '고객명', '금액', '견적유형', '담당PM', '상태', '견적서'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 11, fontWeight: 700, color: '#6b7280', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(q => {
                  const sColor = QUOTE_STATUS_COLOR[q.status] ?? { bg: '#f3f4f6', color: '#6b7280' };
                  const selected = selectedIds.has(q.id);

                  return (
                    <tr key={q.id}
                      onClick={() => editRow(q)}
                      style={{ borderBottom: '1px solid #f1f5f9', cursor: 'pointer', background: selected ? '#eff6ff' : undefined }}>
                      {/* 선택 체크박스 — 클릭은 선택만(행 상세 진입과 분리) */}
                      <td onClick={e => e.stopPropagation()} style={{ padding: '6px 10px', textAlign: 'center' }}>
                        <input type="checkbox" checked={selected} onChange={() => toggleSelect(q.id)}
                          aria-label={`견적 선택: ${q.quoteNumber ?? q.id}`} data-testid={`quote-select-${q.id}`}
                          style={{ width: 15, height: 15, cursor: 'pointer' }} />
                      </td>
                      {/* 견적번호 — 표시 형식 Q{YYMMDD}-{순번}. 클릭 시 편집(식별자 역할이라 과한 강조 제거) */}
                      <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', textAlign: 'center' }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleEditQuote(q.id, q.title ?? q.quoteNumber ?? `견적 #${q.id}`, q.status); }}
                          disabled={editLoading === q.id}
                          style={{
                            fontFamily: 'monospace', fontSize: 11, color: '#475569', fontWeight: 400,
                            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                            textDecoration: 'none', opacity: editLoading === q.id ? 0.5 : 1,
                          }}
                          onMouseEnter={e => { e.currentTarget.style.textDecoration = 'underline'; }}
                          onMouseLeave={e => { e.currentTarget.style.textDecoration = 'none'; }}
                          data-testid={`btn-edit-quote-${q.id}`}
                          aria-label={`${q.quoteNumber ?? q.id} 편집`}
                        >
                          {editLoading === q.id ? '…' : (formatDocNumber('Q', q.quoteNumber, q.issueDate) || `#${q.id}`)}
                        </button>
                      </td>
                      {/* 발행일 */}
                      <td style={{ padding: '6px 10px', fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap', textAlign: 'center' }}>
                        {q.issueDate ?? '—'}
                      </td>
                      {/* 견적서명 — 지정 범위(min 220 ~ max 420, 약 24vw ≈ 테이블 30~34% 이내)에서만 반응형, 좌측 정렬, 클릭 시 편집 */}
                      <td style={{ padding: '6px 10px', textAlign: 'left' }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleEditQuote(q.id, q.title ?? q.quoteNumber ?? `견적 #${q.id}`, q.status); }}
                          disabled={editLoading === q.id}
                          style={{
                            fontSize: 12, fontWeight: 600, color: '#111827',
                            display: 'flex', alignItems: 'center', overflow: 'hidden',
                            width: '24vw', minWidth: 220, maxWidth: 420,
                            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                            textAlign: 'left',
                          }}
                        >
                          {renderQuoteTitle(q.title ?? q.projectTitle ?? '(미입력)')}
                        </button>
                      </td>
                      {/* 고객사 — 좌측 정렬, 약간 확대(min 130 ~ max 200) */}
                      <td style={{ padding: '6px 10px', minWidth: 130, maxWidth: 200, textAlign: 'left' }}>
                        {q.companyName
                          ? <span style={{ fontSize: 12, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{q.companyName}</span>
                          : <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>}
                      </td>
                      {/* 고객명 — 가운데 정렬, 이름 표시 최소폭 확보 */}
                      <td style={{ padding: '6px 10px', minWidth: 80, maxWidth: 120, textAlign: 'center' }}>
                        {q.contactName
                          ? <span style={{ fontSize: 12, color: '#374151', whiteSpace: 'nowrap' }}>{q.contactName}</span>
                          : <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>}
                      </td>
                      {/* 금액 — 우측 정렬, 한 줄 표시 최소폭 확보 */}
                      <td style={{ padding: '6px 10px', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700, color: '#1e3a5f', fontSize: 13, minWidth: 104 }}>
                        {fmt(q.price)}원
                      </td>
                      {/* 견적유형 — 가운데 정렬 */}
                      <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', textAlign: 'center' }}>
                        <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: '#f0f9ff', color: '#0369a1', fontWeight: 600 }}>
                          {QUOTE_TYPE_LABEL[q.quoteType] ?? q.quoteType}
                        </span>
                      </td>
                      {/* 담당PM — 가운데 정렬 */}
                      <td style={{ padding: '6px 10px', minWidth: 72, maxWidth: 110, textAlign: 'center' }}>
                        {q.adminName
                          ? <span style={{ fontSize: 12, color: '#374151', whiteSpace: 'nowrap' }}>{q.adminName}</span>
                          : <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>}
                      </td>
                      {/* 상태 — 가운데 정렬 */}
                      <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, fontWeight: 700, background: sColor.bg, color: sColor.color }}>
                          {QUOTE_STATUS_LABEL[q.status] ?? q.status}
                        </span>
                      </td>
                      {/* PDF 미리보기 — 가운데 정렬 */}
                      <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', textAlign: 'center' }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); handlePdfPreview(q.id, q.title ?? q.quoteNumber ?? `견적 #${q.id}`); }}
                          disabled={pdfLoading === q.id}
                          style={{
                            fontSize: 11, padding: '3px 9px', borderRadius: 5, cursor: 'pointer',
                            background: '#eff6ff', color: '#2563eb',
                            border: '1px solid #bfdbfe', fontWeight: 600,
                            opacity: pdfLoading === q.id ? 0.5 : 1,
                          }}
                          data-testid={`btn-pdf-preview-${q.id}`}
                          aria-label={`${q.quoteNumber ?? q.id} 견적서 미리보기`}
                        >
                          {pdfLoading === q.id ? '…' : '📄 견적서'}
                        </button>
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

    {/* 일괄 판매전환 확인 모달 */}
    {bulkConvertOpen && (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ background: '#fff', borderRadius: 14, padding: '26px 30px', width: 440, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }} data-testid="modal-bulk-convert">
          <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 800, color: '#15803d' }}>견적 일괄 판매전환</h2>
          <p style={{ margin: '0 0 8px', fontSize: 14, color: '#374151' }}>선택한 {selectedCount}건을 판매전환하시겠습니까?</p>
          <p style={{ margin: '0 0 20px', fontSize: 12, color: '#6b7280', lineHeight: 1.6 }}>판매전환 후 판매관리에서 배정·진행·납품을 계속 관리할 수 있습니다.</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => setBulkConvertOpen(false)} disabled={bulkConverting}
              style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: bulkConverting ? 'not-allowed' : 'pointer', color: '#374151' }}>취소</button>
            <button onClick={handleBulkConvert} disabled={bulkConverting} data-testid="confirm-bulk-convert"
              style={{ padding: '9px 20px', borderRadius: 8, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, background: bulkConverting ? '#9ca3af' : '#16a34a', cursor: bulkConverting ? 'not-allowed' : 'pointer' }}>
              {bulkConverting ? '처리 중…' : '판매전환'}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* 일괄 선택삭제 확인 모달 (Soft Delete, 사유 필수) */}
    {bulkDeleteOpen && (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onClick={() => { if (!bulkDeleting) { setBulkDeleteOpen(false); setBulkDeleteReason(''); } }}>
        <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: '26px 30px', width: 460, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }} data-testid="modal-bulk-quote-delete">
          <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 800, color: '#dc2626' }}>선택한 {selectedCount}건의 견적을 삭제하시겠습니까?</h2>
          <p style={{ margin: '0 0 16px', fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
            삭제된 견적서는 휴지통으로 이동되며, 기본 목록에서 제외됩니다.<br />
            필요한 경우 휴지통에서 복원할 수 있습니다.
          </p>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 6 }}>
            삭제 사유 <span style={{ color: '#dc2626' }}>*</span>
          </label>
          <textarea
            value={bulkDeleteReason}
            onChange={e => setBulkDeleteReason(e.target.value)}
            placeholder="예: 중복 견적 생성 / 고객 요청으로 견적 철회 / 잘못 작성된 견적"
            rows={3}
            data-testid="input-bulk-quote-delete-reason"
            aria-label="삭제 사유 입력"
            style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box', outline: 'none', resize: 'vertical', marginBottom: 4, fontFamily: 'inherit' }}
          />
          <p style={{ margin: '0 0 18px', fontSize: 11, color: '#9ca3af' }}>선택 전체에 동일 적용됩니다. 최소 2자 이상 입력해 주세요. (공백만 입력 불가)</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => { setBulkDeleteOpen(false); setBulkDeleteReason(''); }} disabled={bulkDeleting}
              style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: bulkDeleting ? 'not-allowed' : 'pointer', color: '#374151' }}>취소</button>
            <button onClick={handleBulkDelete} disabled={bulkDeleteReason.trim().length < 2 || bulkDeleting} data-testid="confirm-bulk-quote-delete"
              style={{
                padding: '9px 20px', borderRadius: 8, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700,
                background: bulkDeleteReason.trim().length >= 2 && !bulkDeleting ? '#dc2626' : '#fca5a5',
                cursor: bulkDeleteReason.trim().length >= 2 && !bulkDeleting ? 'pointer' : 'not-allowed',
              }}>
              {bulkDeleting ? '삭제 중…' : '삭제'}
            </button>
          </div>
        </div>
      </div>
    )}

    </>
  );
}
