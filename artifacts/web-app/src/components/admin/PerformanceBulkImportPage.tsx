import React, { useState, useCallback, useRef, useEffect } from 'react';
import './readTableView.css';
import { api } from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn } from '../ui';
import { BackToListButton } from './BackToListButton';
import { downloadPerformanceImportTemplate, type PerfSeedItem, type PerfTemplateMeta } from '../../lib/performanceImportExcel';

// ─── 수행정보/통번역사 배정 Native Excel 대량등록 (VERITAS OS 7차) ────────────
// 프로젝트 단위 Import(projectId 고정, §4). 4단계: 템플릿 다운로드 → 업로드 → 분석/미리보기 → 등록.
// new-only(§29): "신규배정" + 사용자 선택 행만 INSERT. 기존배정/확인필요/오류는 저장 안 함.
// 계산값(세전→원천세→세후)은 서버 SSOT 결과를 그대로 표시(§28).

type RowStatus = 'new' | 'identical' | 'needs_review' | 'duplicate_file' | 'error';

interface PerfRow {
  rowNumber: number;
  rowSeq: string;
  status: RowStatus;
  reason?: string;
  warning?: string;
  rowKey: string | null;
  productName: string;
  serviceType: string;
  translatorName: string;
  email: string;
  phone: string;
  language: string;
  startDate: string;
  endDate: string;
  deliveryDate: string;
  fee100: number | null;
  fee85: number | null;
  quantity: number | null;
  unit: string;
  base: number;
  expenseTotal: number;
  deductionTotal: number;
  grossPre: number;
  withholdingRate: number;
  withholdingTax: number;
  netPay: number;
  payScheduled: string | null;
}

interface Summary { total: number; new: number; identical: number; needsReview: number; duplicateFile: number; error: number; warning: number; }
interface AnalyzeResponse { fileName: string; sheetName: string; columnMap: Record<string, string | null>; summary: Summary; rows: PerfRow[]; }

function safeNum(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function won(v: number | null | undefined): string { return safeNum(v).toLocaleString('ko-KR'); }

type StatusMeta = { label: string; bg: string; color: string; border: string };
const STATUS_META: Record<RowStatus, StatusMeta> = {
  new: { label: '신규 배정 예정', bg: '#ecfdf5', color: '#047857', border: '#a7f3d0' },
  identical: { label: '기존 배정(제외)', bg: '#f3f4f6', color: '#6b7280', border: '#e5e7eb' },
  needs_review: { label: '확인필요(제외)', bg: '#fffbeb', color: '#b45309', border: '#fde68a' },
  duplicate_file: { label: '파일 내 중복(제외)', bg: '#fff7ed', color: '#c2410c', border: '#fed7aa' },
  error: { label: '오류(제외)', bg: '#fef2f2', color: '#b91c1c', border: '#fecaca' },
};
function statusMeta(s: unknown): StatusMeta {
  const k = typeof s === 'string' ? s : '';
  return STATUS_META[k as RowStatus] ?? { label: k || '알 수 없음', bg: '#f3f4f6', color: '#6b7280', border: '#e5e7eb' };
}

const th: React.CSSProperties = { padding: '8px 8px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#6b7280', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
const thR: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '7px 8px', fontSize: 12, color: '#374151', borderBottom: '1px solid #edf0f3', verticalAlign: 'middle', whiteSpace: 'nowrap' };
const tdR: React.CSSProperties = { ...td, textAlign: 'right' };

function SummaryCard({ label, value, tone }: { label: string; value: number | undefined; tone: 'default' | 'green' | 'amber' | 'red' | 'gray' }) {
  const tones: Record<string, { bg: string; color: string }> = {
    default: { bg: '#f9fafb', color: '#111827' }, green: { bg: '#ecfdf5', color: '#047857' },
    amber: { bg: '#fffbeb', color: '#b45309' }, red: { bg: '#fef2f2', color: '#b91c1c' }, gray: { bg: '#f3f4f6', color: '#6b7280' },
  };
  const t = tones[tone];
  return (
    <div style={{ flex: '1 1 110px', minWidth: 100, background: t.bg, borderRadius: 10, padding: '12px 14px', border: '1px solid #eef2f7' }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: t.color }}>{safeNum(value).toLocaleString()}</div>
    </div>
  );
}

