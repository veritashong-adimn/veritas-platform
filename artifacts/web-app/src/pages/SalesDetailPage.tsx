// ─────────────────────────────────────────────────────────────────────────────
// 판매 상세 페이지 (독립 전체 페이지형)
//
// 판매관리 목록 → 판매건 클릭 시 진입하는 상세 화면.
// 견적관리 상세화면과 동일한 디자인 시스템(Card / CardSectionHeader / ds 토큰)을
// 재사용하여, 해당 판매건과 연결된 "원본 견적정보"를 읽기전용으로 표시한다.
//
// 데이터: GET /api/admin/projects/:id 가 연결된 현재 견적(isCurrent=true)과
//        그 품목(items)까지 함께 반환하므로 별도 API 추가 없이 재사용한다.
// PDF   : 견적서 = QuotePdfPreviewModal / 거래명세서 = TransactionStatementModal
//        (둘 다 기존 견적관리·판매모달과 동일 파이프라인: buildQuotePdfData)
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Product } from '../lib/constants';
import { Card, StatusBadge, Toast, GhostBtn, PrimaryBtn } from '../components/ui';
import { C, TYPO, SP, BD, dsInputStd } from '../lib/ds';
import { buildQuotePdfData, type QuoteDetail } from '../lib/quotePdf';
import { renderQuoteTitle, formatDocNumber } from '../lib/quoteTitle';
import QuotePdfPreviewModal from '../components/admin/QuotePdfPreviewModal';
import { BackToListButton } from '../components/admin/BackToListButton';
import TransactionStatementModal from '../components/admin/TransactionStatementModal';
import QuoteItemsView, { SaleTotalsRows } from '../components/admin/QuoteItemsView';
import { QuoteItemsEditor, buildQuoteItemsBody, calcTotals, type QuoteItemForm } from '../components/admin/QuoteEditorWorkspace';
import { convertToFormItem } from '../lib/quoteItemForm';
import PerformanceSection from '../components/admin/PerformanceSection';
import PaymentInfoSection from '../components/admin/PaymentInfoSection';

// ─── 로컬 라벨 맵 (견적관리 상세와 동일 문구) ────────────────────────────────
const QUOTE_TYPE_LABEL: Record<string, string> = {
  b2b_standard:      '일반 견적서',
  b2c_prepaid:       '차감(선입금) 견적서',
  prepaid_deduction: '선입금 차감 견적서',
  accumulated_batch: '누적 견적서',
};
const VAT_LABEL: Record<string, string> = {
  taxable:   '부가세 10%',
  exempt:    '면세',
  zero_rate: '영세율',
};

// ─── CardSectionHeader — QuoteEditorWorkspace의 동일 컴포넌트 복제 ────────────
// (원본은 export 되어 있지 않아 디자인 시스템 토큰으로 동일하게 재현)
function CardSectionHeader({ badge, badgeBg, badgeColor, title, hint, right }: {
  badge: string; badgeBg: string; badgeColor: string; title: string; hint?: string; right?: React.ReactNode;
}) {
  return (
    <div style={{ ...TYPO.sectionTitle, paddingBottom: SP[4], borderBottom: BD.grid, marginBottom: SP[6], display: 'flex', alignItems: 'center', gap: SP[3] }}>
      <span style={{ width: 22, height: 22, borderRadius: BD.radius.md, background: badgeBg, color: badgeColor, fontSize: 12, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{badge}</span>
      {title}
      {hint && <span style={{ ...TYPO.helper, marginLeft: SP[2] }}>{hint}</span>}
      {right && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 14, flexWrap: 'wrap' }}>{right}</div>}
    </div>
  );
}

// ─── 읽기전용 필드 (라벨 + 값 박스) ──────────────────────────────────────────
function ReadField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: SP[2] }}>{label}</label>
      <div style={{ ...dsInputStd(), display: 'flex', alignItems: 'center', minHeight: 38, background: '#f9fafb', color: C.g900, cursor: 'default' }}>
        {value ?? <span style={{ color: C.g400 }}>—</span>}
      </div>
    </div>
  );
}

