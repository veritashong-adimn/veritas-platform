import React, { useState, useCallback, useRef } from 'react';
import { api } from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn } from '../ui';

// ─── 안전 유틸 ────────────────────────────────────────────────────────────────
// 서버 응답의 형태가 예상과 다르거나(구버전 배포·enum 불일치) 일부 필드가 비어도
// 화면 전체가 크래시되지 않도록 방어적으로 값을 정규화한다.
/** 숫자로 안전 변환(undefined/NaN → 0). SummaryCard 등 표시용. */
function safeNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ─── 거래처·담당자 대량등록(홈택스 엑셀) 공통 페이지 ──────────────────────────
// 4단계: 파일 업로드 → 분석 → 미리보기 → 등록 실행. 거래처/담당자 공용이며
// 실제 엔드포인트·컬럼 매핑만 entity 별 config 로 분리한다.
//
// 등록 방식(mode):
//   new_only(기본) → 신규만 등록. 기존 데이터는 변경하지 않음.
//   update         → 신규 등록 + 사업자번호/담당자키 기준 기존 데이터 업데이트.

export type BulkImportEntity = 'company' | 'contact';

type RowStatus = 'new' | 'identical' | 'update' | 'duplicate_file' | 'error';
type ImportMode = 'new_only' | 'update';

interface FieldChange { old: string; new: string; }

interface AnalyzedRow {
  rowNumber: number;
  status: RowStatus;
  reason?: string;
  existingId?: number | null;
  changes?: Record<string, FieldChange>;
  [key: string]: unknown;
}

interface Summary { total: number; new: number; identical: number; update: number; duplicateFile: number; error: number; }

interface AnalyzeResponse {
  fileName: string;
  sheetName: string;
  headerRowIndex: number;
  columnMap: Record<string, string | null>;
  summary: Summary;
  rows: AnalyzedRow[];
}

interface ExecuteResponse {
  fileName: string;
  mode: ImportMode;
  inserted: number;
  updated: number;
  summary: Summary;
}

interface ColumnDef { key: string; label: string; }

interface EntityConfig {
  title: string;
  analyzeUrl: string;
  executeUrl: string;
  columns: ColumnDef[];
  defaultsNote: string;
  resultLabels: { new: string; unit: string; missingCompany?: boolean };
}

const COMPANY_CONFIG: EntityConfig = {
  title: '거래처 대량등록',
  analyzeUrl: '/api/admin/companies/bulk-import/analyze',
  executeUrl: '/api/admin/companies/bulk-import/execute',
  columns: [
    { key: 'name', label: '거래처명' },
    { key: 'businessNumber', label: '사업자등록번호' },
    { key: 'representativeName', label: '대표자명' },
    { key: 'registeredAt', label: '등록일' },
    { key: 'industry', label: '업태' },
    { key: 'businessCategory', label: '종목' },
    { key: 'address', label: '주소' },
  ],
  defaultsNote: '거래처 유형: 고객사 · 고객 분류: 기업 (등록 후 개별 수정 가능)',
  resultLabels: { new: '신규 거래처 등록', unit: '건' },
};

const CONTACT_CONFIG: EntityConfig = {
  title: '담당자 대량등록',
  analyzeUrl: '/api/admin/contacts/bulk-import/analyze',
  executeUrl: '/api/admin/contacts/bulk-import/execute',
  columns: [
    { key: 'matchedCompanyName', label: '연결 거래처명' },
    { key: 'businessNumber', label: '사업자등록번호' },
    { key: 'name', label: '담당자명' },
    { key: 'registeredAt', label: '등록일' },
    { key: 'department', label: '부서' },
    { key: 'mobile', label: '휴대폰' },
    { key: 'email', label: '이메일' },
    { key: 'officePhone', label: '직장전화' },
  ],
  defaultsNote: '활성 · 기본/견적/청구 담당자 모두 해제 (역할은 등록 후 직접 지정). 사업자등록번호로 기존 거래처에 연결됩니다.',
  resultLabels: { new: '신규 담당자 등록', unit: '명', missingCompany: true },
};

