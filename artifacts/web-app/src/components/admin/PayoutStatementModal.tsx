// ─────────────────────────────────────────────────────────────────────────────
// 수행자 지급명세서(정산 Phase 2·조회 전용) — 지급회차의 "확정 데이터"를 지급대상별로 명세서화.
//  · 데이터는 지급회차 상세 응답(detail.summary)을 그대로 사용한다. 재계산·재조회·스냅샷 변경 없음.
//    - 작성중 회차: 서버가 실시간 집계(미리보기) / 확정·완료 회차: 서버가 확정 스냅샷 기준 반환.
//  · 동명이인은 payeeKey(개인 i:userId / 외주 v:companyId, 고유 ID) 기준으로 분리한다.
//  · 표시·라벨·서식은 지급회차 화면(PayoutRoundsTab)과 동일 기준을 그대로 복제(세금처리 표기 일치).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState } from 'react';
import { ModalOverlay, GhostBtn, PrimaryBtn } from '../ui';
import { C, TYPO, SP, BD } from '../../lib/ds';
import { downloadStatementExcel, todayStamp, type ExcelColumn, type ExcelCell } from '../../lib/payoutExcel';

// ── 표시 헬퍼(PayoutRoundsTab 와 동일 — 순수 포맷/라벨. 계산 없음) ──
const won = (n: unknown) => Math.round(Number(n ?? 0)).toLocaleString('ko-KR');
const numOf = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const dateVal = (v?: string | null) => (v ? String(v).slice(0, 10) : '');
const nfmt = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('ko-KR') : String(v); };

const TREATMENT_LABEL: Record<string, string> = {
  domestic_3_3: '3.3%', exempt: '원천징수 예외',
  nonresident_custom: '비거주자', treaty_reduction_or_exemption: '조세조약', tax_review_required: '세무확인 필요',
};
const VENDOR_EVIDENCE_LABEL: Record<string, string> = {
  tax_invoice: '세금계산서', zero_rate_tax_invoice: '영세율 세금계산서', invoice: '계산서', other: '기타 증빙', none: '세무확인 필요',
};
// 세금처리 표시 — 외주=매입 증빙유형(기본 세금계산서) / 개인=원천 처리구분(없으면 세무확인 필요).
function taxTreatmentLabel(x: { payeeType?: string | null; performerCategory?: string | null; withholdingTreatment?: string | null; purchaseEvidenceType?: string | null }): string {
  const isVendor = (x.payeeType ?? x.performerCategory) === 'vendor';
  if (isVendor) return x.purchaseEvidenceType ? (VENDOR_EVIDENCE_LABEL[x.purchaseEvidenceType] ?? '세금계산서') : '세금계산서';
  return x.withholdingTreatment ? (TREATMENT_LABEL[x.withholdingTreatment] ?? '세무확인 필요') : '세무확인 필요';
}
// 그룹 세금처리 — 하위 건 표시값이 모두 같으면 그 값, 다르면 null(혼재).
function groupTaxTreatmentLabel(g: { items?: any[]; payeeType?: string; treatments?: string[] }): string | null {
  const items = g.items ?? [];
  if (items.length === 0) return taxTreatmentLabel({ payeeType: g.payeeType, withholdingTreatment: g.treatments?.[0] ?? null });
  const labels = new Set(items.map(taxTreatmentLabel));
  return labels.size === 1 ? [...labels][0] : null;
}
const svcLabel = (t: string) => t === 'translation' ? '번역' : t === 'interpretation' ? '통역' : t === 'equipment' ? '장비' : t === 'review' ? '감수' : t === 'dtp' ? 'DTP' : t === 'media' ? '미디어' : '기타';
// 수행일: 시작~종료(같은 연도면 종료는 MM-DD). 단일이면 하나, 없으면 '-'.
const perfDate = (it: any) => {
  const s = dateVal(it.performanceStartDate), e = dateVal(it.performanceEndDate);
  if (s && e && e !== s) return s.slice(0, 4) === e.slice(0, 4) ? `${s}~${e.slice(5)}` : `${s}~${e}`;
  return s || e || '-';
};
// 작업량: 번역/감수=단어(우선)/글자수, 통역=수량단위×인원, 그 외=수량단위. 없으면 '-'.
const workAmount = (it: any) => {
  const d = it.serviceDetail || {};
  const svc = it.serviceType;
  if (svc === 'translation' || svc === 'review') {
    if (d.wordCount != null && d.wordCount !== '') return `${nfmt(d.wordCount)}단어`;
    if (d.charCount != null && d.charCount !== '') return `${nfmt(d.charCount)}글자`;
    return '-';
  }
  if (it.quantity == null || Number(it.quantity) === 0) return '-';
  const base = `${nfmt(it.quantity)}${it.unit ?? ''}`;
  if (svc === 'interpretation' && d.interpreterCount) return `${base} × ${nfmt(d.interpreterCount)}명`;
  return base;
};
// 단가: 계약단가(원가). 직접입력·단가없음이면 '-'.
const unitPrice = (it: any) => (it.isDirectAmount || it.contractUnitPrice == null ? '-' : won(it.contractUnitPrice));
// 추가비용·차감 세부항목 인라인(항목명 금액). 없으면 '-'.
const inlineItems = (arr: { type: string; amount: number }[] | undefined) =>
  arr && arr.length ? arr.map(x => `${x.type} ${won(x.amount)}`).join(' · ') : '-';
