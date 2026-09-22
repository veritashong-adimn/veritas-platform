import React, { useState, useCallback, useRef, useEffect } from 'react';
import './readTableView.css';
import { api } from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn, confirmDialog } from '../ui';
import { BackToListButton } from './BackToListButton';

// ─── 과거자료 일괄등록 (Past-Work Bulk Registration) ───────────────────────────
// 견적관리 → [과거자료 일괄등록] 진입. 업로드 → 분석/Grouping/Master매칭/금액대사 Preview →
// 사용자 선택 → 일괄등록(견적→판매전환→프로젝트→수행배정→지급예정) → 결과.
// 등록 데이터는 별도 레거시가 아니라 기존 정상 화면(견적/판매/수행/지급회차)에 그대로 나타난다.
// ※ 실제 「결제리스트 20260915」 등록(execute)은 운영 승인 후에만 진행한다.

type Status = 'new' | 'identical' | 'duplicate_file' | 'needs_review' | 'error';

interface Summary {
  rawRows: number; quotesNew: number; quotesIdentical: number; quotesNeedsReview: number;
  quotesDuplicate: number; quotesError: number; projectCount: number; assignmentCount: number;
  quotesTotal?: number;
  rawRowsTranslation?: number; rawRowsInterpretation?: number; rawRowsEquipment?: number;
  quotesTranslation?: number; quotesInterpretation?: number; quotesEquipment?: number; quotesMixed?: number;
  assignmentsTranslation?: number; assignmentsInterpretation?: number; assignmentsEquipment?: number;
  companyMatched: number; companyUnmatched: number; contactMatched: number; contactUnmatched: number;
  companyExact?: number; companyAlias?: number; companyRelation?: number; companyNormalized?: number;
  translatorMatched: number; translatorUnmatched: number;
  quoteTotalOriginal: number; quoteTotalSystem: number; quoteTotalDiff: number;
  preTaxOriginal: number; preTaxSystem: number; preTaxDiff: number; errorCount: number;
  pay0915Rows?: number; pay0915PreTaxOriginal?: number; pay0915PreTaxSystem?: number; pay0915PreTaxDiff?: number; nonPay0915Rows?: number;
  equipmentRows?: number; equipmentOriginalTotal?: number;
}
interface QuotePreview {
  groupKey: string; rowKey: string;
  companyName: string; matchedCompanyId: number | null; matchedCompanyName: string;
  companyMatchMethod?: string; matchedDivisionId?: number | null; matchedDivisionName?: string;
  quoteCategory?: string;
  customerName: string; matchedContactId: number | null; pm: string; matchedAdminId: number | null;
  quoteIssueDate: string; contractDate: string; quoteKind: string;
  title: string; itemCount: number; assignmentCount: number;
  originalSupply: number; originalVat: number; originalTotal: number;
  systemSupply: number; systemVat: number; systemTotal: number; totalDiff: number;
  status: Status; reason?: string; warning?: string; existingQuoteId?: number | null;
}
interface AssignPreview {
  rowNumber: number; sheet: string; groupKey: string; category: string;
  translatorName: string; matchedTranslatorId: number | null;
  language: string; fileName: string; content: string; deliveryDate: string; payDate: string;
  quantity: number | null; unit: string; unitPrice: number | null;
  base: number; expenseTotal: number; deductionTotal: number;
  computedPreTax: number; originalPreTax: number | null; preTaxDiff: number;
  withholdingRate: number; withholdingTax: number; netPay: number;
  status: Status; reason?: string; warning?: string;
}
interface AnalyzeResponse {
  fileName: string; sheetNames: string[]; columnMap: Record<string, string | null>;
  summary: Summary; quotes: QuotePreview[]; assignments: AssignPreview[];
}