type StatusMeta = { label: string; bg: string; color: string; border: string };
const STATUS_META: Record<RowStatus, StatusMeta> = {
  new: { label: '신규 등록 예정', bg: '#ecfdf5', color: '#047857', border: '#a7f3d0' },
  identical: { label: '기존 데이터 동일', bg: '#f3f4f6', color: '#6b7280', border: '#e5e7eb' },
  update: { label: '기존 데이터 변경 예정', bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
  duplicate_file: { label: '파일 내 중복(제외)', bg: '#fff7ed', color: '#c2410c', border: '#fed7aa' },
  error: { label: '오류(제외)', bg: '#fef2f2', color: '#b91c1c', border: '#fecaca' },
};

// 구버전 서버가 쓰던 상태값 → 현재 enum 별칭(배포 시차로 인한 불일치 완충).
const LEGACY_STATUS_ALIAS: Record<string, RowStatus> = {
  ready: 'new',
  duplicate_db: 'update',
  duplicateDb: 'update',
};

/** 알 수 없는 상태값이 와도 절대 throw 하지 않는 배지 메타 조회. */
function statusMeta(status: unknown): StatusMeta {
  const key = typeof status === 'string' ? status : '';
  const canonical = (STATUS_META[key as RowStatus] ? key : LEGACY_STATUS_ALIAS[key]) as RowStatus | undefined;
  if (canonical && STATUS_META[canonical]) return STATUS_META[canonical];
  return { label: key || '알 수 없음', bg: '#f3f4f6', color: '#6b7280', border: '#e5e7eb' };
}

const tableTh: React.CSSProperties = {
  padding: '9px 10px', textAlign: 'left', fontSize: 11, fontWeight: 600,
  color: '#6b7280', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap',
};
const tableTd: React.CSSProperties = {
  padding: '8px 10px', fontSize: 12, color: '#374151',
  borderBottom: '1px solid #edf0f3', verticalAlign: 'middle', whiteSpace: 'nowrap',
};

function SummaryCard({ label, value, tone }: { label: string; value: number | undefined; tone: 'default' | 'green' | 'amber' | 'red' | 'blue' | 'gray' }) {
  const tones: Record<string, { bg: string; color: string }> = {
    default: { bg: '#f9fafb', color: '#111827' },
    green: { bg: '#ecfdf5', color: '#047857' },
    amber: { bg: '#fffbeb', color: '#b45309' },
    red: { bg: '#fef2f2', color: '#b91c1c' },
    blue: { bg: '#eff6ff', color: '#1d4ed8' },
    gray: { bg: '#f3f4f6', color: '#6b7280' },
  };
  const t = tones[tone];
  return (
    <div style={{ flex: '1 1 120px', minWidth: 110, background: t.bg, borderRadius: 10, padding: '12px 14px', border: '1px solid #eef2f7' }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: t.color }}>{safeNum(value).toLocaleString()}</div>
    </div>
  );
}

/** 변경 예정 셀: 이전값 → 새값 강조. 변경 없는 셀은 일반 표시. */
function CellValue({ row, colKey }: { row: AnalyzedRow; colKey: string }) {
  const change = row.status === 'update' ? row.changes?.[colKey] : undefined;
  if (change) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
        <span style={{ color: '#9ca3af', textDecoration: 'line-through' }}>{change.old || '(없음)'}</span>
        <span style={{ color: '#9ca3af' }}>→</span>
        <span style={{ color: '#1d4ed8', fontWeight: 700, background: '#eff6ff', padding: '1px 6px', borderRadius: 5 }}>{change.new || '(없음)'}</span>
      </span>
    );
  }
  const v = String(row[colKey] ?? '');
  return v ? <>{v}</> : <span style={{ color: '#cbd5e1' }}>-</span>;
}

const MAX_PREVIEW_ROWS = 500;

interface BulkImportPageProps {
  entity: BulkImportEntity;
  token: string;
  onClose: () => void;
  onToast: (msg: string) => void;
  onDone?: () => void;
}