const MAX_PREVIEW_ROWS = 500;

interface Props {
  projectId: number;
  token: string;
  meta?: PerfTemplateMeta;
  onClose: () => void;
  onToast: (msg: string) => void;
  onDone?: () => void;
}

function PerformanceBulkImportInner({ projectId, token, meta, onClose, onToast, onDone }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [downloadingTpl, setDownloadingTpl] = useState(false);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [done, setDone] = useState<{ inserted: number; summary: Summary } | null>(null);
  const [filter, setFilter] = useState<'all' | RowStatus | 'warning'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  // 분석 결과가 오면 신규(new) 행 전체를 기본 선택(§29 — 사용자가 개별 해제 가능).
  useEffect(() => {
    if (!analysis) { setSelected(new Set()); return; }
    setSelected(new Set(analysis.rows.filter(r => r.status === 'new' && r.rowKey).map(r => r.rowKey as string)));
  }, [analysis]);

  const pickFile = (f: File | null) => {
    if (!f) return;
    const name = f.name.toLowerCase();
    if (!name.endsWith('.xls') && !name.endsWith('.xlsx')) { onToast('.xls 또는 .xlsx 파일만 업로드할 수 있습니다.'); return; }
    setFile(f); setAnalysis(null); setDone(null);
  };

  const doTemplate = useCallback(async () => {
    setDownloadingTpl(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/performances/import-template`), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error ?? '템플릿 정보 조회 실패'}`); return; }
      const items = (data.items ?? []) as PerfSeedItem[];
      downloadPerformanceImportTemplate((data.meta ?? meta ?? {}) as PerfTemplateMeta, items);
      onToast(items.length ? `판매품목 ${items.length}건이 채워진 템플릿을 다운로드했습니다.` : '템플릿을 다운로드했습니다. (판매품목 없음)');
    } catch {
      onToast('오류: 템플릿 다운로드 중 문제가 발생했습니다.');
    } finally { setDownloadingTpl(false); }
  }, [projectId, token, meta, onToast]);

  const doAnalyze = useCallback(async () => {
    if (!file) return;
    setAnalyzing(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await fetch(api(`/api/admin/projects/${projectId}/performances/bulk-import/analyze`), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error ?? '분석 실패'}`); return; }
      setAnalysis(data); setFilter('all');
    } catch { onToast('오류: 파일 분석 중 문제가 발생했습니다.'); }
    finally { setAnalyzing(false); }
  }, [file, projectId, token, onToast]);

  const doExecute = useCallback(async () => {
    if (!file || !analysis) return;
    const keys = [...selected];
    if (keys.length === 0) { onToast('등록할 신규 배정을 선택하세요.'); return; }
    if (!window.confirm(`선택한 신규 배정 ${keys.length}건을 등록할까요?\n\n기존 배정·정산/지급 데이터는 변경되지 않습니다. 확인필요·오류·기존배정 건은 저장되지 않습니다.`)) return;
    setExecuting(true);
    try {
      const fd = new FormData(); fd.append('file', file); fd.append('selectedKeys', JSON.stringify(keys));
      const res = await fetch(api(`/api/admin/projects/${projectId}/performances/bulk-import/execute`), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error ?? '등록 실패'}`); return; }
      setDone({ inserted: safeNum(data.inserted), summary: data.summary });
      onToast(`수행자 배정 ${safeNum(data.inserted).toLocaleString()}건을 등록했습니다.`);
      onDone?.();
    } catch { onToast('오류: 대량등록 중 문제가 발생했습니다.'); }
    finally { setExecuting(false); }
  }, [file, analysis, selected, projectId, token, onToast, onDone]);

  // 초기화 — 현재 브라우저 화면의 업로드/분석 상태만 비운다(파일·분석결과·Preview·카운트·선택 초기화).
  //   DB/정산/지급 데이터는 절대 건드리지 않는다(순수 클라이언트 상태 리셋).
  const resetAll = useCallback(() => {
    setFile(null);
    setAnalysis(null);
    setDone(null);
    setSelected(new Set());
    setFilter('all');
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const allRows = Array.isArray(analysis?.rows) ? analysis!.rows : [];
  const filteredRows = filter === 'all' ? allRows : filter === 'warning' ? allRows.filter(r => !!r.warning) : allRows.filter(r => r.status === filter);
  const shownRows = filteredRows.slice(0, MAX_PREVIEW_ROWS);
  const newRows = allRows.filter(r => r.status === 'new' && r.rowKey);
  const allNewSelected = newRows.length > 0 && newRows.every(r => selected.has(r.rowKey as string));

  const toggleRow = (key: string) => setSelected(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const toggleAll = () => setSelected(prev => (allNewSelected ? new Set() : new Set(newRows.map(r => r.rowKey as string))));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <BackToListButton onClick={onClose} variant="subtle" label="뒤로가기" testId="perf-import-back" />
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>수행자 배정 대량등록</h2>
      </div>

      {done ? (
        <Card style={{ padding: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#047857', marginBottom: 16 }}>✓ 등록 완료</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            <SummaryCard label="신규 배정 등록" value={done.inserted} tone="green" />
            <SummaryCard label="기존 배정(제외)" value={done.summary?.identical} tone="gray" />
            <SummaryCard label="확인필요" value={done.summary?.needsReview} tone="amber" />
            <SummaryCard label="파일 내 중복" value={done.summary?.duplicateFile} tone="amber" />
            <SummaryCard label="오류" value={done.summary?.error} tone="red" />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <PrimaryBtn onClick={onClose} data-testid="perf-import-finish" aria-label="완료">완료</PrimaryBtn>
            <GhostBtn onClick={() => { setFile(null); setAnalysis(null); setDone(null); if (inputRef.current) inputRef.current.value = ''; }}
              data-testid="perf-import-again" aria-label="다른 파일 등록">다른 파일 등록</GhostBtn>
          </div>
        </Card>
      ) : (
        <>
          <Card style={{ padding: 20, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>1. 템플릿 다운로드 → 작성 → 업로드</div>
              <GhostBtn onClick={doTemplate} disabled={downloadingTpl} style={{ fontSize: 12, padding: '6px 12px' }}
                data-testid="perf-import-template" aria-label="수행자배정 템플릿 다운로드">
                {downloadingTpl ? '준비 중…' : '⬇ 템플릿 다운로드(판매품목 채움)'}
              </GhostBtn>
            </div>
            <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 12px' }}>
              현재 판매의 판매품목이 미리 채워진 <b>단일 시트(수행자배정)</b> 템플릿을 내려받아, 통번역사·금액·세금처리를 입력한 뒤 업로드하세요.
              통번역사는 마스터에 등록되어 있어야 하며(자동 생성 안 함), 이메일·휴대폰·통번역사코드로 매칭됩니다.
              한 행 = 수행 1건 + 수행자 1명(수행자가 여러 명이면 같은 수행정보를 여러 행에 반복).
              추가통역료·출장비·교통비는 전용 컬럼, 그 외 <b>기타비용은 항목/금액 3쌍</b>으로 입력합니다.
              기타비용 항목 예시: <b>숙박비 · 식비 · 저작권료 · 이동일보상비 · 취소보상비</b>(그 외 직접 입력 가능).
              기존 배정·정산/지급 데이터는 변경되지 않습니다(신규 배정만 등록).
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
                  <input ref={inputRef} type="file" accept=".xls,.xlsx" style={{ display: 'none' }} data-testid="perf-import-file" aria-label="엑셀 파일 선택"
                    onChange={e => pickFile(e.target.files?.[0] ?? null)} />
                </label>
                <GhostBtn onClick={resetAll} disabled={analyzing || executing} style={{ fontSize: 12, padding: '6px 14px' }} data-testid="perf-import-reset" aria-label="초기화">초기화</GhostBtn>
                <PrimaryBtn onClick={doAnalyze} disabled={!file || analyzing} style={{ fontSize: 12, padding: '6px 16px' }} data-testid="perf-import-analyze" aria-label="파일 분석">
                  {analyzing ? '분석 중...' : '파일 분석'}
                </PrimaryBtn>
              </div>
            </div>
          </Card>

          {analysis && (
            <Card style={{ padding: 20, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10 }}>2. 분석 결과</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 12 }}>
                시트: <b>{analysis.sheetName || '-'}</b> · 매핑된 컬럼:{' '}
                {Object.entries(analysis.columnMap ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ') || '없음'}
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
                <SummaryCard label="전체 행" value={analysis.summary?.total} tone="default" />
                <SummaryCard label="신규 배정 예정" value={analysis.summary?.new} tone="green" />
                <SummaryCard label="경고" value={analysis.summary?.warning} tone="amber" />
                <SummaryCard label="기존 배정" value={analysis.summary?.identical} tone="gray" />
                <SummaryCard label="확인필요" value={analysis.summary?.needsReview} tone="amber" />
                <SummaryCard label="파일 내 중복" value={analysis.summary?.duplicateFile} tone="amber" />
                <SummaryCard label="오류" value={analysis.summary?.error} tone="red" />
              </div>

              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>3. 미리보기 (세전→원천세→세후는 시스템 계산값)</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {([['all', '전체'], ['new', '신규 배정'], ['warning', '경고'], ['identical', '기존 배정'], ['needs_review', '확인필요'], ['duplicate_file', '파일 내 중복'], ['error', '오류']] as const).map(([k, label]) => (
                  <button key={k} onClick={() => setFilter(k as 'all' | RowStatus | 'warning')} data-testid={`perf-import-filter-${k}`} aria-label={`${label} 필터`}
                    style={{ fontSize: 11, padding: '4px 10px', borderRadius: 999, cursor: 'pointer', border: filter === k ? '1px solid #0284c7' : '1px solid #e5e7eb', background: filter === k ? '#e0f2fe' : '#fff', color: filter === k ? '#0369a1' : '#6b7280', fontWeight: 600 }}>
                    {label}
                  </button>
                ))}
              </div>

              <div style={{ overflowX: 'auto', maxHeight: 460, overflowY: 'auto', border: '1px solid #eef2f7', borderRadius: 10 }}>
                <table className="veritas-read-table" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1180 }}>
                  <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                    <tr>
                      <th style={{ ...th, width: 34 }}>
                        <input type="checkbox" checked={allNewSelected} onChange={toggleAll} disabled={newRows.length === 0}
                          data-testid="perf-import-select-all" aria-label="신규 배정 전체 선택" />
                      </th>
                      <th style={th}>상태</th>
                      <th style={th}>통번역사</th>
                      <th style={th}>서비스</th>
                      <th style={th}>수행일</th>
                      <th style={thR}>요금(100%)</th>
                      <th style={thR}>통역료(85%)</th>
                      <th style={thR}>기본지급액</th>
                      <th style={thR}>추가비용</th>
                      <th style={thR}>차감</th>
                      <th style={thR}>세전</th>
                      <th style={thR}>원천세</th>
                      <th style={thR}>원천세율</th>
                      <th style={thR}>세후</th>
                      <th style={th}>지급예정일</th>
                      <th style={th}>사유/경고</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownRows.map((r, idx) => {
                      const m = statusMeta(r.status);
                      const selectable = r.status === 'new' && !!r.rowKey;
                      return (
                        <tr key={idx} style={{ background: r.status === 'new' ? '#fff' : '#fcfcfd' }}>
                          <td style={td}>
                            {selectable ? (
                              <input type="checkbox" checked={selected.has(r.rowKey as string)} onChange={() => toggleRow(r.rowKey as string)}
                                data-testid={`perf-import-select-${r.rowSeq}`} aria-label={`${r.translatorName} 배정 선택`} />
                            ) : <span style={{ color: '#cbd5e1' }}>-</span>}
                          </td>
                          <td style={td}><span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: m.bg, color: m.color, border: `1px solid ${m.border}`, whiteSpace: 'nowrap' }}>{m.label}</span></td>
                          <td style={td} title={`${r.email} ${r.phone}`}>{r.translatorName || <span style={{ color: '#cbd5e1' }}>-</span>}</td>
                          <td style={td} title={r.productName}>{r.serviceType || r.productName || '-'}</td>
                          <td style={td}>{r.startDate || '-'}{r.endDate && r.endDate !== r.startDate ? `~${r.endDate}` : ''}</td>
                          <td style={tdR}>{r.fee100 != null ? won(r.fee100) : '-'}</td>
                          <td style={tdR}>{r.fee85 != null ? won(r.fee85) : '-'}</td>
                          <td style={tdR}>{won(r.base)}</td>
                          <td style={tdR}>{won(r.expenseTotal)}</td>
                          <td style={tdR}>{r.deductionTotal ? `-${won(r.deductionTotal)}` : '0'}</td>
                          <td style={{ ...tdR, fontWeight: 600 }}>{won(r.grossPre)}</td>
                          <td style={tdR}>{r.withholdingTax ? won(Math.abs(r.withholdingTax)) : '0'}</td>
                          <td style={tdR}>{r.withholdingRate ? `${r.withholdingRate}%` : (r.status === 'new' ? '미확정' : '-')}</td>
                          <td style={{ ...tdR, fontWeight: 700, color: '#0369a1' }}>{won(r.netPay)}</td>
                          <td style={td}>{r.payScheduled || <span style={{ color: '#cbd5e1' }}>자동</span>}</td>
                          <td style={{ ...td, whiteSpace: 'normal', color: r.status === 'error' ? '#b91c1c' : '#9ca3af' }}>
                            {r.warning ? <span style={{ color: '#b45309', fontWeight: 600 }}>⚠ {r.warning}</span> : (r.reason ?? '-')}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {filteredRows.length > MAX_PREVIEW_ROWS && (
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>※ 미리보기는 {MAX_PREVIEW_ROWS.toLocaleString()}행까지만 표시됩니다. 등록은 선택 전체에 적용됩니다.</div>
              )}

              <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <PrimaryBtn onClick={doExecute} disabled={executing || selected.size === 0} data-testid="perf-import-execute" aria-label="선택 배정 등록">
                  {executing ? '처리 중...' : `선택한 신규 배정 ${selected.size.toLocaleString()}건 등록`}
                </PrimaryBtn>
                <span style={{ fontSize: 12, color: '#6b7280' }}>기존 배정·정산/지급 데이터는 변경되지 않습니다. 기존배정·확인필요·오류 건은 저장되지 않습니다.</span>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

interface BoundaryState { error: Error | null; }
class PerfImportErrorBoundary extends React.Component<{ onClose: () => void; children: React.ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };
  static getDerivedStateFromError(error: Error): BoundaryState { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error('[PerformanceBulkImportPage] 렌더 오류 격리', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <BackToListButton onClick={this.props.onClose} variant="subtle" label="뒤로가기" testId="perf-import-error-back" />
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>수행자 배정 대량등록</h2>
          </div>
          <Card style={{ padding: 24 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#b91c1c', marginBottom: 8 }}>⚠️ 화면 표시 중 오류가 발생했습니다</div>
            <p style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.7, margin: '0 0 16px' }}>이 화면만 안전하게 중단했습니다. 파일을 확인하거나 새로고침 후 재시도해 주세요.</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <PrimaryBtn onClick={() => this.setState({ error: null })} data-testid="perf-import-error-retry" aria-label="다시 시도">다시 시도</PrimaryBtn>
              <BackToListButton onClick={this.props.onClose} variant="subtle" label="뒤로가기" testId="perf-import-error-close" />
            </div>
          </Card>
        </div>
      );
    }
    return this.props.children;
  }
}

export function PerformanceBulkImportPage(props: Props) {
  return (
    <PerfImportErrorBoundary onClose={props.onClose}>
      <PerformanceBulkImportInner {...props} />
    </PerfImportErrorBoundary>
  );
}

export default PerformanceBulkImportPage;