function safeNum(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function won(v: number | null | undefined): string { return safeNum(v).toLocaleString('ko-KR'); }

type StatusMeta = { label: string; bg: string; color: string; border: string };
const STATUS_META: Record<Status, StatusMeta> = {
  new: { label: '신규 등록 예정', bg: '#ecfdf5', color: '#047857', border: '#a7f3d0' },
  identical: { label: '기존 등록(제외)', bg: '#f3f4f6', color: '#6b7280', border: '#e5e7eb' },
  needs_review: { label: '확인필요', bg: '#fffbeb', color: '#b45309', border: '#fde68a' },
  duplicate_file: { label: '파일 내 중복(제외)', bg: '#fff7ed', color: '#c2410c', border: '#fed7aa' },
  error: { label: '오류(제외)', bg: '#fef2f2', color: '#b91c1c', border: '#fecaca' },
};
function statusMeta(s: unknown): StatusMeta {
  const k = typeof s === 'string' ? s : '';
  return STATUS_META[k as Status] ?? { label: k || '알 수 없음', bg: '#f3f4f6', color: '#6b7280', border: '#e5e7eb' };
}
const CATEGORY_LABEL: Record<string, string> = { translation: '번역', interpretation: '통역', equipment: '장비' };
const METHOD_LABEL: Record<string, string> = { bizno: '사업자번호', canonical: '정식명', alias: '별칭', relation: '본점/브랜드', normalized: '정규화', ambiguous: '다중후보', unmatched: '미매칭' };
function MethodTag({ method }: { method?: string }) {
  if (!method || method === 'canonical' || method === 'unmatched' || method === 'ambiguous') return null;
  return <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 5, background: '#f5f3ff', color: '#6d28d9', border: '1px solid #ddd6fe' }}>{METHOD_LABEL[method] ?? method}</span>;
}

const th: React.CSSProperties = { padding: '8px 8px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#6b7280', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
const thR: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '7px 8px', fontSize: 12, color: '#374151', borderBottom: '1px solid #edf0f3', verticalAlign: 'middle', whiteSpace: 'nowrap' };
const tdR: React.CSSProperties = { ...td, textAlign: 'right' };

function SummaryCard({ label, value, tone, isCurrency }: { label: string; value: number | undefined; tone: 'default' | 'green' | 'amber' | 'red' | 'gray' | 'blue'; isCurrency?: boolean }) {
  const tones: Record<string, { bg: string; color: string }> = {
    default: { bg: '#f9fafb', color: '#111827' }, green: { bg: '#ecfdf5', color: '#047857' },
    amber: { bg: '#fffbeb', color: '#b45309' }, red: { bg: '#fef2f2', color: '#b91c1c' },
    gray: { bg: '#f3f4f6', color: '#6b7280' }, blue: { bg: '#eff6ff', color: '#1d4ed8' },
  };
  const t = tones[tone];
  return (
    <div style={{ flex: '1 1 120px', minWidth: 110, background: t.bg, borderRadius: 10, padding: '12px 14px', border: '1px solid #eef2f7' }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: isCurrency ? 16 : 22, fontWeight: 700, color: t.color }}>{isCurrency ? won(value) : safeNum(value).toLocaleString()}</div>
    </div>
  );
}
function diffTone(v: number): 'green' | 'red' { return Math.abs(v) < 0.5 ? 'green' : 'red'; }
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', letterSpacing: '0.2px', margin: '2px 0 6px' }}>{children}</div>;
}

const MAX_PREVIEW_ROWS = 500;

interface Props {
  token: string;
  onClose: () => void;
  onToast: (msg: string) => void;
  onDone?: () => void;
}

