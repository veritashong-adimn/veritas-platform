// ─── 과거 CRM 자료 (Legacy CRM Archive Lite) — C-4A(Import) + C-4B(조회/검색/상세) ─
// 기존 CRM Excel 을 "원본 그대로" 보존·조회. Current Master 를 생성/통합하지 않는다.
// 한 화면 안에서 [자료 조회](기본) / [Excel 등록] 모드로 구분. 검색은 server-side pagination.
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '../../lib/constants';
import { formatAmountDisplay } from '../../lib/utils';
import { LegacyArchiveDetailPage } from './LegacyArchiveDetailPage';
import { LegacyArchiveSyncPanel } from './LegacyArchiveSyncPanel';

type SourceType = 'sales_list' | 'progress' | 'translator_list';
const SOURCE_LABEL: Record<SourceType, string> = { sales_list: '판매목록', progress: '통번역 진행관리', translator_list: 'CRM 통번역사 명부' };

type DuplicateAnalysis = {
  duplicateExcludedRows: number; duplicateGroups: number;
  exactDuplicateRows: number; sourceRawDifferentRows: number; originalRowDifferentRows: number;
  nullEmptyDifferenceRows: number; safeToSkip: boolean;
};
type DuplicateSample = {
  rowHash: string; excelRows: number[]; sourceSheet: string; groupCount: number;
  classification: 'EXACT_DUPLICATE' | 'SOURCE_RAW_DIFFERENT' | 'ORIGINAL_ROW_DIFFERENT'; exactDuplicate: boolean;
  companyName: string | null; contactName: string | null; productName: string | null;
  translatorName: string | null; language: string | null;
  deliveryDate: string | null; payoutDate: string | null; payoutPretax: number | null;
  differences: { column: string; excelRowA: number; excelRowB: number; valueA: unknown; valueB: unknown; kind: string }[];
};
type ArchivePlan = {
  total: number; toSave: number; alreadyStored: number; reuploadExcluded: number;
  sameContentRows: number; sameContentGroups: number; conflicts: number;
  warning: number; isReupload: boolean; safeToExecute: boolean;
};
type ExcelPreviewPage = {
  headers: string[]; totalRows: number; page: number; pageSize: number; sheetCount: number;
  rows: { sourceRow: number; sourceSheet: string; values: unknown[] }[];
};
type IdentityCandidate = { columnIndex: number; originalHeader: string; isMutable: boolean; nonNullCount: number; nullCount: number; blankCount: number; distinctCount: number; duplicateValueCount: number; uniquenessRatio: number; classification: string; valueType: string; sampleValues: string[] };
type IdentityAnalysis = {
  analyzed: boolean; analyzedSheet: string; sheetCount: number; totalRows: number; totalColumns: number;
  candidateColumns: IdentityCandidate[];
  compositeCandidates: { columns: string[]; coverage: number; distinctCount: number; uniquenessRatio: number; classification: string }[];
  mutableColumns: string[];
  relationAnalysis: { available: boolean; reason?: string; saleColumn?: string; assignmentColumn?: string; totalSales?: number; multiRowSales?: number; maxRowsPerSale?: number; avgRowsPerSale?: number; samples?: { saleId: string; rowCount: number; translatorCount: number; assignmentCount: number; sourceRows: number[] }[] };
  identicalRowAnalysis: { idColumnUsed: string | null; identicalRows: number; identicalGroups: number; distinguishableByIdRows: number; distinguishableByIdGroups: number; sameIdRows: number; sameIdGroups: number; missingIdRows: number; missingIdGroups: number; fullRowIdenticalRows: number; fullRowIdenticalGroups: number };
  representativeSamples: { rowHashShort: string; groupCount: number; companyName: string | null; productName: string | null; classification: string; members: { sourceRow: number; idValues: Record<string, string | null> }[] }[];
  conclusion: { stableRowIdFound: boolean; recommendedIdentity: string | null; confidence: string; reason: string };
};
type RecordMatching = {
  mode: 'INITIAL_IMPORT' | 'REUPLOAD'; total: number;
  counts: { NEW: number; SAME: number; UPDATED: number; AMBIGUOUS: number };
  sameSetGroups: number;
  updatedSamples: { sourceRow: number; matchedRecordId: number | string | null; companyName: string | null; productName: string | null; confidence: string; changedFields: { field: string; before: unknown; after: unknown }[]; reason: string }[];
  ambiguousSamples: { sourceRows: number[]; companyName: string | null; productName: string | null; translatorName: string | null; language: string | null; recordDate: string | null; candidateCount: number; reason: string }[];
};
type AnalyzeResult = {
  sourceType: SourceType; fileName: string; fileHash?: string;
  sheets: { sheetName: string; headerRowIndex: number; recognizedColumns: Record<string, string | null>; rowCount: number }[];
  summary: { total: number; new: number; duplicate: number; warning: number };
  sample: any[];
  archivePlan?: ArchivePlan;                  // (C-4D) 저장 계획 요약
  conflicts?: { sourceSheet: string; sourceRow: number; storedRowHash: string; incomingRowHash: string }[];
  duplicateAnalysis?: DuplicateAnalysis;      // (C-4D) "원본 동일행" 상세(보존 대상)
  duplicateSamples?: DuplicateSample[];
  excelPreview?: ExcelPreviewPage;            // (C-4E) Excel 원본 미리보기 1페이지
  identityAnalysis?: IdentityAnalysis;        // (C-4H-2) Excel Identity 진단
  recordMatching?: RecordMatching;            // (C-4I-a) Record Matching DRY-RUN
  snapshotContext?: {                         // (C-4G) 등록 방식 + 현재/신규 스냅샷
    registrationMode: 'new_snapshot' | 'duplicate_file';
    currentSnapshot: { snapshotId: number; fileName: string | null; totalRows: number; savedRows: number; fileHashShort: string | null; uploadedAt: string } | null;
    newFile: { fileName: string; fileHashShort: string; totalRows: number };
  };
};
type ExecuteResult = { total: number; created: number; skippedDuplicate: number; warnings: number; batchId: number | null; sheetNames: string[]; mode?: 'new_snapshot' | 'duplicate_file'; snapshotId?: number | null; supersededSnapshotIds?: number[] };
type SnapshotRow = { id: number; sourceType: SourceType | null; originalFilename: string | null; fileHash: string | null; totalRows: number; successRows: number; isCurrent: boolean | null; status: string; createdAt: string };

type ListRow = {
  id: number; sourceType: SourceType; recordDate: string | null; saleDate?: string | null;
  companyName: string | null; contactName: string | null; translatorName: string | null;
  productName: string | null; language: string | null; totalAmount: string | null; payoutPretax: string | null;
  deliveryDate: string | null; payoutDate: string | null; collectionDate: string | null; collectionStatus: string | null;
  sourceFile: string | null; sourceSheet: string | null; sourceRow: number | null;
};
type Pagination = { page: number; pageSize: number; total: number; totalPages: number };
// (C-4I-c) 진행관리 전체컬럼 조회 행 — source_raw 원본 그대로.
type FullRow = { id: number; sourceRow: number | null; sourceSheet: string | null; sourceRaw: Record<string, unknown> };
// (C-4I-d) 다운로드 대상 행수 추정.
type ExportEstimate = { scope: 'search' | 'all'; sourceType: string; total: number; types: { sourceType: SourceType; label: string; count: number }[] };

const PAGE_SIZE = 50;
// (C-4J-2C-8) 기본 선택 탭 = 판매목록. '전체(혼합)' 탭은 화면에서 제거(통합검색 API/기능은 유지).
const EMPTY_FILTERS = { sourceType: 'sales_list' as 'all' | SourceType, q: '', company: '', translator: '', product: '', language: '', collectionStatus: '', dateFrom: '', dateTo: '', snapshot: 'current' as 'current' | 'all' | string };