// ─── Props ───────────────────────────────────────────────────────────────────
interface AdminUserLite { id: number; name?: string | null | undefined; email: string }
interface SalesDetailPageProps {
  saleId: number;
  token: string;
  adminUsers?: AdminUserLite[];
  onBack: () => void;
}

export function SalesDetailPage({ saleId, token, adminUsers = [], onBack }: SalesDetailPageProps) {
  const authH = { Authorization: `Bearer ${token}` };

  const [loading, setLoading] = useState(true);
  const [project, setProject] = useState<any>(null);
  const [toast, setToast] = useState('');

  // ── 우측 하단 플로팅 "목록으로" — 상단 버튼이 뷰포트에서 벗어나면 표시(§2·§7) ──
  //  · 임의 scrollY 임계값이 아니라 상단 버튼의 실제 가시성(IntersectionObserver)으로 판정 →
  //    화면 크기·레이아웃 변경에 안정적. 클릭 핸들러는 상단과 동일한 onBack 재사용(§5·§6).
  const topBackRef = useRef<HTMLDivElement>(null);
  const [showFloatBack, setShowFloatBack] = useState(false);
  useEffect(() => {
    const el = topBackRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([entry]) => setShowFloatBack(!entry.isIntersecting),
      { root: null, threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [project, loading]);   // 상단 버튼이 마운트된 뒤(로딩 완료·프로젝트 로드) 관찰 시작

  const [pdfData,  setPdfData]  = useState<{ data: ReturnType<typeof buildQuotePdfData>; title: string } | null>(null);
  const [stmtData, setStmtData] = useState<{ data: ReturnType<typeof buildQuotePdfData>; title: string } | null>(null);
  const [pdfLoading,  setPdfLoading]  = useState(false);
  const [stmtLoading, setStmtLoading] = useState(false);
  const [deleting,    setDeleting]    = useState(false);

  // ── 판매정보 수정모드 (기본=조회) ─────────────────────────────────────────
  const [editMode,  setEditMode]  = useState(false);
  const [editItems, setEditItems] = useState<QuoteItemForm[]>([]);
  const [products,  setProducts]  = useState<Product[]>([]);
  const [saving,    setSaving]    = useState(false);

  // ── 판매 상세(=프로젝트 + 원본 견적) 조회 ─────────────────────────────────
  // silent=true: 저장 후 백그라운드 갱신(예: 수행정보 추가비용 저장). 로딩 오버레이로 화면을 비우지 않아
  //   상세페이지가 언마운트/리마운트되지 않고, 스크롤 위치·수정모드·필터·행 위치가 그대로 유지된다.
  const fetchDetail = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!silent) setLoading(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${saleId}`), { headers: authH });
      if (!res.ok) {
        setToast(`판매건 조회 실패 (${res.status})`);
        if (!silent) setProject(null);   // 백그라운드 갱신 실패 시 현재 화면 유지(비우지 않음)
        return;
      }
      setProject(await res.json());
    } catch {
      setToast('판매 상세 조회 중 오류가 발생했습니다.');
    } finally {
      if (!silent) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleId, token]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  // ── 연결된 현재 견적 ───────────────────────────────────────────────────────
  const quote = project?.quotes?.find((q: any) => q.isCurrent) ?? project?.quotes?.[0] ?? null;
  const items: any[] = quote?.items ?? [];
  const saleConfirmed = ['approved', 'paid', 'matched', 'in_progress', 'completed'].includes(project?.status);

  const quoteDocTitle = quote ? (quote.title ?? quote.quoteNumber ?? `견적 #${quote.id}`) : '';

  // ── 판매정보 수정모드: 진입 / 취소 / 저장 ─────────────────────────────────
  // 편집 컴포넌트(QuoteItemsEditor)·저장 payload 빌더(buildQuoteItemsBody)는 견적관리와 공용.
  // 상품 검색용 마스터는 수정모드 진입 시 1회 로드한다.
  const loadProducts = useCallback(async () => {
    if (products.length > 0) return;
    try {
      const res = await fetch(api('/api/admin/products'), { headers: authH });
      const data = await res.json().catch(() => []);
      setProducts(Array.isArray(data) ? data.filter((p: Product) => p.active) : []);
    } catch { /* 상품 로드 실패 시 검색만 제한 — 편집 자체는 가능 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products.length, token]);

  const enterEdit = () => {
    setEditItems(items.map(convertToFormItem));   // 저장 품목 → 폼 모델(견적 편집 진입과 동일 해석)
    loadProducts();
    setEditMode(true);
  };

  const cancelEdit = () => {
    setEditItems([]);       // 수정 내용 폐기 → 조회는 원본 items 사용 (수정 전 상태 복원)
    setEditMode(false);
  };

  // 저장 = 현재 판매 견적 in-place 갱신(품목만). 원견적/파생견적 엔진은 이번 범위 아님 —
  // 향후 엔진 도입 시 이 함수 한 곳만 판매적용 엔드포인트로 교체하면 된다.
  const saveSaleItems = async () => {
    if (!quote || saving) return;
    if (editItems.length === 0) { setToast('최소 1개 이상의 품목이 필요합니다.'); return; }
    setSaving(true);
    try {
      const vat = items[0]?.taxType ?? 'taxable';   // 판매 견적의 부가세 유형(품목 기준)
      const issue = quote.issueDate || undefined;
      const validUntil = issue
        ? (d => d.toISOString().split('T')[0])(new Date(new Date(issue).getTime() + 30 * 86400000))
        : undefined;
      const res = await fetch(api(`/api/admin/quotes/${quote.id}`), {
        method: 'PUT',
        headers: { ...authH, 'Content-Type': 'application/json' },
        // 품목만 갱신 — 메타데이터(제목/비고/유형/견적일)는 기존값 유지, 프로젝트 CRM 링크는 미전송(불변)
        body: JSON.stringify({
          items: buildQuoteItemsBody(editItems, vat),
          quoteType: quote.quoteType,
          billingType: 'postpaid_per_project',
          taxDocumentType: 'tax_invoice',
          taxCategory: 'normal',
          issueDate: issue,
          validUntil,
          note: quote.note ?? undefined,
          title: quote.title ?? undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setToast(`판매정보 저장 실패: ${data.error ?? res.status}`); return; }
      setEditMode(false);
      setEditItems([]);
      await fetchDetail();          // 서버 재계산 금액 반영
      setToast('판매정보가 저장되었습니다.');
    } catch {
      setToast('판매정보 저장 중 오류가 발생했습니다. 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  };

  // ── 견적서 PDF (기존 견적관리와 동일 파이프라인) ──────────────────────────
  const handleQuotePdf = async () => {
    if (!quote) return;
    setPdfLoading(true);
    try {
      const res = await fetch(api(`/api/admin/quotes/${quote.id}`), { headers: authH });
      if (!res.ok) { setToast(`견적서 생성 실패 (${res.status})`); return; }
      const detail = await res.json() as QuoteDetail;
      if (!detail.items || detail.items.length === 0) { setToast('견적 품목이 없습니다.'); return; }
      setPdfData({ data: buildQuotePdfData(detail), title: quoteDocTitle });
    } catch {
      setToast('견적서 생성에 실패했습니다. 다시 시도해 주세요.');
    } finally {
      setPdfLoading(false);
    }
  };

  // ── 거래명세서 PDF (판매 확정 건만) ────────────────────────────────────────
  const handleStatement = async () => {
    if (!quote) return;
    setStmtLoading(true);
    try {
      const res = await fetch(api(`/api/admin/quotes/${quote.id}`), { headers: authH });
      if (!res.ok) { setToast(`거래명세서 생성 실패 (${res.status})`); return; }
      const detail = await res.json() as QuoteDetail;
      if (!detail.items || detail.items.length === 0) { setToast('견적 품목이 없습니다.'); return; }
      setStmtData({ data: buildQuotePdfData(detail), title: quoteDocTitle });
    } catch {
      setToast('거래명세서 생성에 실패했습니다. 다시 시도해 주세요.');
    } finally {
      setStmtLoading(false);
    }
  };

  // ── 판매취소 = 판매전환 취소 → 원본 견적을 견적관리로 복귀 (DB 완전삭제 아님) ──
  const handleCancelSale = async () => {
    if (deleting) return;
    if (!window.confirm('이 판매를 취소하시겠습니까?\n판매전환이 취소되고 원본 견적이 견적관리로 복귀합니다. (견적·상품정보는 유지됩니다)')) return;
    setDeleting(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${saleId}/cancel`), {
        method: 'PATCH',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '판매 상세에서 판매취소' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setToast(`판매취소 실패: ${data.error ?? res.status}`); return; }
      setToast('판매가 취소되어 견적관리로 되돌아갔습니다.');
      // 취소된 판매건은 목록에서 제외되므로 목록으로 이동
      setTimeout(() => onBack(), 600);
    } catch {
      setToast('판매취소 중 오류가 발생했습니다. 다시 시도해 주세요.');
    } finally {
      setDeleting(false);
    }
  };

  // ── 로딩 / 미존재 ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 240, color: C.g400, fontSize: 14 }}>
        판매 상세 불러오는 중…
      </div>
    );
  }
  if (!project) {
    return (
      <div>
        <BackToListButton onClick={onBack} testId="btn-sales-back" />
        <Card style={{ marginTop: 16, padding: 40, textAlign: 'center' }}>
          <p style={{ margin: 0, fontSize: 14, color: C.textSecondary }}>판매건을 찾을 수 없습니다.</p>
        </Card>
        {toast && <Toast msg={toast} onClose={() => setToast('')} />}
      </div>
    );
  }

  const companyName = project.company?.name ?? project.requestingCompanyName ?? null;
  const contactName = project.contact?.name ?? null;
  const pm = adminUsers.find(u => u.id === project.adminId);
  const pmName = pm ? (pm.name ?? pm.email) : null;
  const vatType = items[0]?.taxType ?? 'taxable';

  // 수정모드 판매금액 요약 — 편집 항목의 실시간 계산(편집 그리드와 동일).
  // 조회모드 요약은 QuoteItemsView 내부에서 저장값으로 표시(테이블의 일부).
  const editTotals = editMode ? calcTotals(editItems, vatType) : { supply: 0, tax: 0, total: 0 };

  return (
    // 견적관리 상세(asPage)와 동일한 폭 정책 — 별도 maxWidth 없이 관리자 본문 가용 폭 사용.
    // 좌우 padding(24px 28px)은 AdminDashboard 스크롤 컨테이너가 견적관리와 동일하게 제공한다.
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      {/* ── 상단 헤더 ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span ref={topBackRef} style={{ display: 'inline-flex' }}>
          <BackToListButton onClick={onBack} testId="btn-sales-back" />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: '0.04em' }}>판매 상세</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: C.g900, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 460 }}>{renderQuoteTitle(project.title)}</span>
            <StatusBadge status={project.status} />
            {quote?.quoteNumber && (
              // 견적번호 — 견적목록·견적서 PDF와 동일한 공식 표시번호(formatDocNumber: Q+YYMMDD-순번, 예 Q260716-008).
              //  · 원본 견적 레코드의 quoteNumber+발행일(issueDate)로 파생. 내부 raw 번호(Q000008) 직접 노출 금지.
              //  · 발행일 없는 레거시 데이터는 formatDocNumber가 원본 quoteNumber를 그대로 반환(fallback).
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: C.textSecondary, background: '#f5f3ff', borderRadius: 4, padding: '2px 7px' }}>{formatDocNumber('Q', quote.quoteNumber, quote.issueDate) || quote.quoteNumber}</span>
            )}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <GhostBtn onClick={() => fetchDetail()} style={{ fontSize: 12, padding: '6px 12px' }} data-testid="btn-sales-refresh" aria-label="새로고침">
          새로고침
        </GhostBtn>
        <PrimaryBtn onClick={handleQuotePdf} disabled={!quote || pdfLoading} style={{ fontSize: 12, padding: '6px 12px' }} data-testid="btn-sales-quote-pdf" aria-label="견적서 보기">
          {pdfLoading ? '…' : '📄 견적서 보기'}
        </PrimaryBtn>
        <button
          type="button"
          onClick={handleStatement}
          disabled={!saleConfirmed || stmtLoading}
          title={saleConfirmed ? '거래명세서 미리보기 / PDF 출력' : '판매 확정 후 출력할 수 있습니다.'}
          data-testid="btn-sales-statement"
          aria-label="거래명세서 보기"
          style={{
            fontSize: 12, padding: '6px 12px', borderRadius: 8,
            border: `1px solid ${saleConfirmed ? '#bbf7d0' : '#e5e7eb'}`,
            background: saleConfirmed ? '#f0fdf4' : '#f9fafb',
            color: saleConfirmed ? '#15803d' : '#9ca3af',
            cursor: saleConfirmed ? 'pointer' : 'not-allowed',
            fontWeight: 600, opacity: stmtLoading ? 0.5 : 1,
          }}>
          {stmtLoading ? '…' : '📋 거래명세서 보기'}
        </button>
        {/* 판매취소 = 배정 전(approved/paid)만 가능. 배정완료·진행중·완료·취소 단계에는 노출하지 않음(서버에서도 차단). */}
        {(project.status === 'approved' || project.status === 'paid') && (
          <button
            type="button"
            onClick={handleCancelSale}
            disabled={deleting}
            title="판매전환을 취소하고 원본 견적을 견적관리로 되돌립니다."
            data-testid="btn-sales-cancel"
            aria-label="판매취소"
            style={{
              fontSize: 12, padding: '6px 12px', borderRadius: 8,
              border: '1px solid #fcd34d', background: '#fffbeb', color: '#b45309',
              cursor: deleting ? 'not-allowed' : 'pointer', fontWeight: 600, opacity: deleting ? 0.5 : 1,
            }}>
            {deleting ? '…' : '판매취소'}
          </button>
        )}
      </div>

      {!quote && (
        <Card style={{ padding: 32, textAlign: 'center' }}>
          <p style={{ margin: 0, fontSize: 14, color: C.textSecondary }}>이 판매건에 연결된 견적이 없습니다.</p>
        </Card>
      )}

      {quote && (
        <>
          {/* ── A. 기본정보 ─────────────────────────────────────────────── */}
          <Card>
            <CardSectionHeader badge="A" badgeBg="#eff6ff" badgeColor="#2563eb" title="기본정보" hint="원본 견적 정보 (읽기전용)" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px 20px' }}>
              <ReadField label="견적서 유형" value={QUOTE_TYPE_LABEL[quote.quoteType] ?? quote.quoteType} />
              <ReadField label="견적일" value={quote.issueDate} />
              <ReadField label="부가세" value={VAT_LABEL[vatType] ?? vatType} />
              <div style={{ gridColumn: 'span 3' }}>
                <ReadField label="견적서명" value={quote.title} />
              </div>
              <ReadField label="거래처" value={companyName} />
              <ReadField label="담당자" value={contactName} />
              <ReadField label="담당 PM" value={pmName} />
            </div>
          </Card>

          {/* ── B. 판매정보 ─────────────────────────────────────────────── */}
          {/* 조회모드: 읽기전용 뷰(QuoteItemsView). 수정모드: 견적관리와 공용 편집 그리드(QuoteItemsEditor).
              제목에는 수정/저장·취소 버튼만, 판매금액 요약은 테이블 하단 우측에 배치한다(§1·§2).
              큰 금액요약 박스는 만들지 않는다(§3). 저장은 현재 견적 in-place 갱신(품목만). */}
          <Card>
            <CardSectionHeader badge="B" badgeBg="#f0fdf4" badgeColor="#16a34a" title="판매정보"
              hint={editMode ? '수정 중 — 저장 시 반영됩니다' : undefined}
              right={editMode ? (
                <>
                  <GhostBtn onClick={cancelEdit} disabled={saving} style={{ fontSize: 12, padding: '6px 12px' }}
                    data-testid="btn-sales-items-cancel" aria-label="수정 취소">취소</GhostBtn>
                  <PrimaryBtn onClick={saveSaleItems} disabled={saving} style={{ fontSize: 12, padding: '6px 12px' }}
                    data-testid="btn-sales-items-save" aria-label="판매정보 저장">{saving ? '저장 중…' : '저장'}</PrimaryBtn>
                </>
              ) : (
                <GhostBtn onClick={enterEdit} style={{ fontSize: 12, padding: '6px 12px' }}
                  data-testid="btn-sales-items-edit" aria-label="판매정보 수정">✏ 판매정보 수정</GhostBtn>
              )}
            />
            {editMode ? (
              <>
                <QuoteItemsEditor items={editItems} onItemsChange={setEditItems} vatType={vatType} products={products} />
                {/* 수정모드 — 편집 그리드와 동일 폭의 overflow 안에 합계 행을 렌더해 공급가액 컬럼과 정렬.
                    조회모드는 QuoteItemsView 내부에 합계 행이 포함된다. */}
                <div style={{ overflowX: 'auto', scrollbarWidth: 'thin' }}>
                  <SaleTotalsRows supply={editTotals.supply} tax={editTotals.tax} total={editTotals.total} />
                </div>
              </>
            ) : (
              <QuoteItemsView items={items} />
            )}
          </Card>

          {/* ── C. 수행정보 (통번역사·외주업체 배정/지급 — 원가) ───────────── */}
          <PerformanceSection
            projectId={saleId}
            token={token}
            performances={project.performances ?? []}
            onChanged={() => fetchDetail({ silent: true })}
            onToast={setToast}
            projectAdminId={project.adminId ?? null}
          />

          {/* ── D. 결제정보 (고객 수금 현황 — 통번역사 지급과 별개) ──────────── */}
          <PaymentInfoSection
            projectId={saleId}
            token={token}
            paymentRecords={project.paymentRecords ?? []}
            saleTotal={Number(quote?.price ?? 0)}
            defaultCompany={project.companyId ? { id: project.companyId, name: companyName ?? '' } : null}
            onChanged={() => fetchDetail({ silent: true })}
            onToast={setToast}
          />

          {/* ── E. 비고 ─────────────────────────────────────────────────── */}
          <Card>
            <CardSectionHeader badge="E" badgeBg="#f5f3ff" badgeColor="#7c3aed" title="비고" />
            {/* 견적관리 비고(2행 textarea)와 동일한 높이의 읽기전용 박스 */}
            <div>
              <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: SP[2] }}>견적 비고</label>
              <div style={{ ...dsInputStd(), minHeight: 60, background: '#f9fafb', color: quote.note ? C.g900 : C.g400, whiteSpace: 'pre-wrap', lineHeight: 1.6, display: 'block' }}>
                {quote.note || '비고 없음'}
              </div>
            </div>
          </Card>
        </>
      )}

      {/* ── PDF 모달 ─────────────────────────────────────────────────────── */}
      {pdfData && (
        <QuotePdfPreviewModal data={pdfData.data} quoteTitle={pdfData.title} onClose={() => setPdfData(null)} />
      )}
      {stmtData && (
        <TransactionStatementModal data={stmtData.data} quoteTitle={stmtData.title} onClose={() => setStmtData(null)} />
      )}

      {/* ── 우측 하단 플로팅 "목록으로"(§3·§4) — 상단 버튼이 뷰포트 밖일 때만. position:fixed(뷰포트 기준),
             페이지 콘텐츠(z 3~20) 위·모달/팝업(z 2000~9700) 아래로 배치해 팝업·알림을 가리지 않는다.
             · 화면 끝에 붙지 않도록 하단에서 약 88px 위로 올림(우측 24px 유지, 스크롤 무관 고정).
             · 테두리·그림자는 래퍼에 부여 — 버튼 자체 hover 핸들러가 테두리색을 되돌려도 선명함이 유지된다. */}
      {showFloatBack && (
        <div style={{
          position: 'fixed', right: 24, bottom: 88, zIndex: 40,
          borderRadius: 10, border: `1.5px solid ${C.primary}`,
          boxShadow: '0 4px 14px rgba(0,0,0,0.16)', background: '#fff', overflow: 'hidden',
        }}>
          <BackToListButton
            onClick={onBack}
            testId="btn-sales-back-floating"
            style={{ background: '#fff', border: 'none', height: 42, padding: '0 20px', fontSize: 15 }}
          />
        </div>
      )}

      {toast && <Toast msg={toast} onClose={() => setToast('')} />}
    </div>
  );
}