const payeeTypeLabel = (t: string) => (t === 'individual' ? '통번역사' : '외주업체');

interface Props {
  round?: any;                // detail.round (전체 지급대상 조회 시 null)
  summary: any[];             // 현재 조회 범위의 지급대상 그룹(filteredSummary — 필터 반영, 재계산 없음)
  snapshotSource?: string;    // 'snapshot' | 'live' | 'live_legacy'
  scopeLabel?: string;        // round 미선택(전체/미배정) 시 범위 표기
  onToast: (m: string) => void;
  onClose: () => void;
}

// 상태 안내 — 회차 상태·스냅샷 출처에 따른 표시 근거 배지. 회차 미선택(전체 조회)이면 조회 기준 표기.
function sourceBadge(round: any, snapshotSource?: string): { label: string; color: string; bg: string } {
  if (!round) return { label: '조회 결과 기준 (실시간)', color: '#6b7280', bg: '#f3f4f6' };
  if (snapshotSource === 'snapshot') return { label: '확정 스냅샷 기준', color: '#047857', bg: '#ecfdf5' };
  if (snapshotSource === 'live_legacy') return { label: '레거시(확정 당시 미보존) — 원본 기준', color: '#b45309', bg: '#fffbeb' };
  return { label: '미리보기 (작성중 · 실시간)', color: '#6b7280', bg: '#f3f4f6' };
}

