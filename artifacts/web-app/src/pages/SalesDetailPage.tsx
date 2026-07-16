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
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/constants';
import { Card, StatusBadge, Toast, GhostBtn, PrimaryBtn } from '../components/ui';
import { C, TYPO, SP, BD, dsInputStd } from '../lib/ds';
import { buildQuotePdfData, displayUnit, parseMemoInfo, type QuoteDetail } from '../lib/quotePdf';
import { renderQuoteTitle } from '../lib/quoteTitle';
import QuotePdfPreviewModal from '../components/admin/QuotePdfPreviewModal';
import TransactionStatementModal from '../components/admin/TransactionStatementModal';

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
function CardSectionHeader({ badge, badgeBg, badgeColor, title, hint }: {
  badge: string; badgeBg: string; badgeColor: string; title: string; hint?: string;
}) {
  return (
    <div style={{ ...TYPO.sectionTitle, paddingBottom: SP[4], borderBottom: BD.grid, marginBottom: SP[6], display: 'flex', alignItems: 'center', gap: SP[3] }}>
      <span style={{ width: 22, height: 22, borderRadius: BD.radius.md, background: badgeBg, color: badgeColor, fontSize: 12, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{badge}</span>
      {title}
      {hint && <span style={{ ...TYPO.helper, marginLeft: SP[2] }}>{hint}</span>}
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

const fmt = (n: unknown) => Number(n ?? 0).toLocaleString();

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

  const [pdfData,  setPdfData]  = useState<{ data: ReturnType<typeof buildQuotePdfData>; title: string } | null>(null);
  const [stmtData, setStmtData] = useState<{ data: ReturnType<typeof buildQuotePdfData>; title: string } | null>(null);
  const [pdfLoading,  setPdfLoading]  = useState(false);
  const [stmtLoading, setStmtLoading] = useState(false);
  const [deleting,    setDeleting]    = useState(false);

  // ── 판매 상세(=프로젝트 + 원본 견적) 조회 ─────────────────────────────────
  const fetchDetail = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${saleId}`), { headers: authH });
      if (!res.ok) {
        setToast(`판매건 조회 실패 (${res.status})`);
        setProject(null);
        return;
      }
      setProject(await res.json());
    } catch {
      setToast('판매 상세 조회 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleId, token]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  // ── 연결된 현재 견적 ───────────────────────────────────────────────────────
  const quote = project?.quotes?.find((q: any) => q.isCurrent) ?? project?.quotes?.[0] ?? null;
  const items: any[] = quote?.items ?? [];
  const saleConfirmed = ['approved', 'paid', 'matched', 'in_progress', 'completed'].includes(project?.status);

  const quoteDocTitle = quote ? (quote.title ?? quote.quoteNumber ?? `견적 #${quote.id}`) : '';

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
        <GhostBtn onClick={onBack} data-testid="btn-sales-back" aria-label="목록으로 돌아가기">← 목록으로</GhostBtn>
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

  const totals = items.reduce((acc, it) => {
    acc.supply += Number(it.supplyAmount ?? 0);
    acc.tax    += Number(it.taxAmount ?? 0);
    acc.total  += Number(it.totalAmount ?? 0);
    return acc;
  }, { supply: 0, tax: 0, total: 0 });

  // 견적관리 상품 Grid와 동일한 밀도 — Header=gridHeader(12/600), Row=inputValue(13), Row높이 ≈ 42
  const th: React.CSSProperties = { ...TYPO.gridHeader, padding: '0 8px 8px', textAlign: 'left', borderBottom: BD.grid, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { ...TYPO.inputValue, padding: '9px 8px', borderBottom: BD.divider, verticalAlign: 'middle' };
  const tdNum: React.CSSProperties = { ...td, textAlign: 'right', whiteSpace: 'nowrap' };

  return (
    // 견적관리 상세(asPage)와 동일한 폭 정책 — 별도 maxWidth 없이 관리자 본문 가용 폭 사용.
    // 좌우 padding(24px 28px)은 AdminDashboard 스크롤 컨테이너가 견적관리와 동일하게 제공한다.
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      {/* ── 상단 헤더 ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <GhostBtn onClick={onBack} style={{ fontSize: 12, padding: '6px 12px' }} data-testid="btn-sales-back" aria-label="목록으로 돌아가기">
          ← 목록으로
        </GhostBtn>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: '0.04em' }}>판매 상세</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: C.g900, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 460 }}>{renderQuoteTitle(project.title)}</span>
            <StatusBadge status={project.status} />
            {quote?.quoteNumber && (
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: C.textSecondary, background: '#f5f3ff', borderRadius: 4, padding: '2px 7px' }}>{quote.quoteNumber}</span>
            )}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <GhostBtn onClick={fetchDetail} style={{ fontSize: 12, padding: '6px 12px' }} data-testid="btn-sales-refresh" aria-label="새로고침">
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

          {/* ── B. 상품정보 ─────────────────────────────────────────────── */}
          <Card>
            <CardSectionHeader badge="B" badgeBg="#f0fdf4" badgeColor="#16a34a" title="상품정보" />
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820, tableLayout: 'auto' }}>
                <thead>
                  <tr>
                    {['상품명', '파일명', '형식', '단어수', '글자수', '수량', '단위', '단가', '공급가액', '부가세', '합계'].map((h, i) => (
                      <th key={h} style={{ ...th, textAlign: i >= 7 ? 'right' : 'left' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, idx) => {
                    const { fields } = parseMemoInfo(it.memo);
                    return (
                      <tr key={idx}>
                        <td style={{ ...td, fontWeight: 600, minWidth: 160 }}>
                          {it.productName}
                          {it.languagePair && <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>{it.languagePair}</div>}
                        </td>
                        <td style={td}>{fields['파일'] || '—'}</td>
                        <td style={td}>{fields['형식'] || '—'}</td>
                        <td style={tdNum}>{fields['단어수'] || '—'}</td>
                        <td style={tdNum}>{fields['글자수'] || '—'}</td>
                        <td style={tdNum}>{fmt(it.quantity)}</td>
                        <td style={td}>{displayUnit(it.productName, it.unit) || '—'}</td>
                        <td style={tdNum}>{fmt(it.unitPrice)}</td>
                        <td style={tdNum}>{fmt(it.supplyAmount)}</td>
                        <td style={tdNum}>{fmt(it.taxAmount)}</td>
                        <td style={{ ...tdNum, fontWeight: 700 }}>{fmt(it.totalAmount)}</td>
                      </tr>
                    );
                  })}
                  {items.length === 0 && (
                    <tr><td colSpan={11} style={{ ...td, textAlign: 'center', color: C.g400 }}>등록된 품목이 없습니다.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          {/* ── C. 금액 요약 ─────────────────────────────────────────────── */}
          <Card>
            <CardSectionHeader badge="C" badgeBg="#fffbeb" badgeColor="#d97706" title="금액 요약" />
            {/* 견적관리 금액 요약과 동일한 박스 레이아웃 (읽기전용) */}
            <div style={{ display: 'flex', gap: SP[6], justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              {[{ label: '공급가액', value: totals.supply }, { label: '부가세', value: totals.tax }].map(r => (
                <div key={r.label} style={{ textAlign: 'right', padding: `${SP[4]}px ${SP[5]}px`, borderRadius: BD.radius.lg, background: C.bgHover }}>
                  <div style={{ ...TYPO.helper, marginBottom: 3 }}>{r.label}</div>
                  <div style={{ ...TYPO.summaryAmount }}>{fmt(r.value)}원</div>
                </div>
              ))}
              <div style={{ textAlign: 'right', padding: `${SP[5]}px ${SP[7]}px`, borderRadius: BD.radius.xl, background: C.primaryBg, border: `1.5px solid ${C.primaryBorder}` }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.primary, marginBottom: 3 }}>합계금액</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: C.primaryText, letterSpacing: '-0.01em' }}>{fmt(totals.total || quote.price)}원</div>
              </div>
            </div>
          </Card>

          {/* ── D. 비고 ─────────────────────────────────────────────────── */}
          <Card>
            <CardSectionHeader badge="D" badgeBg="#f5f3ff" badgeColor="#7c3aed" title="비고" />
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

      {toast && <Toast msg={toast} onClose={() => setToast('')} />}
    </div>
  );
}