function PastWorkBulkImportInner({ token, onClose, onToast, onDone }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [done, setDone] = useState<{ quotesCreated: number; projectsCreated: number; assignmentsCreated: number } | null>(null);
  const [tab, setTab] = useState<'quotes' | 'assignments'>('quotes');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  // 신규(new) 견적 그룹 전체를 기본 선택(사용자가 개별 해제 가능).
  useEffect(() => {
    if (!analysis) { setSelected(new Set()); return; }
    setSelected(new Set(analysis.quotes.filter(q => q.status === 'new').map(q => q.groupKey)));
  }, [analysis]);

  const pickFile = (f: File | null) => {
    if (!f) return;
    const name = f.name.toLowerCase();
    if (!name.endsWith('.xls') && !name.endsWith('.xlsx')) { onToast('.xls 또는 .xlsx 파일만 업로드할 수 있습니다.'); return; }
    setFile(f); setAnalysis(null); setDone(null);
  };

  const doAnalyze = useCallback(async () => {
    if (!file) return;
    setAnalyzing(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await fetch(api('/api/admin/past-work/bulk-import/analyze'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error ?? '분석 실패'}`); return; }
      setAnalysis(data); setTab('quotes');
    } catch { onToast('오류: 파일 분석 중 문제가 발생했습니다.'); }
    finally { setAnalyzing(false); }
  }, [file, token, onToast]);

  const doExecute = useCallback(async () => {
    if (!file || !analysis) return;
    const keys = [...selected];
    if (keys.length === 0) { onToast('등록할 견적 그룹을 선택하세요.'); return; }
    const s = analysis.summary;
    const diffWarn = Math.abs(s.quoteTotalDiff) >= 0.5 || Math.abs(s.preTaxDiff) >= 0.5;
    if (!(await confirmDialog({
      title: '과거자료 일괄등록',
      message: `선택한 견적 ${keys.length}건을 등록합니다.\n\n· 견적/판매/프로젝트/수행배정/지급예정이 정상 데이터로 생성됩니다.\n· 확인필요·오류·기존등록 건은 저장되지 않습니다.${diffWarn ? '\n\n⚠ 원본과 시스템 금액에 차액이 있습니다. Preview의 차액을 확인하세요.' : ''}`,
      confirmLabel: '등록', variant: 'warning',
    }))) return;
    setExecuting(true);
    try {
      const fd = new FormData(); fd.append('file', file); fd.append('selectedGroups', JSON.stringify(keys));
      const res = await fetch(api('/api/admin/past-work/bulk-import/execute'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error ?? '등록 실패'}`); return; }
      setDone({ quotesCreated: safeNum(data.quotesCreated), projectsCreated: safeNum(data.projectsCreated), assignmentsCreated: safeNum(data.assignmentsCreated) });
      onToast(`견적 ${safeNum(data.quotesCreated)}건 · 수행배정 ${safeNum(data.assignmentsCreated)}건을 등록했습니다.`);
      onDone?.();
    } catch { onToast('오류: 일괄등록 중 문제가 발생했습니다.'); }
    finally { setExecuting(false); }
  }, [file, analysis, selected, token, onToast, onDone]);

  const resetAll = useCallback(() => {
    setFile(null); setAnalysis(null); setDone(null); setSelected(new Set()); setTab('quotes');
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const s = analysis?.summary;
  const quotes = analysis?.quotes ?? [];
  const assignments = analysis?.assignments ?? [];
  const newQuotes = quotes.filter(q => q.status === 'new');
  const allNewSelected = newQuotes.length > 0 && newQuotes.every(q => selected.has(q.groupKey));
  const toggleGroup = (k: string) => setSelected(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const toggleAll = () => setSelected(() => (allNewSelected ? new Set() : new Set(newQuotes.map(q => q.groupKey))));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <BackToListButton onClick={onClose} variant="subtle" label="견적서 목록" testId="pastwork-back" />
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>과거자료 일괄등록</h2>
      </div>

      {done ? (
        <Card style={{ padding: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#047857', marginBottom: 16 }}>✓ 등록 완료</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            <SummaryCard label="생성된 견적" value={done.quotesCreated} tone="green" />
            <SummaryCard label="생성된 프로젝트" value={done.projectsCreated} tone="green" />
            <SummaryCard label="생성된 수행배정" value={done.assignmentsCreated} tone="green" />
          </div>
          <p style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.7, margin: '0 0 16px' }}>
            등록 데이터는 <b>견적관리 · 판매관리 · 수행정보 · 정산/지급회차</b>에 그대로 나타납니다.
            2026.09.15 지급회차에서 지급 대상자를 조회·검증하세요.
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <PrimaryBtn onClick={onClose} data-testid="pastwork-finish" aria-label="완료">완료</PrimaryBtn>
            <GhostBtn onClick={resetAll} data-testid="pastwork-again" aria-label="다른 파일 등록">다른 파일 등록</GhostBtn>
          </div>
        </Card>
      ) : (
        <>
          <Card style={{ padding: 20, marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4 }}>1. 결제리스트 Excel 업로드</div>
            <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 12px', lineHeight: 1.7 }}>
              과거 「결제리스트」(번역·통역·장비 시트)를 업로드하면 <b>동일 견적으로 자동 그룹핑</b>하고, 거래처·담당자·통번역사·상품을
              기존 마스터와 매칭한 뒤 금액을 대사합니다. 미매칭 항목은 확인필요로 표시되며 <b>자동 생성되지 않습니다</b>.
              통번역사 주민등록번호 등 개인정보는 매핑·표시되지 않습니다.
            </p>
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragEnter={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
              onDrop={e => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0] ?? null); }}
              style={{ border: dragOver ? '2px dashed #0284c7' : '1.5px dashed #cbd5e1', background: dragOver ? '#e0f2fe' : '#f8fafc', borderRadius: 12, padding: '28px 20px', textAlign: 'center', transition: 'all .12s' }}
            >
              {file ? (
                <div style={{ fontSize: 13, color: '#0284c7', fontWeight: 600 }}>✓ {file.name} <span style={{ color: '#94a3b8', fontWeight: 400 }}>({(file.size / 1024).toFixed(0)} KB)</span></div>
              ) : (
                <div style={{ fontSize: 13, color: '#94a3b8' }}>{dragOver ? '파일을 여기에 놓으세요' : '파일을 드래그하거나 아래 버튼으로 선택하세요'}</div>
              )}
              <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center' }}>
                <label style={{ cursor: 'pointer', display: 'inline-block' }}>
                  <span style={{ fontSize: 12, padding: '6px 14px', borderRadius: 8, background: '#0284c7', color: '#fff', fontWeight: 600 }}>{file ? '파일 교체' : '파일 선택'}</span>
                  <input ref={inputRef} type="file" accept=".xls,.xlsx" style={{ display: 'none' }} data-testid="pastwork-file" aria-label="엑셀 파일 선택"
                    onChange={e => pickFile(e.target.files?.[0] ?? null)} />
                </label>
                <GhostBtn onClick={resetAll} disabled={analyzing || executing} style={{ fontSize: 12, padding: '6px 14px' }} data-testid="pastwork-reset" aria-label="초기화">초기화</GhostBtn>
                <PrimaryBtn onClick={doAnalyze} disabled={!file || analyzing} style={{ fontSize: 12, padding: '6px 16px' }} data-testid="pastwork-analyze" aria-label="파일 분석">
                  {analyzing ? '분석 중...' : '파일 분석'}
                </PrimaryBtn>
              </div>
            </div>
          </Card>

          {analysis && s && (
            <Card style={{ padding: 20, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10 }}>2. 분석 결과 (등록 전 Preview)</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 12 }}>
                시트: <b>{(analysis.sheetNames ?? []).join(', ') || '-'}</b> · 매핑된 컬럼:{' '}
                {Object.entries(analysis.columnMap ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ') || '없음'}
              </div>

              {/* A. 원본 (번역/통역/장비 분리) */}
              <SectionLabel>A. 원본 (Excel 수행행)</SectionLabel>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                <SummaryCard label="전체 수행행" value={s.rawRows} tone="default" />
                <SummaryCard label="번역 수행행" value={s.rawRowsTranslation ?? 0} tone="blue" />
                <SummaryCard label="통역 수행행" value={s.rawRowsInterpretation ?? 0} tone="blue" />
                <SummaryCard label="장비 수행행" value={s.rawRowsEquipment ?? 0} tone="gray" />
              </div>
              {/* B. 견적 Grouping (원본 거래처명 + 공급가 + 부가세 + 총액) — 번역/통역 분리 */}
              <SectionLabel>B. 견적 Grouping (원본 거래처명 + 공급가 + 부가세 + 총액)</SectionLabel>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                <SummaryCard label="전체 견적" value={s.quotesTotal ?? quotes.length} tone="default" />
                <SummaryCard label="번역 견적" value={s.quotesTranslation ?? 0} tone="blue" />
                <SummaryCard label="통역 견적" value={s.quotesInterpretation ?? 0} tone="blue" />
                {(s.quotesMixed ?? 0) > 0 ? <SummaryCard label="혼합 견적" value={s.quotesMixed ?? 0} tone="amber" /> : null}
                {(s.quotesEquipment ?? 0) > 0 ? <SummaryCard label="장비 견적" value={s.quotesEquipment ?? 0} tone="gray" /> : null}
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                <SummaryCard label="생성 예정 프로젝트" value={s.projectCount} tone="green" />
                <SummaryCard label="수행배정(번역)" value={s.assignmentsTranslation ?? 0} tone="blue" />
                <SummaryCard label="수행배정(통역)" value={s.assignmentsInterpretation ?? 0} tone="blue" />
                <SummaryCard label="수행배정 전체" value={s.assignmentCount} tone="blue" />
              </div>
              {/* C. Master Resolution (Grouping 이후 적용) */}
              <SectionLabel>C. Master Resolution (거래처 — Grouping 이후)</SectionLabel>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                <SummaryCard label="거래처 exact" value={s.companyExact ?? 0} tone="green" />
                <SummaryCard label="거래처 Alias" value={s.companyAlias ?? 0} tone="green" />
                <SummaryCard label="본점/브랜드 관계" value={s.companyRelation ?? 0} tone="green" />
                <SummaryCard label="거래처 미매칭" value={s.companyUnmatched} tone="amber" />
                <SummaryCard label="담당자 미매칭" value={s.contactUnmatched} tone="amber" />
                <SummaryCard label="통번역사 미매칭" value={s.translatorUnmatched} tone="amber" />
              </div>
              {/* D. 견적금액 대사 */}
              <SectionLabel>D. 견적금액 대사</SectionLabel>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                <SummaryCard label="견적 총액(원본)" value={s.quoteTotalOriginal} tone="default" isCurrency />
                <SummaryCard label="견적 총액(시스템)" value={s.quoteTotalSystem} tone="blue" isCurrency />
                <SummaryCard label="견적 차액" value={s.quoteTotalDiff} tone={diffTone(s.quoteTotalDiff)} isCurrency />
              </div>
              {/* D-2. 9/15 지급회차 대사 (원본 지급일=9/15 인 통번역 행만 · Master 매칭과 무관) */}
              <SectionLabel>D-2. 9/15 지급 대사 (지급일=2026-09-15 행만 · 장비 제외 · Master 매칭 무관)</SectionLabel>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                <SummaryCard label="9/15 지급 대상 행" value={s.pay0915Rows ?? 0} tone="default" />
                <SummaryCard label="9/15 세전(원본)" value={s.pay0915PreTaxOriginal ?? 0} tone="default" isCurrency />
                <SummaryCard label="9/15 세전(시스템)" value={s.pay0915PreTaxSystem ?? 0} tone="blue" isCurrency />
                <SummaryCard label="9/15 세전 차액" value={s.pay0915PreTaxDiff ?? 0} tone={diffTone(s.pay0915PreTaxDiff ?? 0)} isCurrency />
                <SummaryCard label="9/15 아닌 행" value={s.nonPay0915Rows ?? 0} tone="gray" />
              </div>
              {/* E. 등록 가능 여부 — 카운트 통일 */}
              <SectionLabel>E. 등록 가능 여부</SectionLabel>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                <SummaryCard label="전체 견적" value={s.quotesTotal ?? quotes.length} tone="default" />
                <SummaryCard label="등록 가능(신규)" value={s.quotesNew} tone="green" />
                <SummaryCard label="확인필요" value={s.quotesNeedsReview} tone="amber" />
                <SummaryCard label="등록불가(오류)" value={s.quotesError} tone="red" />
                <SummaryCard label="기존/중복(제외)" value={s.quotesIdentical + s.quotesDuplicate} tone="gray" />
              </div>

              {/* 견적별 / 수행별 탭 — 견적별은 전체 견적 Group 수(생성예정과 구분) */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                {([['quotes', `견적별 · 전체 ${quotes.length} (등록가능 ${s.quotesNew})`], ['assignments', `수행별 (${assignments.length})`]] as const).map(([k, label]) => (
                  <button key={k} onClick={() => setTab(k)} data-testid={`pastwork-tab-${k}`} aria-label={`${label} 보기`}
                    style={{ fontSize: 12, padding: '6px 14px', borderRadius: 8, cursor: 'pointer', border: tab === k ? '1px solid #0284c7' : '1px solid #e5e7eb', background: tab === k ? '#e0f2fe' : '#fff', color: tab === k ? '#0369a1' : '#6b7280', fontWeight: 700 }}>
                    {label}
                  </button>
                ))}
              </div>

              {tab === 'quotes' ? (
                <div style={{ overflowX: 'auto', maxHeight: 460, overflowY: 'auto', border: '1px solid #eef2f7', borderRadius: 10 }}>
                  <table className="veritas-read-table" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1180 }}>
                    <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                      <tr>
                        <th style={{ ...th, width: 34 }}>
                          <input type="checkbox" checked={allNewSelected} onChange={toggleAll} disabled={newQuotes.length === 0} data-testid="pastwork-select-all" aria-label="신규 견적 전체 선택" />
                        </th>
                        <th style={th}>상태</th>
                        <th style={th}>유형</th>
                        <th style={th}>거래처</th>
                        <th style={th}>고객</th>
                        <th style={th}>견적일</th>
                        <th style={th}>견적명</th>
                        <th style={thR}>품목</th>
                        <th style={thR}>수행</th>
                        <th style={thR}>공급가(원본)</th>
                        <th style={thR}>총액(원본)</th>
                        <th style={thR}>총액(시스템)</th>
                        <th style={thR}>차액</th>
                        <th style={th}>사유/경고</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quotes.slice(0, MAX_PREVIEW_ROWS).map((q, idx) => {
                        const m = statusMeta(q.status);
                        const selectable = q.status === 'new';
                        return (
                          <tr key={idx} style={{ background: q.status === 'new' ? '#fff' : '#fcfcfd' }}>
                            <td style={td}>
                              {selectable ? (
                                <input type="checkbox" checked={selected.has(q.groupKey)} onChange={() => toggleGroup(q.groupKey)} data-testid={`pastwork-select-${idx}`} aria-label={`${q.companyName} 견적 선택`} />
                              ) : <span style={{ color: '#cbd5e1' }}>-</span>}
                            </td>
                            <td style={td}><span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: m.bg, color: m.color, border: `1px solid ${m.border}`, whiteSpace: 'nowrap' }}>{m.label}</span></td>
                            <td style={td}>{q.quoteCategory === 'mixed' ? '혼합' : (CATEGORY_LABEL[q.quoteCategory ?? ''] ?? '-')}</td>
                            <td style={td}>
                              {q.matchedCompanyName || q.companyName || '-'}
                              {q.matchedDivisionName ? <span style={{ color: '#6d28d9' }}> / {q.matchedDivisionName}</span> : ''}
                              {q.matchedCompanyId ? <MethodTag method={q.companyMatchMethod} /> : <span style={{ color: '#b45309' }}> ⚠</span>}
                              {q.matchedCompanyId && q.matchedCompanyName && q.companyName && q.matchedCompanyName !== q.companyName
                                ? <div style={{ fontSize: 10, color: '#9ca3af' }}>원본: {q.companyName}</div> : null}
                            </td>
                            <td style={td}>{q.customerName || '-'}{q.customerName && !q.matchedContactId ? <span style={{ color: '#b45309' }}> ⚠</span> : ''}</td>
                            <td style={td}>{q.quoteIssueDate || '-'}</td>
                            <td style={td} title={q.title}>{q.title}</td>
                            <td style={tdR}>{q.itemCount}</td>
                            <td style={tdR}>{q.assignmentCount}</td>
                            <td style={tdR}>{won(q.originalSupply)}</td>
                            <td style={tdR}>{won(q.originalTotal)}</td>
                            <td style={tdR}>{won(q.systemTotal)}</td>
                            <td style={{ ...tdR, fontWeight: 700, color: Math.abs(q.totalDiff) < 0.5 ? '#047857' : '#b91c1c' }}>{q.totalDiff ? won(q.totalDiff) : '0'}</td>
                            <td style={{ ...td, whiteSpace: 'normal', color: q.status === 'error' ? '#b91c1c' : '#9ca3af' }}>
                              {q.warning ? <span style={{ color: '#b45309', fontWeight: 600 }}>⚠ {q.warning}</span> : (q.reason ?? '-')}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ overflowX: 'auto', maxHeight: 460, overflowY: 'auto', border: '1px solid #eef2f7', borderRadius: 10 }}>
                  <table className="veritas-read-table" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1240 }}>
                    <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                      <tr>
                        <th style={th}>상태</th>
                        <th style={th}>구분</th>
                        <th style={th}>통번역사</th>
                        <th style={th}>언어</th>
                        <th style={th}>파일/내용</th>
                        <th style={th}>납품일</th>
                        <th style={th}>지급예정</th>
                        <th style={thR}>기본지급액</th>
                        <th style={thR}>추가비용</th>
                        <th style={thR}>세전(시스템)</th>
                        <th style={thR}>세전(원본)</th>
                        <th style={thR}>차액</th>
                        <th style={thR}>원천세</th>
                        <th style={thR}>실지급</th>
                        <th style={th}>사유/경고</th>
                      </tr>
                    </thead>
                    <tbody>
                      {assignments.slice(0, MAX_PREVIEW_ROWS).map((a, idx) => {
                        const m = statusMeta(a.status);
                        return (
                          <tr key={idx} style={{ background: a.status === 'new' ? '#fff' : '#fcfcfd' }}>
                            <td style={td}><span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: m.bg, color: m.color, border: `1px solid ${m.border}`, whiteSpace: 'nowrap' }}>{m.label}</span></td>
                            <td style={td}>{CATEGORY_LABEL[a.category] ?? a.category}</td>
                            <td style={td}>{a.translatorName || '-'}{a.matchedTranslatorId ? '' : <span style={{ color: '#b45309' }}> ⚠</span>}</td>
                            <td style={td}>{a.language || '-'}</td>
                            <td style={td} title={a.fileName || a.content}>{a.fileName || a.content || '-'}</td>
                            <td style={td}>{a.deliveryDate || '-'}</td>
                            <td style={td}>{a.payDate || <span style={{ color: '#cbd5e1' }}>자동</span>}</td>
                            <td style={tdR}>{won(a.base)}</td>
                            <td style={tdR}>{won(a.expenseTotal)}</td>
                            <td style={{ ...tdR, fontWeight: 600 }}>{won(a.computedPreTax)}</td>
                            <td style={tdR}>{a.originalPreTax != null ? won(a.originalPreTax) : '-'}</td>
                            <td style={{ ...tdR, fontWeight: 700, color: Math.abs(a.preTaxDiff) < 0.5 ? '#047857' : '#b91c1c' }}>{a.preTaxDiff ? won(a.preTaxDiff) : '0'}</td>
                            <td style={tdR}>{a.withholdingTax ? won(a.withholdingTax) : '0'}</td>
                            <td style={{ ...tdR, fontWeight: 700, color: '#0369a1' }}>{won(a.netPay)}</td>
                            <td style={{ ...td, whiteSpace: 'normal', color: a.status === 'error' ? '#b91c1c' : '#9ca3af' }}>
                              {a.warning ? <span style={{ color: '#b45309', fontWeight: 600 }}>⚠ {a.warning}</span> : (a.reason ?? '-')}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <PrimaryBtn onClick={doExecute} disabled={executing || selected.size === 0} data-testid="pastwork-execute" aria-label="선택 견적 일괄등록">
                  {executing ? '처리 중...' : `선택한 견적 ${selected.size.toLocaleString()}건 일괄등록`}
                </PrimaryBtn>
                <span style={{ fontSize: 12, color: '#6b7280' }}>확인필요·오류·기존등록 건은 저장되지 않습니다. 미매칭 통번역사가 있는 수행은 제외되고 견적/판매만 생성됩니다.</span>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

interface BoundaryState { error: Error | null; }
class PastWorkErrorBoundary extends React.Component<{ onClose: () => void; children: React.ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };
  static getDerivedStateFromError(error: Error): BoundaryState { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error('[PastWorkBulkImportPage] 렌더 오류 격리', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <BackToListButton onClick={this.props.onClose} variant="subtle" label="견적서 목록" testId="pastwork-error-back" />
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>과거자료 일괄등록</h2>
          </div>
          <Card style={{ padding: 24 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#b91c1c', marginBottom: 8 }}>⚠️ 화면 표시 중 오류가 발생했습니다</div>
            <p style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.7, margin: '0 0 16px' }}>이 화면만 안전하게 중단했습니다. 파일을 확인하거나 새로고침 후 재시도해 주세요.</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <PrimaryBtn onClick={() => this.setState({ error: null })} data-testid="pastwork-error-retry" aria-label="다시 시도">다시 시도</PrimaryBtn>
              <BackToListButton onClick={this.props.onClose} variant="subtle" label="견적서 목록" testId="pastwork-error-close" />
            </div>
          </Card>
        </div>
      );
    }
    return this.props.children;
  }
}

export function PastWorkBulkImportPage(props: Props) {
  return (
    <PastWorkErrorBoundary onClose={props.onClose}>
      <PastWorkBulkImportInner {...props} />
    </PastWorkErrorBoundary>
  );
}

export default PastWorkBulkImportPage;