function BulkImportPageInner({ entity, token, onClose, onToast, onDone }: BulkImportPageProps) {
  const cfg = entity === 'company' ? COMPANY_CONFIG : CONTACT_CONFIG;
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [result, setResult] = useState<ExecuteResponse | null>(null);
  const [filter, setFilter] = useState<'all' | RowStatus>('all');
  const [mode, setMode] = useState<ImportMode>('new_only');
  const inputRef = useRef<HTMLInputElement>(null);

  const pickFile = (f: File | null) => {
    if (!f) return;
    const name = f.name.toLowerCase();
    if (!name.endsWith('.xls') && !name.endsWith('.xlsx')) {
      onToast('.xls 또는 .xlsx 파일만 업로드할 수 있습니다.');
      return;
    }
    setFile(f);
    setAnalysis(null);
    setResult(null);
  };

  const doAnalyze = useCallback(async () => {
    if (!file) return;
    setAnalyzing(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(api(cfg.analyzeUrl), {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error ?? '분석 실패'}`); return; }
      setAnalysis(data);
      setFilter('all');
    } catch {
      onToast('오류: 파일 분석 중 문제가 발생했습니다.');
    } finally {
      setAnalyzing(false);
    }
  }, [file, cfg.analyzeUrl, token, onToast]);

  const doExecute = useCallback(async () => {
    if (!file || !analysis) return;
    const newCount = safeNum(analysis.summary?.new);
    const updateCount = mode === 'update' ? safeNum(analysis.summary?.update) : 0;
    if (newCount === 0 && updateCount === 0) { onToast('처리할 대상이 없습니다.'); return; }

    const parts = [`신규 ${newCount.toLocaleString()}${cfg.resultLabels.unit} 등록`];
    if (updateCount > 0) parts.push(`기존 ${updateCount.toLocaleString()}건 업데이트`);
    if (!window.confirm(`${parts.join(' · ')}을(를) 진행할까요?${updateCount > 0 ? '\n\n기존 데이터의 허용 필드(연락처·등록일 등)가 엑셀 값으로 수정됩니다. ID·연결관계는 유지됩니다.' : ''}`)) return;

    setExecuting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mode', mode);
      const res = await fetch(api(cfg.executeUrl), {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error ?? '등록 실패'}`); return; }
      setResult(data);
      const inserted = safeNum(data.inserted);
      const updatedN = safeNum(data.updated);
      const msg = updatedN > 0
        ? `신규 ${inserted.toLocaleString()}${cfg.resultLabels.unit} · 업데이트 ${updatedN.toLocaleString()}건 완료`
        : `${inserted.toLocaleString()}${cfg.resultLabels.unit} 등록 완료`;
      onToast(msg);
      onDone?.();
    } catch {
      onToast('오류: 일괄 등록 중 문제가 발생했습니다.');
    } finally {
      setExecuting(false);
    }
  }, [file, analysis, mode, cfg.executeUrl, cfg.resultLabels.unit, token, onToast, onDone]);

  const allRows = Array.isArray(analysis?.rows) ? analysis!.rows : [];
  const filteredRows = filter === 'all' ? allRows : allRows.filter(r => r.status === filter);
  const shownRows = filteredRows.slice(0, MAX_PREVIEW_ROWS);

  const newCount = safeNum(analysis?.summary?.new);
  const updateCount = safeNum(analysis?.summary?.update);
  const execDisabled = executing || (newCount === 0 && (mode !== 'update' || updateCount === 0));
  const execLabel = mode === 'update' && updateCount > 0
    ? `신규 ${newCount.toLocaleString()}${cfg.resultLabels.unit} 등록 · 기존 ${updateCount.toLocaleString()}건 업데이트`
    : `신규 ${newCount.toLocaleString()}${cfg.resultLabels.unit} 등록`;

  return (
    <div>
      {/* ── 헤더 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <GhostBtn onClick={onClose} style={{ fontSize: 13, padding: '7px 14px' }} data-testid="bulk-import-back" aria-label="목록으로 돌아가기">
          ← 목록으로
        </GhostBtn>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>{cfg.title}</h2>
      </div>

      {/* ── 결과 화면 ── */}
      {result ? (
        <Card style={{ padding: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#047857', marginBottom: 16 }}>✓ 처리 완료</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            <SummaryCard label={cfg.resultLabels.new} value={result.inserted} tone="green" />
            <SummaryCard label="기존 데이터 업데이트" value={result.updated} tone="blue" />
            <SummaryCard label="기존 데이터 동일" value={result.summary?.identical} tone="gray" />
            <SummaryCard label="파일 내부 중복" value={result.summary?.duplicateFile} tone="amber" />
            <SummaryCard label="오류" value={result.summary?.error} tone="red" />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <PrimaryBtn onClick={onClose} data-testid="bulk-import-finish" aria-label="완료">완료</PrimaryBtn>
            <GhostBtn onClick={() => { setFile(null); setAnalysis(null); setResult(null); if (inputRef.current) inputRef.current.value = ''; }}
              data-testid="bulk-import-again" aria-label="다른 파일 등록">다른 파일 등록</GhostBtn>
          </div>
        </Card>
      ) : (
        <>
          {/* ── 단계 1: 파일 업로드 ── */}
          <Card style={{ padding: 20, marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4 }}>1. 파일 업로드</div>
            <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 12px' }}>
              홈택스에서 내려받은 거래처목록 엑셀 파일(.xls, .xlsx)을 업로드하세요. {cfg.defaultsNote}
            </p>
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragEnter={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
              onDrop={e => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0] ?? null); }}
              style={{
                border: dragOver ? '2px dashed #0284c7' : '1.5px dashed #cbd5e1',
                background: dragOver ? '#e0f2fe' : '#f8fafc',
                borderRadius: 12, padding: '28px 20px', textAlign: 'center', transition: 'all .12s',
              }}
            >
              {file ? (
                <div style={{ fontSize: 13, color: '#0284c7', fontWeight: 600 }}>
                  ✓ {file.name} <span style={{ color: '#94a3b8', fontWeight: 400 }}>({(file.size / 1024).toFixed(0)} KB)</span>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: '#94a3b8' }}>{dragOver ? '파일을 여기에 놓으세요' : '파일을 드래그하거나 아래 버튼으로 선택하세요'}</div>
              )}
              <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center' }}>
                <label style={{ cursor: 'pointer', display: 'inline-block' }}>
                  <span style={{ fontSize: 12, padding: '6px 14px', borderRadius: 8, background: '#0284c7', color: '#fff', fontWeight: 600 }}>
                    {file ? '파일 교체' : '파일 선택'}
                  </span>
                  <input ref={inputRef} type="file" accept=".xls,.xlsx" style={{ display: 'none' }}
                    data-testid="bulk-import-file-input" aria-label="엑셀 파일 선택"
                    onChange={e => { const f = e.target.files?.[0] ?? null; pickFile(f); }} />
                </label>
                <PrimaryBtn onClick={doAnalyze} disabled={!file || analyzing}
                  style={{ fontSize: 12, padding: '6px 16px' }}
                  data-testid="bulk-import-analyze" aria-label="파일 분석">
                  {analyzing ? '분석 중...' : '파일 분석'}
                </PrimaryBtn>
              </div>
            </div>
          </Card>

          {/* ── 단계 2 & 3: 분석 결과 + 미리보기 ── */}
          {analysis && (
            <Card style={{ padding: 20, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10 }}>2. 파일 분석 결과</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 12 }}>
                시트: <b>{analysis.sheetName || '-'}</b> · 헤더 {safeNum(analysis.headerRowIndex) + 1}행 감지 · 매핑된 컬럼:{' '}
                {Object.entries(analysis.columnMap ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ') || '없음'}
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
                <SummaryCard label="전체 행" value={analysis.summary?.total} tone="default" />
                <SummaryCard label="신규 등록 예정" value={analysis.summary?.new} tone="green" />
                <SummaryCard label="변경 예정" value={analysis.summary?.update} tone="blue" />
                <SummaryCard label="기존 데이터 동일" value={analysis.summary?.identical} tone="gray" />
                <SummaryCard label="파일 내 중복" value={analysis.summary?.duplicateFile} tone="amber" />
                <SummaryCard label="오류" value={analysis.summary?.error} tone="red" />
              </div>

              {/* ── 등록 방식 선택 ── */}
              <div style={{ background: '#f8fafc', border: '1px solid #eef2f7', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>등록 방식</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {([
                    ['new_only', '신규만 등록', '기존 데이터는 변경하지 않습니다. (안전)'],
                    ['update', '신규 등록 + 기존 데이터 업데이트', '사업자번호/담당자 기준으로 기존 데이터를 엑셀 값으로 수정합니다.'],
                  ] as const).map(([val, label, desc]) => {
                    const active = mode === val;
                    return (
                      <label key={val} data-testid={`bulk-import-mode-${val}`}
                        style={{
                          flex: '1 1 260px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start',
                          padding: '10px 12px', borderRadius: 8,
                          border: active ? '1.5px solid #0284c7' : '1px solid #e5e7eb',
                          background: active ? '#e0f2fe' : '#fff',
                        }}>
                        <input type="radio" name="bulk-import-mode" value={val} checked={active}
                          onChange={() => setMode(val)} aria-label={label}
                          style={{ marginTop: 2 }} />
                        <span>
                          <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: active ? '#0369a1' : '#374151' }}>{label}</span>
                          <span style={{ display: 'block', fontSize: 11, color: '#6b7280', marginTop: 2 }}>{desc}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>3. 미리보기</div>
              {/* 상태 필터 */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {([['all', '전체'], ['new', '신규 등록 예정'], ['update', '변경 예정'], ['identical', '기존 동일'], ['duplicate_file', '파일 내 중복'], ['error', '오류']] as const).map(([k, label]) => (
                  <button key={k} onClick={() => setFilter(k as 'all' | RowStatus)}
                    data-testid={`bulk-import-filter-${k}`} aria-label={`${label} 필터`}
                    style={{
                      fontSize: 11, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                      border: filter === k ? '1px solid #0284c7' : '1px solid #e5e7eb',
                      background: filter === k ? '#e0f2fe' : '#fff', color: filter === k ? '#0369a1' : '#6b7280', fontWeight: 600,
                    }}>
                    {label}
                  </button>
                ))}
              </div>

              <div style={{ overflowX: 'auto', maxHeight: 460, overflowY: 'auto', border: '1px solid #eef2f7', borderRadius: 10 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                  <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                    <tr>
                      <th style={tableTh}>상태</th>
                      {cfg.columns.map(c => <th key={c.key} style={tableTh}>{c.label}</th>)}
                      <th style={tableTh}>사유</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownRows.map((row, idx) => {
                      const meta = statusMeta(row.status);
                      return (
                        <tr key={idx} style={{ background: row.status === 'update' ? '#fbfdff' : (row.status === 'new' ? '#fff' : '#fcfcfd') }}>
                          <td style={tableTd}>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`, whiteSpace: 'nowrap' }}>
                              {meta.label}
                            </span>
                          </td>
                          {cfg.columns.map(c => (
                            <td key={c.key} style={tableTd} title={String(row[c.key] ?? '')}>
                              <CellValue row={row} colKey={c.key} />
                            </td>
                          ))}
                          <td style={{ ...tableTd, color: row.status === 'error' ? '#b91c1c' : '#9ca3af', whiteSpace: 'normal' }}>{row.reason ?? '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {filteredRows.length > MAX_PREVIEW_ROWS && (
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
                  ※ 미리보기는 {MAX_PREVIEW_ROWS.toLocaleString()}행까지만 표시됩니다. 처리는 전체 대상에 적용됩니다.
                </div>
              )}

              {/* ── 단계 4: 등록 실행 ── */}
              <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <PrimaryBtn onClick={doExecute} disabled={execDisabled}
                  data-testid="bulk-import-execute" aria-label="등록 실행">
                  {executing ? '처리 중...' : execLabel}
                </PrimaryBtn>
                <span style={{ fontSize: 12, color: '#6b7280' }}>
                  {mode === 'update'
                    ? '기존 ID·연결관계는 유지되며 허용 필드만 수정됩니다. 동일·중복·오류 건은 저장되지 않습니다.'
                    : '기존 데이터는 변경되지 않습니다. 동일·중복·오류 건은 저장되지 않습니다.'}
                </span>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ─── Error Boundary ───────────────────────────────────────────────────────────
// 분석/렌더 중 예기치 못한 예외가 나더라도 앱 전체(Replit Preview)가 오류 화면으로
// 전환되지 않도록 대량등록 화면 내부에서만 오류 메시지를 표시한다. (요구사항 §8)
interface BoundaryProps { title: string; onClose: () => void; children: React.ReactNode; }
interface BoundaryState { error: Error | null; }

class BulkImportErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 콘솔에 원인/stack 을 남겨 진단을 돕는다(전체 앱은 중단되지 않음).
    console.error('[BulkImportPage] 렌더 오류로 화면을 안전하게 격리했습니다.', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <GhostBtn onClick={this.props.onClose} style={{ fontSize: 13, padding: '7px 14px' }}
              data-testid="bulk-import-error-back" aria-label="목록으로 돌아가기">← 목록으로</GhostBtn>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>{this.props.title}</h2>
          </div>
          <Card style={{ padding: 24 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#b91c1c', marginBottom: 8 }}>⚠️ 화면을 표시하는 중 오류가 발생했습니다</div>
            <p style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.7, margin: '0 0 16px' }}>
              분석 결과를 처리하는 중 문제가 발생하여 이 화면만 안전하게 중단했습니다.
              파일을 다시 확인하거나 페이지를 새로고침한 뒤 재시도해 주세요. (다른 기능은 정상 동작합니다.)
            </p>
            <details style={{ fontSize: 11, color: '#9ca3af', marginBottom: 16 }}>
              <summary style={{ cursor: 'pointer' }}>오류 상세</summary>
              <pre style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{this.state.error.message}</pre>
            </details>
            <div style={{ display: 'flex', gap: 10 }}>
              <PrimaryBtn onClick={() => this.setState({ error: null })} data-testid="bulk-import-error-retry" aria-label="다시 시도">다시 시도</PrimaryBtn>
              <GhostBtn onClick={this.props.onClose} data-testid="bulk-import-error-close" aria-label="목록으로">목록으로</GhostBtn>
            </div>
          </Card>
        </div>
      );
    }
    return this.props.children;
  }
}

export function BulkImportPage(props: BulkImportPageProps) {
  const title = props.entity === 'company' ? COMPANY_CONFIG.title : CONTACT_CONFIG.title;
  return (
    <BulkImportErrorBoundary title={title} onClose={props.onClose}>
      <BulkImportPageInner {...props} />
    </BulkImportErrorBoundary>
  );
}

export default BulkImportPage;