export default function PayoutStatementModal({ round, summary, snapshotSource, scopeLabel, onToast, onClose }: Props) {
  const [sel, setSel] = useState<string | null>(null);
  const badge = sourceBadge(round, snapshotSource);
  // 회차 선택 시: 회차명·지급일. 전체 조회 시: 범위 라벨(전체/미배정), 지급일은 건별 상이 → '-'.
  const roundName = round ? (round.batchNumber || `${dateVal(round.paymentDate)} 지급회차`) : (scopeLabel || '전체 지급대상');
  const payDate = round ? dateVal(round.paymentDate) : '';
  const scopeFieldLabel = round ? '지급회차' : '조회 범위';   // 회차/전체 조회에 따른 필드명
  const group = sel ? summary.find((g) => g.payeeKey === sel) : null;

  const th: React.CSSProperties = { ...TYPO.gridHeader, padding: '8px 10px', borderBottom: BD.grid, whiteSpace: 'nowrap', textAlign: 'left', background: C.g50 };
  const td: React.CSSProperties = { ...TYPO.inputValue, padding: '8px 10px', borderBottom: BD.divider, whiteSpace: 'nowrap' };
  const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
  const vatTag = (cond: boolean) => cond ? <span style={{ fontSize: 10, color: C.textSecondary, fontWeight: 400 }}> (VAT별도)</span> : null;

  // 그룹(지급대상) 세금처리 표시 — 상단·Excel 공통. 혼재면 '혼재', 외주 VAT포함이면 (VAT별도) 부기.
  const groupTaxDisplay = (g: any) => {
    const l = groupTaxTreatmentLabel(g);
    return (l === null ? '혼재 (건별 상이)' : l) + (g.isVatIncluded ? ' (VAT별도)' : '');
  };

  // ── 명세서 Excel — 화면과 동일 항목·금액. 별도 계산 없음(서버 확정값 그대로). ──
  //  · 상세는 세전금액까지, 세금처리는 상단 정보, 공제액·실지급액은 하단 합계로(화면과 동일 구조).
  const exportExcel = (g: any) => {
    const columns: ExcelColumn[] = [
      { header: '거래처' }, { header: '상품·업무' }, { header: '구분' }, { header: '수행일' }, { header: '작업량' },
      { header: '단가', type: 'number' }, { header: '기본수행료', type: 'number' }, { header: '추가비용' }, { header: '차감' },
      { header: '세전금액', type: 'number' },
    ];
    const rows: ExcelCell[][] = (g.items ?? []).map((it: any) => [
      it.customerName || '-',
      it.productName || `#${it.projectId}`,
      svcLabel(it.serviceType),
      perfDate(it),
      workAmount(it),
      (it.isDirectAmount || it.contractUnitPrice == null) ? '-' : Math.round(numOf(it.contractUnitPrice)),
      Math.round(numOf(it.basePerformanceFee)),
      inlineItems(it.expenses),
      inlineItems(it.deductions),
      Math.round(numOf(it.gross)),
    ]);
    // 컬럼 정렬 합계행(기본수행료·추가비용·차감·세전금액 합계) — 서버 그룹 총계 그대로.
    const totals: ExcelCell[] = [
      `합계 (${g.count}건)`, '', '', '', '',
      '', Math.round(numOf(g.baseTotal)), Math.round(numOf(g.expenseTotal)), Math.round(numOf(g.deductionTotal)),
      Math.round(numOf(g.grossTotal)),
    ];
    // 컬럼이 아닌 합계(공제액·최종 실지급액) — 하단 우측.
    const footerRows: [string, ExcelCell][] = [
      ['공제액', Math.round(numOf(g.withholdingTotal))],
      ['최종 실지급액', Math.round(numOf(g.netTotal))],
    ];
    const safe = String(g.payeeName || '지급대상').replace(/[\\/:*?"<>|\s]+/g, '_');
    const scopeTag = String(round?.batchNumber || roundName || payDate || todayStamp()).replace(/[\\/:*?"<>|\s]+/g, '_');
    downloadStatementExcel({
      filename: `지급명세서_${safe}_${scopeTag}_${todayStamp()}.xlsx`,
      sheetName: '지급명세서',
      title: 'VERITAS 지급명세서',
      info: [
        ['지급대상', String(g.payeeName ?? '')],
        ['이메일', g.payeeEmail || '-'],
        ['구분', payeeTypeLabel(g.payeeType)],
        [scopeFieldLabel, roundName],
        ['지급일', payDate || '-'],
        ['세금처리', groupTaxDisplay(g)],
      ],
      columns, rows, totals, footerRows,
    });
    onToast('지급명세서 Excel을 다운로드했습니다.');
  };

  // 공통 헤더(제목 + 상태 배지 + 회차정보)
  const header = (title: string, extra?: React.ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap', marginBottom: SP[3] }}>
      <h3 style={{ margin: 0, ...TYPO.sectionTitle }}>{title}</h3>
      <span style={{ ...TYPO.badge, color: badge.color, background: badge.bg, padding: '3px 9px', borderRadius: 6, fontWeight: 700 }}>{badge.label}</span>
      <span style={{ ...TYPO.helper }}>{scopeFieldLabel} <b>{roundName}</b></span>
      {round && <span style={{ ...TYPO.helper }}>지급일 <b>{payDate || '-'}</b></span>}
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>{extra}<GhostBtn onClick={onClose} style={{ fontSize: 12, padding: '6px 12px' }} data-testid="payout-statement-close" aria-label="닫기">닫기</GhostBtn></div>
    </div>
  );

  // ── 팝업 레이아웃(표시 전용) — 헤더 고정 + 본문 스크롤로 스크롤 없이도 핵심이 보이게. ──
  const shell: React.CSSProperties = { display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 120px)', minHeight: 0 };
  const bodyScroll: React.CSSProperties = { flex: 1, overflow: 'auto', minHeight: 0 };
  const fixedTop: React.CSSProperties = { flexShrink: 0, borderBottom: BD.grid, marginBottom: SP[3] };
  // 목록 [명세서 보기] 항상 노출 — 액션 컬럼 우측 고정(가로 스크롤과 무관하게 보임).
  const thAction: React.CSSProperties = { ...th, position: 'sticky', right: 0, zIndex: 2, background: C.g50 };
  const tdAction: React.CSSProperties = { ...td, position: 'sticky', right: 0, zIndex: 1, background: C.bgCard, boxShadow: '-6px 0 8px -6px rgba(15,23,42,0.14)' };

  return (
    <ModalOverlay onClose={onClose} maxWidth={sel ? 1180 : 900}>
      <div style={shell}>
      {!sel ? (
        // ── 명세서 목록(지급대상자별) — 헤더 고정 · 표 스크롤 · [명세서 보기] 우측 고정 ──
        <>
          <div style={fixedTop}>{header('지급명세서 — 지급대상자 목록')}</div>
          <div style={{ ...bodyScroll, overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 820 }}>
              <thead><tr>
                <th style={th}>지급대상</th><th style={th}>이메일</th><th style={th}>구분</th>
                <th style={{ ...th, textAlign: 'right' }}>건수</th><th style={{ ...th, textAlign: 'right' }}>세전금액</th>
                <th style={th}>세금처리</th><th style={{ ...th, textAlign: 'right' }}>공제액</th><th style={{ ...th, textAlign: 'right' }}>실지급액</th><th style={thAction}></th>
              </tr></thead>
              <tbody>
                {summary.length === 0 && <tr><td colSpan={9} style={{ ...td, textAlign: 'center', color: C.g400, padding: 20 }}>현재 조회 범위에 지급대상자가 없습니다.</td></tr>}
                {summary.map((g) => {
                  const lbl = groupTaxTreatmentLabel(g);
                  return (
                    <tr key={g.payeeKey}>
                      <td style={{ ...td, fontWeight: 700 }} title={g.payeeName}>{g.payeeName}</td>
                      <td style={{ ...td, color: C.textSecondary }} title={g.payeeEmail || '-'}>{g.payeeEmail || '-'}</td>
                      <td style={td}>{payeeTypeLabel(g.payeeType)}</td>
                      <td style={tdR}>{g.count}건</td>
                      <td style={tdR}>{won(g.grossTotal)}{vatTag(!!g.isVatIncluded)}</td>
                      <td style={td}>{lbl === null ? <span style={{ color: C.danger, fontWeight: 700 }} title="세금처리 혼재">⚠ 혼재</span> : lbl}</td>
                      <td style={{ ...tdR, color: C.danger }}>{won(g.withholdingTotal)}</td>
                      <td style={{ ...tdR, fontWeight: 800, color: C.primaryText }}>{won(g.netTotal)}</td>
                      <td style={tdAction}><PrimaryBtn onClick={() => setSel(g.payeeKey)} style={{ fontSize: 11, padding: '5px 12px' }} data-testid={`payout-statement-view-${g.payeeKey}`} aria-label={`${g.payeeName} 명세서 보기`}>명세서 보기</PrimaryBtn></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : group ? (
        // ── 개별 지급명세서(수행자 1인) — 헤더·기본정보·[Excel] 고정 · 상세/합계 스크롤 ──
        <>
          <div style={fixedTop}>
          {header('VERITAS 지급명세서', (
            <>
              <GhostBtn onClick={() => setSel(null)} style={{ fontSize: 12, padding: '6px 12px' }} data-testid="payout-statement-back" aria-label="목록으로">← 목록</GhostBtn>
              <PrimaryBtn onClick={() => exportExcel(group)} style={{ fontSize: 12, padding: '6px 14px' }} data-testid="payout-statement-excel" aria-label="Excel 다운로드">📊 Excel 다운로드</PrimaryBtn>
            </>
          ))}
          {/* 기본정보(상단·고정) — 지급대상 / 이메일 / 구분 / 지급회차 / 지급일 / 세금처리 */}
          <div style={{ display: 'flex', gap: SP[5], flexWrap: 'wrap', padding: `${SP[3]}px ${SP[4]}px`, background: C.g50, borderRadius: 8, marginBottom: SP[3], ...TYPO.inputValue }}>
            {[
              ['지급대상', group.payeeName],
              ['이메일', group.payeeEmail || '-'],
              ['구분', payeeTypeLabel(group.payeeType)],
              [scopeFieldLabel, roundName],
              ['지급일', payDate || '-'],
              ['세금처리', groupTaxDisplay(group)],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={TYPO.helper}>{k}</span><span style={{ ...TYPO.inputValue, fontWeight: 700 }}>{v}</span>
              </div>
            ))}
          </div>
          </div>{/* /fixedTop */}
          <div style={bodyScroll}>
          {/* 상세내역 — 거래처 … 세전금액(세금처리·공제·실지급은 상단/하단으로 이동, 화면=Excel 동일 구조) */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 920 }}>
              <thead><tr>
                <th style={th}>거래처</th><th style={th}>상품·업무</th><th style={th}>구분</th><th style={th}>수행일</th><th style={th}>작업량</th>
                <th style={{ ...th, textAlign: 'right' }}>단가</th><th style={{ ...th, textAlign: 'right' }}>기본수행료</th><th style={th}>추가비용</th><th style={th}>차감</th>
                <th style={{ ...th, textAlign: 'right' }}>세전금액</th>
              </tr></thead>
              <tbody>
                {(group.items ?? []).map((it: any) => (
                  <tr key={it.id}>
                    <td style={td} title={it.customerName || '-'}>{it.customerName || '-'}</td>
                    <td style={td} title={it.productName || `#${it.projectId}`}>{it.productName || `#${it.projectId}`}</td>
                    <td style={td}>{svcLabel(it.serviceType)}</td>
                    <td style={td}>{perfDate(it)}</td>
                    <td style={td}>{workAmount(it)}</td>
                    <td style={tdR}>{unitPrice(it)}</td>
                    <td style={tdR}>{won(it.basePerformanceFee)}</td>
                    <td style={{ ...td, whiteSpace: 'normal', color: (it.expenses?.length ? C.textSecondary : C.g400) }}>{inlineItems(it.expenses)}</td>
                    <td style={{ ...td, whiteSpace: 'normal', color: (it.deductions?.length ? C.danger : C.g400) }}>{inlineItems(it.deductions)}</td>
                    <td style={tdR}>{won(it.gross)}{vatTag(!!it.isVatIncluded)}</td>
                  </tr>
                ))}
              </tbody>
              {/* 컬럼 정렬 합계행 — 기본수행료·추가비용·차감·세전금액 합계(서버 그룹 총계 · 재계산 없음) */}
              <tfoot><tr>
                <td style={{ ...td, fontWeight: 800, background: C.primaryBg }} colSpan={4}>합계 ({group.count}건)</td>
                <td style={{ ...td, background: C.primaryBg }}></td>
                <td style={{ ...tdR, background: C.primaryBg }}></td>
                <td style={{ ...tdR, fontWeight: 800, background: C.primaryBg }}>{won(group.baseTotal)}</td>
                <td style={{ ...tdR, fontWeight: 800, background: C.primaryBg }}>{won(group.expenseTotal)}</td>
                <td style={{ ...tdR, fontWeight: 800, background: C.primaryBg }}>{won(group.deductionTotal)}</td>
                <td style={{ ...tdR, fontWeight: 800, background: C.primaryBg }}>{won(group.grossTotal)}</td>
              </tr></tfoot>
            </table>
          </div>
          {/* 하단 합계 — 기본수행료/추가비용/차감/세전 합계 + 공제액 + 최종 실지급액(회차 확정 데이터 기준·재계산 없음) */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: SP[3] }}>
            <div style={{ minWidth: 300, display: 'flex', flexDirection: 'column', gap: 4, padding: `${SP[3]}px ${SP[4]}px`, background: C.g50, borderRadius: 8, ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums' }}>
              {[
                ['기본수행료 합계', won(group.baseTotal)],
                ['추가비용 합계', won(group.expenseTotal)],
                ['차감 합계', won(group.deductionTotal)],
                ['세전금액 합계', won(group.grossTotal)],
                ['공제액', won(group.withholdingTotal), C.danger],
              ].map(([k, v, color]) => (
                <div key={k as string} style={{ display: 'flex', justifyContent: 'space-between', gap: SP[5] }}>
                  <span style={TYPO.helper}>{k}</span><span style={{ fontWeight: 700, color: (color as string) || undefined }}>{v}원</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: SP[5], borderTop: BD.grid, paddingTop: SP[2], marginTop: 2 }}>
                <span style={{ fontWeight: 800 }}>최종 실지급액</span>
                <span style={{ fontWeight: 900, fontSize: 16, color: C.primaryText }}>{won(group.netTotal)}원</span>
              </div>
            </div>
          </div>
          </div>{/* /bodyScroll */}
        </>
      ) : (
        <><div style={fixedTop}>{header('VERITAS 지급명세서')}</div><div style={{ ...td, textAlign: 'center', color: C.g400, padding: 20 }}>대상을 찾을 수 없습니다.</div></>
      )}
      </div>
    </ModalOverlay>
  );
}