export function LegacyCrmArchiveTab({ token, setToast }: { token: string; setToast: (msg: string) => void }) {
  const authHeaders = { Authorization: `Bearer ${token}` };
  const [mode, setMode] = useState<'search' | 'import'>('search');
  const [detailId, setDetailId] = useState<number | null>(null);

  // ── 조회 상태 ──
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS });
  const [rows, setRows] = useState<ListRow[]>([]);
  // (C-4I-c) 진행관리 전체컬럼 뷰
  const [fullView, setFullView] = useState(false);
  const [fullHeaders, setFullHeaders] = useState<string[]>([]);
  const [fullRows, setFullRows] = useState<FullRow[]>([]);
  const [fullResolved, setFullResolved] = useState(true);
  // (C-4J-2C-7) full 뷰의 유형. sales_list full 뷰 행은 상세화면으로 이동 가능(progress 는 불가).
  const [fullSourceType, setFullSourceType] = useState<SourceType | null>(null);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 1 });
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  // ── (C-4I-d) Excel 다운로드 상태 ──
  const [showDownload, setShowDownload] = useState(false);
  const [downloadScope, setDownloadScope] = useState<'search' | 'all'>('search');
  const [downloading, setDownloading] = useState(false);     // 중복 요청 방지 가드
  const [estimate, setEstimate] = useState<ExportEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);

  // ── Import 상태 (C-4A) ──
  const [impType, setImpType] = useState<SourceType>('sales_list');
  const [file, setFile] = useState<File | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [analyze, setAnalyze] = useState<AnalyzeResult | null>(null);
  const [execResult, setExecResult] = useState<ExecuteResult | null>(null);
  const [showDupDetail, setShowDupDetail] = useState(false);
  // (C-4E) Excel 원본 미리보기 페이지 상태
  const [excelPreview, setExcelPreview] = useState<ExcelPreviewPage | null>(null);
  const [excelPageSize, setExcelPageSize] = useState(50);
  const [excelLoading, setExcelLoading] = useState(false);
  const [showIdentity, setShowIdentity] = useState(false);  // (C-4H-2) 데이터 식별자 진단 펼침
  const resetImport = () => { setAnalyze(null); setExecResult(null); setShowDupDetail(false); setExcelPreview(null); setExcelPageSize(50); };
  // (C-4D §8) 파일 내부 동일행은 Execute 차단 사유가 아니다. source identity 충돌(동일 위치·내용 상이)일 때만 차단.
  const dupBlocksExecute = analyze?.archivePlan?.safeToExecute === false;

  // ── Drag & Drop 업로드(UI/UX only — 기존 analyze/execute 로직·API 불변) ──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const MAX_UPLOAD = 15 * 1024 * 1024; // backend Multer 와 동일(15MB). backend 검증을 대체하지 않는 UX 가드.
  const formatSize = (b: number) => (b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
  // 파일 수락: 확장자/용량 검증 → file 교체 + 기존 Preview/Execute 결과 무효화.
  const acceptFile = (f: File | null | undefined) => {
    if (!f) return;
    const name = f.name.toLowerCase();
    if (!(name.endsWith('.xls') || name.endsWith('.xlsx'))) { setToast('Excel 파일(.xls, .xlsx)만 등록할 수 있습니다.'); return; }
    if (f.size > MAX_UPLOAD) { setToast('파일 크기는 최대 15MB까지 등록할 수 있습니다.'); return; }
    const replacing = !!file;
    resetImport();           // 새 파일/교체 → 기존 Preview 결과 무효화 → Execute disabled
    setFile(f);
    if (replacing) setToast('새 파일로 교체되었습니다.');
  };
  const openPicker = () => fileInputRef.current?.click();
  const removeFile = () => { setFile(null); resetImport(); if (fileInputRef.current) fileInputRef.current.value = ''; };
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setDragActive(false); acceptFile(e.dataTransfer.files?.[0]); };
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); if (!dragActive) setDragActive(true); };
  const onDragLeave = (e: React.DragEvent) => { e.preventDefault(); setDragActive(false); };

  // (C-4J-2C-9) f 로 조회조건 스냅샷을 명시 주입 가능(기본은 현재 filters). 초기화 등 setState 직후 즉시 조회 시 stale closure 방지.
  const runSearch = useCallback(async (page = 1, f: typeof filters = filters) => {
    setSearching(true);
    try {
      const p = new URLSearchParams();
      if (f.sourceType !== 'all') p.set('sourceType', f.sourceType);
      for (const k of ['q', 'company', 'translator', 'product', 'language', 'collectionStatus', 'dateFrom', 'dateTo'] as const) {
        if (f[k]?.trim()) p.set(k, f[k].trim());
      }
      p.set('page', String(page)); p.set('pageSize', String(PAGE_SIZE));
      if (f.snapshot && f.snapshot !== 'current') p.set('snapshot', f.snapshot);  // (C-4G) 기본 current(=effective)
      // (C-4I-c/e) 전체컬럼(full) 뷰 여부는 서버가 데이터 기준으로 판정한다:
      //   진행관리 탭 또는 '전체' 탭 결과가 단일 progress 유형이면 full. 화면은 data.view 로 분기.
      p.set('view', 'full');   // 서버에 full 가능 여부 판정을 요청(혼합/판매목록이면 서버가 요약 목록을 반환).
      const res = await fetch(api(`/api/admin/legacy-archive?${p.toString()}`), { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '검색 실패');
      setSearched(true); setPagination(data.pagination);
      if (data.view === 'full') {
        setFullView(true); setFullHeaders(data.headers ?? []); setFullRows(data.rows ?? []); setFullResolved(data.headersResolved !== false);
        setFullSourceType((data.sourceType as SourceType) ?? null);
      } else {
        setFullView(false); setRows(data.rows ?? []); setFullSourceType(null);
      }
    } catch (e: any) { setToast(e?.message || '검색 실패'); }
    finally { setSearching(false); }
  }, [filters, token]);

  // ── (C-4I-d) Excel 다운로드 ──
  // 화면 필터와 동일한 쿼리스트링 구성(검색 결과 다운로드 정합성). scope=all 은 서버가 sourceType 만 반영.
  const buildExportParams = useCallback((scope: 'search' | 'all') => {
    const p = new URLSearchParams();
    p.set('scope', scope);
    if (filters.sourceType !== 'all') p.set('sourceType', filters.sourceType);
    if (scope === 'search') {
      for (const k of ['q', 'company', 'translator', 'product', 'language', 'collectionStatus', 'dateFrom', 'dateTo'] as const) {
        if (filters[k]?.trim()) p.set(k, filters[k].trim());
      }
      if (filters.snapshot && filters.snapshot !== 'current') p.set('snapshot', filters.snapshot);
    }
    return p;
  }, [filters]);

  const fetchEstimate = useCallback(async (scope: 'search' | 'all') => {
    setEstimating(true); setEstimate(null);
    try {
      const res = await fetch(api(`/api/admin/legacy-archive/export-estimate?${buildExportParams(scope).toString()}`), { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '다운로드 대상 행수 조회 실패');
      setEstimate(data);
    } catch (e: any) { setToast(e?.message || '다운로드 대상 행수 조회 실패'); }
    finally { setEstimating(false); }
  }, [buildExportParams, token]);

  const openDownload = useCallback(() => { setDownloadScope('search'); setShowDownload(true); fetchEstimate('search'); }, [fetchEstimate]);
  const changeScope = useCallback((scope: 'search' | 'all') => { setDownloadScope(scope); fetchEstimate(scope); }, [fetchEstimate]);

  const runDownload = useCallback(async () => {
    if (downloading) return;                       // 중복 클릭/요청 방지
    setDownloading(true);
    setToast('다운로드를 준비 중입니다…');
    try {
      const res = await fetch(api(`/api/admin/legacy-archive/export?${buildExportParams(downloadScope).toString()}`), { headers: authHeaders });
      if (!res.ok) {
        let msg = '다운로드 실패';
        try { const j = await res.json(); msg = j?.error || msg; } catch { /* non-json */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const fname = m ? decodeURIComponent(m[1]) : `과거CRM자료_${downloadScope === 'all' ? '전체' : '검색결과'}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setToast(`다운로드 완료: ${fname}`);
      setShowDownload(false);
    } catch (e: any) { setToast(e?.message || '다운로드 실패'); }
    finally { setDownloading(false); }
  }, [downloading, downloadScope, buildExportParams, token]);

  // (C-4G) 스냅샷 이력 조회
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const loadSnapshots = useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (filters.sourceType !== 'all') p.set('sourceType', filters.sourceType);
      const res = await fetch(api(`/api/admin/legacy-archive-snapshots?${p.toString()}`), { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '스냅샷 이력 조회 실패');
      setSnapshots(data.snapshots ?? []);
    } catch (e: any) { setToast(e?.message || '스냅샷 이력 조회 실패'); }
  }, [filters.sourceType, token]);

  // (C-4J-2C-9) search 모드 첫 진입 + 탭(sourceType) 전환 시 즉시 1페이지 자동 조회(검색 버튼 불필요).
  //   단일 effect 로 통합해 탭 클릭당 요청 1회만 발생(중복요청 방지). 동일 탭 재클릭은 sourceType 불변 → 미발생.
  useEffect(() => { if (mode === 'search') runSearch(1); }, [mode, filters.sourceType]); // eslint-disable-line

  const runAnalyze = useCallback(async () => {
    if (!file) { setToast('엑셀 파일을 선택하세요.'); return; }
    setAnalyzing(true); setExecResult(null);
    try {
      const fd = new FormData(); fd.append('file', file); fd.append('sourceType', impType);
      const res = await fetch(api('/api/admin/legacy-archive/analyze'), { method: 'POST', headers: authHeaders, body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '분석 실패');
      setAnalyze(data);
      setExcelPreview(data.excelPreview ?? null);           // (C-4E) 1페이지는 analyze 응답에 포함
      setExcelPageSize(data.excelPreview?.pageSize ?? 50);
    } catch (e: any) { setToast(e?.message || '분석 실패'); } finally { setAnalyzing(false); }
  }, [file, impType, token]);

  // (C-4E) 원본 미리보기 페이지 이동 — 브라우저가 보유한 동일 File 재전송(재업로드/DB write 없음, page/pageSize만 변경).
  const fetchExcelPage = useCallback(async (page: number, pageSize: number) => {
    if (!file) return;
    setExcelLoading(true);
    try {
      const fd = new FormData(); fd.append('file', file); fd.append('sourceType', impType);
      fd.append('page', String(page)); fd.append('pageSize', String(pageSize));
      const res = await fetch(api('/api/admin/legacy-archive/preview-rows'), { method: 'POST', headers: authHeaders, body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '원본 미리보기 조회 실패');
      setExcelPreview(data); setExcelPageSize(data.pageSize);
    } catch (e: any) { setToast(e?.message || '원본 미리보기 조회 실패'); } finally { setExcelLoading(false); }
  }, [file, impType, token]);

  // 상세 모드
  if (detailId !== null) {
    return <LegacyArchiveDetailPage id={detailId} token={token} setToast={setToast} onBack={() => setDetailId(null)} />;
  }

  const box: React.CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, background: '#fff', marginBottom: 16 };
  const tab = (active: boolean): React.CSSProperties => ({ padding: '8px 18px', borderRadius: 8, cursor: 'pointer', fontWeight: 800, fontSize: 14, border: active ? '2px solid #0ea5e9' : '1px solid #d1d5db', background: active ? '#e0f2fe' : '#fff', color: active ? '#0369a1' : '#374151' });
  const chip = (active: boolean): React.CSSProperties => ({ padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13, border: active ? '2px solid #0ea5e9' : '1px solid #d1d5db', background: active ? '#e0f2fe' : '#fff', color: active ? '#0369a1' : '#374151' });
  const btn = (disabled: boolean, primary?: boolean): React.CSSProperties => ({ padding: '10px 20px', borderRadius: 8, fontWeight: 700, fontSize: 14, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, background: primary ? '#0ea5e9' : '#111827', color: '#fff' });
  const input: React.CSSProperties = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, minWidth: 120 };

  // (C-4E-UI) 과거 CRM 자료는 대량 데이터 검수 화면 → 중앙 좁은 1200px 고정 해제, 상위 content 영역 전체 폭 사용.
  //   부모(AdminDashboard content 영역)가 이미 sidebar 제외 flex:1 + 좌우 padding 을 제공하므로 이 래퍼만 100% 로 확장한다.
  //   다른 관리자 탭은 각자 컨테이너를 쓰므로 영향 없음.
  return (
    <div style={{ width: '100%', maxWidth: 'none', margin: 0, padding: '24px 0' }} data-testid="legacy-crm-archive-tab">
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#111827' }}>과거 CRM 자료</h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>기존 CRM 자료를 원본 그대로 보존·조회합니다. 현재 Master 등록과 무관하게 검색/상세조회됩니다.</p>
      </div>

      {/* (C-4I-n) 상단 한 줄: 좌측 모드 탭 + 우측 끝 [과거 스냅샷][Excel 다운로드]. 좁아지면 줄바꿈(겹침 방지). */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={tab(mode === 'search')} role="button" aria-label="자료 조회" data-testid="archive-mode-search" onClick={() => setMode('search')}>자료 조회</div>
        <div style={tab(mode === 'import')} role="button" aria-label="Excel 등록" data-testid="archive-mode-import" onClick={() => setMode('import')}>Excel 등록</div>
        {mode === 'search' && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button style={{ ...btn(false), background: '#fff', color: '#374151', border: '1px solid #d1d5db' }} data-testid="archive-snapshots-toggle"
                    onClick={() => { const nv = !showSnapshots; setShowSnapshots(nv); if (nv) loadSnapshots(); }} aria-label="스냅샷 이력">
              {showSnapshots ? '스냅샷 이력 닫기' : '과거 스냅샷'}
            </button>
            {/* (C-4I-d) Excel 다운로드 — 현재 페이지가 아니라 일치하는 전체 행을 내려받는다. */}
            <button style={{ ...btn(false), background: '#047857', color: '#fff' }} data-testid="archive-download-btn"
                    onClick={openDownload} aria-label="Excel 다운로드">↓ Excel 다운로드</button>
          </div>
        )}
      </div>

      {mode === 'search' && (
        <>
          {/* 필터 */}
          <div style={box}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              {([['sales_list', '판매목록'], ['progress', '통번역 진행관리'], ['translator_list', 'CRM 통번역사 명부']] as [string, string][]).map(([v, l]) => (
                <div key={v} style={chip(filters.sourceType === v)} role="button" aria-label={`유형 ${l}`} data-testid={`archive-filter-type-${v}`}
                     aria-pressed={filters.sourceType === v}
                     onClick={() => {
                       // (C-4J-2C-9) 탭 전환: 동일 탭 재클릭은 무시(중복요청 방지). 이전 탭 데이터 즉시 비우고 1페이지부터 자동 조회(effect).
                       if (filters.sourceType === v) return;
                       setFullRows([]); setRows([]); setSearching(true);
                       setFilters(f => ({ ...f, sourceType: v as any }));
                     }}>{l}</div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input style={{ ...input, minWidth: 220 }} placeholder="통합검색 (거래처/담당자/통번역사/상품/언어)" aria-label="통합검색"
                     data-testid="archive-search-q" value={filters.q} onChange={e => setFilters(f => ({ ...f, q: e.target.value }))}
                     onKeyDown={e => { if (e.key === 'Enter') runSearch(1); }} />
              <input style={input} placeholder="거래처" aria-label="거래처 필터" value={filters.company} onChange={e => setFilters(f => ({ ...f, company: e.target.value }))} />
              <input style={input} placeholder="통번역사" aria-label="통번역사 필터" value={filters.translator} onChange={e => setFilters(f => ({ ...f, translator: e.target.value }))} />
              <input style={input} placeholder="상품" aria-label="상품 필터" value={filters.product} onChange={e => setFilters(f => ({ ...f, product: e.target.value }))} />
              <input style={input} placeholder="언어" aria-label="언어 필터" value={filters.language} onChange={e => setFilters(f => ({ ...f, language: e.target.value }))} />
              <select style={input} aria-label="입금상태 필터" data-testid="archive-filter-collection" value={filters.collectionStatus} onChange={e => setFilters(f => ({ ...f, collectionStatus: e.target.value }))}>
                <option value="">입금상태(전체)</option>
                <option value="paid">입금</option>
                <option value="unpaid">미입금</option>
              </select>
              <input style={input} type="date" aria-label="기간 시작" value={filters.dateFrom} onChange={e => setFilters(f => ({ ...f, dateFrom: e.target.value }))} />
              <span style={{ color: '#9ca3af' }}>~</span>
              <input style={input} type="date" aria-label="기간 종료" value={filters.dateTo} onChange={e => setFilters(f => ({ ...f, dateTo: e.target.value }))} />
              {/* (C-4G) 자료 버전: 기본=최신 스냅샷 / 전체 이력 */}
              <select style={input} aria-label="자료 버전" data-testid="archive-filter-snapshot"
                      value={filters.snapshot === 'current' || filters.snapshot === 'all' ? filters.snapshot : 'batch'}
                      onChange={e => { const v = e.target.value; setFilters(f => ({ ...f, snapshot: v === 'batch' ? f.snapshot : v })); setTimeout(() => runSearch(1), 0); }}>
                <option value="current">최신 자료</option>
                <option value="all">전체 이력</option>
                {filters.snapshot !== 'current' && filters.snapshot !== 'all' && <option value="batch">스냅샷 #{filters.snapshot}</option>}
              </select>
              <button style={btn(searching, true)} disabled={searching} onClick={() => runSearch(1)} aria-label="검색" data-testid="archive-search-btn">{searching ? '검색 중…' : '검색'}</button>
              <button style={btn(false)} onClick={() => {
                // (C-4J-2C-9) 초기화: 검색조건만 비우고 현재 선택 탭은 유지. 리셋 조건을 즉시 주입해 1페이지 재조회(stale closure 방지).
                const nf = { ...EMPTY_FILTERS, sourceType: filters.sourceType };
                setFilters(nf); setFullRows([]); setRows([]); runSearch(1, nf);
              }} aria-label="초기화">초기화</button>
              {/* (C-4I-n) [과거 스냅샷]·[Excel 다운로드] 는 상단 줄 우측으로 이동(중복 생성 금지). */}
            </div>
            {/* (C-4G §10) 스냅샷 이력 패널 */}
            {showSnapshots && (
              <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 8, overflowX: 'auto' }} data-testid="archive-snapshots-panel">
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr style={{ background: '#f3f4f6', textAlign: 'left' }}>
                    {['스냅샷', '유형', '파일명', '행 수', 'file hash', '업로드', '상태', ''].map(h => <th key={h} style={{ padding: '7px 10px', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {snapshots.length === 0 && <tr><td colSpan={8} style={{ padding: 14, color: '#9ca3af' }}>스냅샷 이력이 없습니다.</td></tr>}
                    {snapshots.map(s => (
                      <tr key={s.id} style={{ borderBottom: '1px solid #f0f0f0', background: s.isCurrent ? '#ecfdf5' : '#fff' }}>
                        <td style={{ padding: '6px 10px', fontWeight: 700 }}>#{s.id}</td>
                        <td style={{ padding: '6px 10px' }}>{s.sourceType === 'progress' ? '진행관리' : s.sourceType === 'sales_list' ? '판매목록' : s.sourceType === 'translator_list' ? 'CRM 명부' : (s.sourceType ?? '-')}</td>
                        <td style={{ padding: '6px 10px', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.originalFilename ?? ''}>{s.originalFilename ?? '-'}</td>
                        <td style={{ padding: '6px 10px' }}>{(s.successRows || s.totalRows || 0).toLocaleString()}</td>
                        <td style={{ padding: '6px 10px', fontFamily: 'monospace', color: '#6b7280' }}>{s.fileHash ?? '-'}</td>
                        <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', color: '#6b7280' }}>{s.createdAt ? new Date(s.createdAt).toLocaleString() : '-'}</td>
                        <td style={{ padding: '6px 10px' }}>{s.isCurrent ? <span style={{ color: '#065f46', fontWeight: 800 }}>최신</span> : <span style={{ color: '#9ca3af' }}>이력</span>}</td>
                        <td style={{ padding: '6px 10px' }}>
                          <button style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 700 }}
                                  data-testid={`archive-snapshot-view-${s.id}`}
                                  onClick={() => { setFilters(f => ({ ...f, snapshot: String(s.id) })); setTimeout(() => runSearch(1), 0); }}>이 스냅샷 보기</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 결과 */}
          <div style={box}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 13, color: '#374151', fontWeight: 700 }} data-testid="archive-total">총 {pagination.total.toLocaleString()}건</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{pagination.page} / {pagination.totalPages} 페이지</div>
            </div>
            {/* (C-4I-c) 진행관리 = 원본 전체컬럼(행 클릭 상세 없음). 그 외 = 기존 요약 목록. */}
            {fullView ? (
              <>
                {!fullResolved && (
                  <div style={{ marginBottom: 8, padding: '8px 12px', borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', fontSize: 12.5 }} data-testid="archive-progress-order-hint">
                    원본 컬럼 순서 정보가 없어 임시 순서로 표시됩니다. [Excel 등록]에서 동일 파일을 한 번 Preview 하면 원본 순서로 정렬됩니다.
                  </div>
                )}
                <div style={{ overflowX: 'auto', maxHeight: 620, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }} data-testid="archive-progress-full-scroll">
                  <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: '100%' }}>
                    <thead>
                      <tr>
                        <th style={{ position: 'sticky', top: 0, left: 0, zIndex: 3, background: '#eef2ff', borderBottom: '2px solid #d1d5db', padding: '7px 10px', textAlign: 'left', fontWeight: 800, whiteSpace: 'nowrap' }}>Excel 행</th>
                        {fullHeaders.map((h, i) => (
                          <th key={i} style={{ position: 'sticky', top: 0, zIndex: 2, background: '#f3f4f6', borderBottom: '2px solid #d1d5db', padding: '7px 10px', textAlign: 'left', fontWeight: 800, whiteSpace: 'nowrap' }}>{h && h.trim() !== '' ? h : <span style={{ color: '#9ca3af' }}>(열 {i + 1})</span>}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {fullRows.map((r, ri) => {
                        // (C-4J-2C-7) 판매목록 full 뷰 행은 '전체' 탭과 동일한 상세화면으로 이동. 진행관리 행은 이동 없음(원본 보기 유지).
                        const clickable = fullSourceType === 'sales_list';
                        return (
                        <tr key={r.id} data-testid={`archive-progress-row-${r.id}`}
                            onClick={clickable ? () => setDetailId(r.id) : undefined}
                            aria-label={clickable ? '판매건 상세 보기' : undefined}
                            style={{ background: ri % 2 ? '#fafafa' : '#fff', cursor: clickable ? 'pointer' : 'default' }}
                            onMouseEnter={e => clickable && (e.currentTarget.style.background = '#eff6ff')}
                            onMouseLeave={e => (e.currentTarget.style.background = ri % 2 ? '#fafafa' : '#fff')}>
                          <td style={{ position: 'sticky', left: 0, background: ri % 2 ? '#fafafa' : '#fff', zIndex: 1, padding: '6px 10px', fontWeight: 700, color: '#4338ca', whiteSpace: 'nowrap', borderBottom: '1px solid #f0f0f0' }}>{r.sourceRow ?? '-'}</td>
                          {fullHeaders.map((h, ci) => {
                            const v = r.sourceRaw?.[h];
                            return (
                              <td key={ci} style={{ padding: '6px 10px', whiteSpace: 'nowrap', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', borderBottom: '1px solid #f0f0f0' }} title={v == null ? '' : String(v)}>
                                {v === null || v === undefined ? <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>(null)</span> : v === '' ? <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>(빈 값)</span> : <span style={{ whiteSpace: 'pre' }}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>}
                              </td>
                            );
                          })}
                        </tr>
                        );
                      })}
                      {fullRows.length === 0 && !searching && (
                        <tr><td colSpan={fullHeaders.length + 1} style={{ padding: '32px', textAlign: 'center', color: '#9ca3af' }} data-testid="archive-empty">{searched ? '검색 결과가 없습니다.' : '과거 CRM 자료가 없습니다.'}</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div style={{ marginTop: 6, fontSize: 11.5, color: '#9ca3af' }}>원본 Excel 컬럼·값 그대로 표시합니다(변환 없음). 행별 상세 이동은 제공하지 않습니다.</div>
              </>
            ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#f3f4f6', textAlign: 'left' }}>
                    {['구분', '날짜', '거래처', '담당자', '상품', '통번역사', '언어', '금액', '입금/지급일', '상태'].map(h => (
                      <th key={h} style={{ padding: '8px', borderBottom: '1px solid #e5e7eb' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    // (C-4I-c) 상세 이동은 판매목록(sales_list) 행만. 진행관리 행은 클릭 없음.
                    const clickable = r.sourceType === 'sales_list';
                    return (
                    <tr key={r.id} data-testid={`archive-row-${r.id}`} onClick={clickable ? () => setDetailId(r.id) : undefined}
                        style={{ borderBottom: '1px solid #f3f4f6', cursor: clickable ? 'pointer' : 'default' }}
                        onMouseEnter={e => clickable && (e.currentTarget.style.background = '#f9fafb')} onMouseLeave={e => (e.currentTarget.style.background = '')}>
                      <td style={{ padding: '8px' }}>
                        <span style={{ padding: '2px 8px', borderRadius: 5, fontSize: 11, fontWeight: 700, background: r.sourceType === 'sales_list' ? '#dbeafe' : '#ede9fe', color: r.sourceType === 'sales_list' ? '#1e40af' : '#5b21b6' }}>
                          {r.sourceType === 'sales_list' ? '판매' : '진행관리'}
                        </span>
                      </td>
                      <td style={{ padding: '8px' }}>{r.recordDate ?? r.saleDate ?? '-'}</td>
                      <td style={{ padding: '8px' }}>{r.companyName ?? '-'}</td>
                      <td style={{ padding: '8px' }}>{r.contactName ?? '-'}</td>
                      <td style={{ padding: '8px' }}>{r.productName ?? '-'}</td>
                      <td style={{ padding: '8px' }}>{r.translatorName ?? '-'}</td>
                      <td style={{ padding: '8px' }}>{r.language ?? '-'}</td>
                      <td style={{ padding: '8px' }}>{formatAmountDisplay(r.totalAmount ?? r.payoutPretax) || '-'}</td>
                      <td style={{ padding: '8px' }}>{r.collectionDate ?? r.payoutDate ?? r.deliveryDate ?? '-'}</td>
                      <td style={{ padding: '8px' }}>{r.collectionStatus ?? '-'}</td>
                    </tr>
                    );
                  })}
                  {rows.length === 0 && !searching && (
                    <tr><td colSpan={10} style={{ padding: '32px', textAlign: 'center', color: '#9ca3af' }} data-testid="archive-empty">
                      {searched ? '검색 결과가 없습니다.' : '과거 CRM 자료가 없습니다. [Excel 등록]에서 자료를 추가하세요.'}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
            )}
            {/* pagination */}
            {pagination.totalPages > 1 && (
              <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 14 }}>
                <button style={btn(pagination.page <= 1)} disabled={pagination.page <= 1} onClick={() => runSearch(pagination.page - 1)} aria-label="이전 페이지">이전</button>
                <span style={{ padding: '10px 14px', fontSize: 13, color: '#374151' }}>{pagination.page} / {pagination.totalPages}</span>
                <button style={btn(pagination.page >= pagination.totalPages)} disabled={pagination.page >= pagination.totalPages} onClick={() => runSearch(pagination.page + 1)} aria-label="다음 페이지">다음</button>
              </div>
            )}
          </div>
        </>
      )}

      {/* (C-4I-d) Excel 다운로드 모달 — 범위 선택 + 대상 행수 표시 + 로딩/완료 */}
      {showDownload && mode === 'search' && (
        <div role="dialog" aria-modal="true" aria-label="Excel 다운로드" data-testid="archive-download-modal"
             style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
             onClick={() => { if (!downloading) setShowDownload(false); }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 520, maxWidth: '92vw', background: '#fff', borderRadius: 12, padding: 22, boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: '#111827', marginBottom: 4 }}>Excel 다운로드</div>
            <div style={{ fontSize: 12.5, color: '#6b7280', marginBottom: 16 }}>원본 값(source_raw)을 원본 컬럼 순서 그대로 내려받습니다. 현재 페이지가 아니라 조건에 일치하는 전체 행을 출력합니다.</div>

            {/* 범위 선택 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              {([['search', '현재 검색 결과 전체', '화면의 필터·검색 조건을 그대로 반영'], ['all', '전체 자료', `현재 유형(${filters.sourceType === 'all' ? '전체' : SOURCE_LABEL[filters.sourceType as SourceType]})의 모든 유효 기록`]] as [('search' | 'all'), string, string][]).map(([v, label, desc]) => (
                <label key={v} data-testid={`archive-download-scope-${v}`}
                       style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8, cursor: downloading ? 'not-allowed' : 'pointer',
                                border: `2px solid ${downloadScope === v ? '#047857' : '#e5e7eb'}`, background: downloadScope === v ? '#ecfdf5' : '#fff' }}>
                  <input type="radio" name="download-scope" checked={downloadScope === v} disabled={downloading}
                         onChange={() => changeScope(v)} aria-label={label} style={{ marginTop: 3 }} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{label}</div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>{desc}</div>
                  </div>
                </label>
              ))}
            </div>

            {/* 대상 행수 */}
            <div style={{ padding: '12px 14px', borderRadius: 8, background: '#f9fafb', border: '1px solid #e5e7eb', marginBottom: 16 }} data-testid="archive-download-estimate">
              {estimating ? (
                <div style={{ fontSize: 13, color: '#6b7280' }}>대상 행수 계산 중…</div>
              ) : estimate ? (
                <>
                  <div style={{ fontSize: 13, color: '#374151' }}>다운로드 대상 <b style={{ color: '#047857', fontSize: 16 }}>{estimate.total.toLocaleString()}</b>행</div>
                  {estimate.types.length > 1 && (
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                      {estimate.types.map(t => `${t.label} ${t.count.toLocaleString()}행`).join(' · ')} — 유형별 시트로 분리됩니다.
                    </div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 13, color: '#9ca3af' }}>대상 행수를 불러오지 못했습니다.</div>
              )}
            </div>

            {/* 액션 */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button style={{ ...btn(downloading), background: '#fff', color: '#374151', border: '1px solid #d1d5db' }}
                      disabled={downloading} onClick={() => setShowDownload(false)} aria-label="취소" data-testid="archive-download-cancel">취소</button>
              <button style={{ ...btn(downloading || estimating || !estimate || estimate.total === 0), background: '#047857', color: '#fff' }}
                      disabled={downloading || estimating || !estimate || estimate.total === 0}
                      onClick={runDownload} aria-label="다운로드 시작" data-testid="archive-download-start">
                {downloading ? '다운로드 중…' : '다운로드'}
              </button>
            </div>
          </div>
        </div>
      )}

      {mode === 'import' && (
        <>
          <div style={box}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 10 }}>자료 유형</div>
            <div style={{ display: 'flex', gap: 10 }}>
              {(['sales_list', 'progress', 'translator_list'] as SourceType[]).map(t => (
                <div key={t} role="button" aria-label={`자료유형 ${SOURCE_LABEL[t]}`} data-testid={`source-type-${t}`}
                     style={chip(impType === t)} onClick={() => { setImpType(t); resetImport(); }}>{SOURCE_LABEL[t]}</div>
              ))}
            </div>
          </div>

          <div style={box}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 10 }}>Excel 업로드 (.xls / .xlsx)</div>

            {/* 숨겨진 file input — Drop Zone 과 연결 */}
            <input ref={fileInputRef} type="file" accept=".xls,.xlsx" style={{ display: 'none' }} tabIndex={-1} aria-hidden="true"
                   onChange={e => acceptFile(e.target.files?.[0])} data-testid="archive-file-input" />

            {/* Drop Zone: 클릭 + Drag&Drop + 키보드 */}
            <div role="button" tabIndex={0} aria-label="Excel 파일 업로드 영역 — 클릭하거나 파일을 끌어다 놓으세요 (.xls, .xlsx)"
                 data-testid="archive-dropzone" onClick={openPicker}
                 onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); } }}
                 onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
                 style={{
                   border: `2px dashed ${dragActive ? '#0ea5e9' : '#cbd5e1'}`, borderRadius: 12,
                   background: dragActive ? '#e0f2fe' : '#f8fafc', minHeight: 150, padding: 20, textAlign: 'center',
                   display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
                   cursor: 'pointer', transition: 'border-color .15s ease, background .15s ease',
                 }}>
              <div style={{ fontSize: 28 }}>📄</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: '#0369a1' }}>{dragActive ? '여기에 놓으세요' : 'Excel 파일을 여기에 끌어놓으세요'}</div>
              <div style={{ fontSize: 13, color: '#6b7280' }}>또는 클릭하여 파일을 선택할 수 있습니다</div>
              <div style={{ fontSize: 12, color: '#9ca3af' }}>.xls / .xlsx · 최대 15MB</div>
            </div>

            {/* 선택된 파일 표시 + 제거 */}
            {file && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, padding: '10px 14px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8 }} data-testid="archive-selected-file">
                <span style={{ fontSize: 18 }}>📄</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', wordBreak: 'break-all' }}>{file.name}</div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{formatSize(file.size)}</div>
                </div>
                <button onClick={removeFile} aria-label="파일 제거" data-testid="archive-remove-file"
                        style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #fca5a5', background: '#fef2f2', color: '#dc2626', fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>파일 제거</button>
              </div>
            )}

            {/* 액션 */}
            <div style={{ display: 'flex', gap: 12, marginTop: 14 }}>
              <button style={btn(!file || analyzing, true)} disabled={!file || analyzing} onClick={runAnalyze} aria-label="Preview 실행" data-testid="archive-preview-btn">{analyzing ? '분석 중…' : 'Preview'}</button>
            </div>
          </div>

          {analyze && (
            <div style={box} data-testid="archive-preview-result">
              <div style={{ fontSize: 15, fontWeight: 800, color: '#111827', marginBottom: 12 }}>Preview 결과 — {analyze.fileName}</div>
              {(() => {
                // (C-4D §7) 원본 동일행은 "제외"가 아니라 "보존 저장"된다는 의미로 표시한다.
                const p = analyze.archivePlan;
                const cards: [string, number][] = p
                  ? [['총 행', p.total], ['저장 대상', p.toSave], ['원본 동일행', p.sameContentRows], ['동일행 그룹', p.sameContentGroups], ['재업로드 제외', p.reuploadExcluded], ['경고', p.warning]]
                  : [['총 행', analyze.summary.total], ['저장 대상', analyze.summary.new], ['재업로드 제외', analyze.summary.duplicate], ['경고', analyze.summary.warning]];
                return (
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
                    {cards.map(([k, v]) => (
                      <div key={k} style={{ padding: '10px 16px', borderRadius: 8, background: '#f9fafb', border: '1px solid #e5e7eb', minWidth: 104 }}>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>{k}</div><div style={{ fontSize: 20, fontWeight: 800, color: '#111827' }}>{v}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* (C-4G §13) 등록 방식 + 현재/신규 스냅샷 안내 */}
              {analyze.snapshotContext && (() => {
                const sc = analyze.snapshotContext!;
                const dup = sc.registrationMode === 'duplicate_file';
                return (
                  <div style={{ marginBottom: 12 }} data-testid="archive-snapshot-context">
                    <div style={{ display: 'inline-block', padding: '4px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 800, marginBottom: 8,
                      background: dup ? '#fef3c7' : '#e0f2fe', color: dup ? '#92400e' : '#075985', border: `1px solid ${dup ? '#fde68a' : '#bae6fd'}` }}>
                      등록 방식: {dup ? '이미 등록된 동일 파일' : '새 CRM 스냅샷'}
                    </div>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, color: '#374151' }}>
                      {sc.currentSnapshot ? (
                        <div style={{ padding: '8px 12px', borderRadius: 8, background: '#f9fafb', border: '1px solid #e5e7eb' }}>
                          <div style={{ color: '#6b7280', fontSize: 11 }}>현재 자료(스냅샷 #{sc.currentSnapshot.snapshotId})</div>
                          <div>{sc.currentSnapshot.fileName ?? '-'} · {sc.currentSnapshot.savedRows.toLocaleString()}행 · {sc.currentSnapshot.uploadedAt ? new Date(sc.currentSnapshot.uploadedAt).toLocaleDateString() : '-'} · <span style={{ fontFamily: 'monospace' }}>{sc.currentSnapshot.fileHashShort}</span></div>
                        </div>
                      ) : (
                        <div style={{ padding: '8px 12px', borderRadius: 8, background: '#f9fafb', border: '1px solid #e5e7eb', color: '#6b7280' }}>현재 저장된 {SOURCE_LABEL[analyze.sourceType]} 스냅샷 없음(첫 등록)</div>
                      )}
                      <div style={{ padding: '8px 12px', borderRadius: 8, background: dup ? '#fffbeb' : '#eff6ff', border: `1px solid ${dup ? '#fde68a' : '#bfdbfe'}` }}>
                        <div style={{ color: '#6b7280', fontSize: 11 }}>새 자료</div>
                        <div>{sc.newFile.fileName} · {sc.newFile.totalRows.toLocaleString()}행 · <span style={{ fontFamily: 'monospace' }}>{sc.newFile.fileHashShort}</span></div>
                      </div>
                    </div>
                    {!dup && sc.currentSnapshot && (
                      <div style={{ marginTop: 8, fontSize: 12, color: '#075985' }}>저장 시 새 스냅샷이 최신으로 전환되고, 기존 스냅샷 #{sc.currentSnapshot.snapshotId}은 삭제되지 않고 이력(historical)으로 보존됩니다.</div>
                    )}
                  </div>
                );
              })()}

              {analyze.sheets.map(s => (
                <div key={s.sheetName} style={{ fontSize: 12, color: '#4b5563', marginBottom: 4 }}>
                  <b>{s.sheetName}</b> ({s.rowCount}행) — {Object.entries(s.recognizedColumns).filter(([, v]) => v).map(([f, v]) => `${f}:${v}`).join(', ') || '인식된 컬럼 없음'}
                </div>
              ))}

              {/* ── (C-4D §7·§9) 원본 동일행 안내 + 재업로드/충돌 상태 + 상세보기 ── */}
              {(() => {
                const p = analyze.archivePlan;
                const samples = analyze.duplicateSamples ?? [];
                const sameContent = p?.sameContentRows ?? analyze.duplicateAnalysis?.duplicateExcludedRows ?? 0;
                const conflicts = p?.conflicts ?? 0;
                const reupload = p?.reuploadExcluded ?? 0;
                if (sameContent === 0 && conflicts === 0 && reupload === 0) return null;
                return (
                  <div style={{ marginTop: 16, borderTop: '1px solid #e5e7eb', paddingTop: 14 }} data-testid="archive-duplicate-verify">
                    <div style={{ fontSize: 14, fontWeight: 800, color: '#111827', marginBottom: 10 }}>원본 동일행 검증</div>
                    {/* source identity 충돌이 있으면 최우선 경고(Execute 차단) */}
                    {conflicts > 0 && (
                      <div style={{ padding: '10px 14px', borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 13, fontWeight: 700, marginBottom: 10 }} data-testid="archive-identity-conflict">
                        동일 파일의 동일 위치에 다른 내용이 이미 보존되어 있습니다({conflicts}건). 원본 무결성 위험 — 저장하지 마십시오.
                      </div>
                    )}
                    {reupload > 0 && (
                      <div style={{ padding: '10px 14px', borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1e40af', fontSize: 13, fontWeight: 600, marginBottom: 10 }} data-testid="archive-reupload-note">
                        이미 보존된 원본행 {reupload}건은 동일 파일 재업로드로 판정되어 다시 저장되지 않습니다.
                      </div>
                    )}
                    {sameContent > 0 && (
                      <div style={{ padding: '10px 14px', borderRadius: 8, background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#065f46', fontSize: 13, fontWeight: 600, marginBottom: 10 }} data-testid="archive-samecontent-note">
                        원본 동일행 {sameContent}건은 Excel의 서로 다른 행이므로 <b>원본 보존을 위해 모두 저장</b>됩니다. (삭제·제외하지 않음)
                      </div>
                    )}
                    {samples.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowDupDetail(v => !v)}
                        aria-label="원본 동일행 상세보기"
                        data-testid="archive-dup-detail-toggle"
                        style={{ marginTop: 2, padding: '6px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
                      >
                        {showDupDetail ? '원본 동일행 상세 닫기' : `원본 동일행 상세보기 (대표 ${samples.length}건)`}
                      </button>
                    )}
                    {showDupDetail && samples.length > 0 && (
                      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="archive-dup-detail">
                        {samples.map((s, i) => (
                          <div key={s.rowHash + i} style={{ padding: '10px 12px', borderRadius: 8, border: `1px solid ${s.exactDuplicate ? '#e5e7eb' : '#fecaca'}`, background: s.exactDuplicate ? '#f9fafb' : '#fef2f2', fontSize: 12.5 }}>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 4 }}>
                              <span style={{ fontWeight: 800, color: s.exactDuplicate ? '#065f46' : '#991b1b' }}>
                                {s.exactDuplicate ? '원본 동일행(보존)' : (s.classification === 'SOURCE_RAW_DIFFERENT' ? '원본값 상이' : '원본행 상이')}
                              </span>
                              <span style={{ color: '#6b7280' }}>[{s.sourceSheet}] Excel행 {s.excelRows.join(', ')} · {s.groupCount}건</span>
                            </div>
                            <div style={{ color: '#374151' }}>
                              {[s.companyName, s.contactName, s.productName, s.translatorName, s.language].filter(Boolean).join(' / ') || '(표시 필드 없음)'}
                              {(s.deliveryDate || s.payoutDate || s.payoutPretax != null) && (
                                <span style={{ color: '#6b7280' }}> · 납품 {s.deliveryDate ?? '-'} / 지급 {s.payoutDate ?? '-'} / 지급액 {s.payoutPretax ?? '-'}</span>
                              )}
                            </div>
                            {s.differences.length > 0 && (
                              <div style={{ marginTop: 6, color: '#991b1b', fontSize: 12 }}>
                                {s.differences.map((d, di) => (
                                  <div key={di}>· <b>{d.column}</b> (행 {d.excelRowA} vs {d.excelRowB}, {d.kind}): {JSON.stringify(d.valueA)} ↔ {JSON.stringify(d.valueB)}</div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ── (C-4E) Excel 원본 미리보기 — 원본 header + rawRow 전체 컬럼, pagination, 가로 스크롤 ── */}
              {excelPreview && (() => {
                const ep = excelPreview;
                const totalPages = Math.max(1, Math.ceil(ep.totalRows / ep.pageSize));
                const startNo = ep.totalRows === 0 ? 0 : (ep.page - 1) * ep.pageSize + 1;
                const endNo = (ep.page - 1) * ep.pageSize + ep.rows.length;
                const cell = (v: unknown) => v === null || v === undefined
                  ? <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>(null)</span>
                  : v === ''
                    ? <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>(빈 값)</span>
                    : <span style={{ whiteSpace: 'pre' }}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>;
                const th: React.CSSProperties = { position: 'sticky', top: 0, background: '#f3f4f6', borderBottom: '2px solid #d1d5db', padding: '7px 10px', textAlign: 'left', fontWeight: 800, fontSize: 12, color: '#374151', whiteSpace: 'nowrap' };
                const td: React.CSSProperties = { borderBottom: '1px solid #f0f0f0', padding: '6px 10px', fontSize: 12.5, color: '#111827', whiteSpace: 'nowrap', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' };
                return (
                  <div style={{ marginTop: 18, borderTop: '2px solid #e5e7eb', paddingTop: 14 }} data-testid="archive-excel-preview">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color: '#111827' }}>
                        Excel 원본 미리보기 <span style={{ color: '#6b7280', fontWeight: 600 }}>— 총 {ep.totalRows.toLocaleString()}행{ep.sheetCount > 1 ? ` · ${ep.sheetCount}개 시트` : ''}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151' }}>
                        <span>{startNo.toLocaleString()}–{endNo.toLocaleString()} / {ep.totalRows.toLocaleString()}</span>
                        <button type="button" aria-label="이전 페이지" data-testid="excel-prev"
                          disabled={ep.page <= 1 || excelLoading} onClick={() => fetchExcelPage(ep.page - 1, ep.pageSize)}
                          style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontWeight: 700, fontSize: 13, cursor: ep.page <= 1 || excelLoading ? 'not-allowed' : 'pointer', opacity: ep.page <= 1 || excelLoading ? 0.5 : 1 }}>← 이전</button>
                        <span style={{ fontWeight: 700 }} data-testid="excel-page-indicator">{ep.page} / {totalPages}</span>
                        <button type="button" aria-label="다음 페이지" data-testid="excel-next"
                          disabled={ep.page >= totalPages || excelLoading} onClick={() => fetchExcelPage(ep.page + 1, ep.pageSize)}
                          style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontWeight: 700, fontSize: 13, cursor: ep.page >= totalPages || excelLoading ? 'not-allowed' : 'pointer', opacity: ep.page >= totalPages || excelLoading ? 0.5 : 1 }}>다음 →</button>
                        <select aria-label="페이지당 행수" data-testid="excel-pagesize" value={ep.pageSize} disabled={excelLoading}
                          onChange={e => fetchExcelPage(1, Number(e.target.value))}
                          style={{ padding: '5px 8px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff' }}>
                          {[50, 100, 200].map(n => <option key={n} value={n}>{n}행</option>)}
                        </select>
                      </div>
                    </div>
                    <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, maxHeight: 520, overflowY: 'auto' }} data-testid="archive-excel-preview-scroll">
                      <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
                        <thead>
                          <tr>
                            <th style={{ ...th, left: 0, zIndex: 2, background: '#eef2ff' }}>Excel 행</th>
                            {ep.sheetCount > 1 && <th style={th}>시트</th>}
                            {ep.headers.map((h, i) => <th key={i} style={th}>{h && h.trim() !== '' ? h : <span style={{ color: '#9ca3af' }}>(열 {i + 1})</span>}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {ep.rows.map((r, ri) => (
                            <tr key={r.sourceRow + '_' + ri} style={{ background: ri % 2 ? '#fafafa' : '#fff' }}>
                              <td style={{ ...td, position: 'sticky', left: 0, background: ri % 2 ? '#fafafa' : '#fff', fontWeight: 700, color: '#4338ca', zIndex: 1 }}>{r.sourceRow}</td>
                              {ep.sheetCount > 1 && <td style={td}>{r.sourceSheet}</td>}
                              {ep.headers.map((_, ci) => <td key={ci} style={td} title={r.values[ci] == null ? '' : String(r.values[ci])}>{cell(r.values[ci])}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ marginTop: 6, fontSize: 11.5, color: '#9ca3af' }}>원본 Excel 값을 변환 없이 표시합니다(trim/날짜·숫자 재해석 없음). (null)=빈 셀, (빈 값)=빈 문자열.</div>
                  </div>
                );
              })()}

              {/* ── (C-4H-2) 데이터 식별자 진단 (READ-ONLY, Execute 무관) ── */}
              {analyze.identityAnalysis?.analyzed && (() => {
                const ia = analyze.identityAnalysis!;
                const c = ia.conclusion;
                const idA = ia.identicalRowAnalysis;
                const clsColor = (k: string) => k === 'UNIQUE' ? '#065f46' : k === 'NEAR_UNIQUE' ? '#0369a1' : k === 'NON_UNIQUE' ? '#92400e' : '#991b1b';
                return (
                  <div style={{ marginTop: 18, borderTop: '2px solid #e5e7eb', paddingTop: 14 }} data-testid="archive-identity-diagnostic">
                    <button type="button" onClick={() => setShowIdentity(v => !v)} aria-label="데이터 식별자 진단" data-testid="archive-identity-toggle"
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontWeight: 800, fontSize: 14, color: '#111827' }}>
                      {showIdentity ? '▾' : '▸'} 데이터 식별자 진단
                      <span style={{ fontWeight: 700, fontSize: 12.5, padding: '2px 10px', borderRadius: 999,
                        background: c.stableRowIdFound ? '#ecfdf5' : '#fef2f2', color: c.stableRowIdFound ? '#065f46' : '#991b1b', border: `1px solid ${c.stableRowIdFound ? '#a7f3d0' : '#fecaca'}` }}>
                        {c.stableRowIdFound ? `안정 ID 후보 발견 (${c.confidence})` : '안정 per-row ID 미확인'}
                      </span>
                    </button>
                    {showIdentity && (
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 12.5, color: '#374151', marginBottom: 10 }}>
                          분석 시트 <b>{ia.analyzedSheet}</b> · 전체 {ia.totalRows.toLocaleString()}행 · {ia.totalColumns}컬럼 · ID 후보 {ia.candidateColumns.length}개
                          <div style={{ marginTop: 4, color: c.stableRowIdFound ? '#065f46' : '#991b1b' }}>결론: {c.reason}{c.recommendedIdentity ? ` → 권장: ${c.recommendedIdentity}` : ''}</div>
                        </div>

                        {/* ID 후보 */}
                        <div style={{ fontSize: 13, fontWeight: 800, margin: '8px 0 4px' }}>ID 후보 컬럼</div>
                        <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 12 }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <thead><tr style={{ background: '#f3f4f6', textAlign: 'left' }}>
                              {['컬럼', '값 존재율', '고유값', '중복', '고유율', '판정', '예시'].map(h => <th key={h} style={{ padding: '6px 10px', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>)}
                            </tr></thead>
                            <tbody>
                              {ia.candidateColumns.length === 0 && <tr><td colSpan={7} style={{ padding: 12, color: '#9ca3af' }}>ID/번호/코드/순번 성격 컬럼이 없습니다.</td></tr>}
                              {ia.candidateColumns.map((c2, i) => (
                                <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                                  <td style={{ padding: '6px 10px', fontWeight: 700, whiteSpace: 'nowrap' }}>{c2.originalHeader}{c2.isMutable && <span style={{ color: '#991b1b', fontSize: 11 }}> (mutable)</span>}</td>
                                  <td style={{ padding: '6px 10px' }}>{((c2.nonNullCount / Math.max(1, ia.totalRows)) * 100).toFixed(1)}%</td>
                                  <td style={{ padding: '6px 10px' }}>{c2.distinctCount.toLocaleString()}</td>
                                  <td style={{ padding: '6px 10px' }}>{c2.duplicateValueCount.toLocaleString()}</td>
                                  <td style={{ padding: '6px 10px' }}>{(c2.uniquenessRatio * 100).toFixed(1)}%</td>
                                  <td style={{ padding: '6px 10px', fontWeight: 800, color: clsColor(c2.classification) }}>{c2.classification}</td>
                                  <td style={{ padding: '6px 10px', color: '#6b7280', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c2.sampleValues.slice(0, 5).join(', ')}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {/* Composite */}
                        {ia.compositeCandidates.length > 0 && (
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4 }}>복합 ID 후보 (ID 성격 컬럼 조합)</div>
                            {ia.compositeCandidates.slice(0, 5).map((cc, i) => (
                              <div key={i} style={{ fontSize: 12.5, color: '#374151' }}>· <b>{cc.columns.join(' + ')}</b> — 고유율 {(cc.uniquenessRatio * 100).toFixed(1)}% / coverage {(cc.coverage * 100).toFixed(1)}% <span style={{ fontWeight: 800, color: clsColor(cc.classification) }}>{cc.classification}</span></div>
                            ))}
                          </div>
                        )}

                        {/* 1:N 관계 */}
                        {ia.relationAnalysis.available && (
                          <div style={{ marginBottom: 12, fontSize: 12.5, color: '#374151' }}>
                            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4 }}>판매 1:N 수행 구조</div>
                            판매키 <b>{ia.relationAnalysis.saleColumn}</b>{ia.relationAnalysis.assignmentColumn ? ` · 배정키 ${ia.relationAnalysis.assignmentColumn}` : ''} · 판매 {ia.relationAnalysis.totalSales?.toLocaleString()}건 · 다건판매 {ia.relationAnalysis.multiRowSales?.toLocaleString()} · 최대 {ia.relationAnalysis.maxRowsPerSale}행/판매
                          </div>
                        )}

                        {/* 153 동일행 ID 분석 */}
                        <div style={{ fontSize: 13, fontWeight: 800, margin: '8px 0 4px' }}>원본 동일행 ID 분석</div>
                        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
                          {([['원본 동일행(행)', idA.identicalRows], ['동일 그룹', idA.identicalGroups], ['ID로 구분 가능', idA.distinguishableByIdRows], ['ID 동일', idA.sameIdRows], ['ID 없음', idA.missingIdRows], ['전컬럼 완전동일', idA.fullRowIdenticalRows]] as [string, number][]).map(([k, v]) => (
                            <div key={k} style={{ padding: '6px 12px', borderRadius: 8, background: '#f9fafb', border: '1px solid #e5e7eb', minWidth: 92 }}>
                              <div style={{ fontSize: 11, color: '#6b7280' }}>{k}</div><div style={{ fontSize: 16, fontWeight: 800 }}>{v.toLocaleString()}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>비교 기준 ID: {idA.idColumnUsed ?? '(없음)'}</div>

                        {/* 대표 사례 */}
                        {ia.representativeSamples.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="archive-identity-samples">
                            {ia.representativeSamples.map((s, i) => (
                              <div key={i} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', fontSize: 12 }}>
                                <div style={{ fontWeight: 700 }}>{[s.companyName, s.productName].filter(Boolean).join(' / ') || '(표시없음)'} · {s.groupCount}행 · <span style={{ color: s.classification.includes('DIFFERENT') ? '#065f46' : s.classification.includes('SAME') ? '#92400e' : '#991b1b' }}>{s.classification}</span></div>
                                {s.members.map((m, mi) => (
                                  <div key={mi} style={{ color: '#374151', fontFamily: 'monospace', fontSize: 11.5 }}>Excel행 {m.sourceRow}: {Object.entries(m.idValues).map(([k, v]) => `${k}=${v ?? '∅'}`).join(' · ') || '(ID 후보 없음)'}</div>
                                ))}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}

            </div>
          )}

          {/* 반복 업로드: 변경분 미리보기 · 대표 승인 반영 · 배치 되돌리기(5분류, 중복 의심 보류, 삭제 의심 표시만) */}
          <LegacyArchiveSyncPanel token={token} file={file} sourceType={impType} setToast={setToast} onApplied={loadSnapshots} />
        </>
      )}
    </div>
  );
}
