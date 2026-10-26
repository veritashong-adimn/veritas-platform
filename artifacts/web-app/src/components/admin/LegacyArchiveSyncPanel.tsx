// 과거 CRM 반복 업로드 — 변경분 미리보기 · 대표 승인 반영 · 배치 되돌리기 패널
//   신규 / 수정 / 변경 없음 / 중복 의심 / 삭제·취소 의심 5분류와 수정 전후 값을 보여주고,
//   대표(관리자)가 확인·승인한 경우에만 반영한다. 중복 의심은 건별 승인한 행만 저장, 삭제 의심은 보고만.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/constants';
import { formatAmountDisplay } from '../../lib/utils';

type SourceType = 'sales_list' | 'progress' | 'translator_list';
type Cls = 'CHANGES' | 'NEW' | 'UPDATED' | 'SAME' | 'AMBIGUOUS' | 'DELETION_SUSPECT';
type View = { sourceSheet: string; sourceRow: number; saleNo: string | null; saleDate: string | null; companyName: string | null; contactName: string | null; productName: string | null; translatorName: string | null; language: string | null; totalAmount: number | string | null; payoutPretax: number | string | null; deliveryDate: string | null; payoutDate: string | null; collectionStatus: string | null };
type ChangedField = { field: string; before: unknown; after: unknown };
type MasterInfo = { status: 'mapped' | 'unmapped' | 'no_name'; masterIds: number[] };
type PageRow = {
  key?: string; classification?: Exclude<Cls, 'CHANGES' | 'DELETION_SUSPECT'>; matchBasis?: string; reason?: string; candidateCount?: number;
  matchedExistingId?: number | null; alreadyStored?: boolean; incoming?: View; before?: View | null; changedFields?: ChangedField[];
  rawChanges?: { column: string; before: string | null; after: string | null }[];
  impact?: { links: number; linkReview: boolean; master?: { before: MasterInfo | null; after: MasterInfo; change: string } } | null;
  existingId?: number;
} & Partial<View>;
type Summary = {
  planToken: string; total: number; alreadyStored: number; conflicts: number; safeToExecute: boolean; scope: 'range' | 'full';
  comparedWith?: { sourceType: SourceType; label: string; effectiveRows: number; detectedFileType: SourceType | null };
  counts: Record<'NEW' | 'UPDATED' | 'SAME' | 'AMBIGUOUS' | 'DELETION_SUSPECT', number>;
  saleNoValidation: { applicable: boolean; usable: boolean; reason: string; total: number; withSaleNo: number; duplicateInFileKeys: number; duplicateInExistingKeys: number; inconsistentMatches: number };
  deletionScope: { mode: string; from: string | null; to: string | null; outOfScope: number; undated: number };
  impact: { updatedWithLinks: number; linksToCarry: number; linkReview: number; masterLost: number; masterMoved: number; newUnmappedNames: number; deletionSuspectWithLinks: number;
    newSaleLink?: { link: number; linkRows: number; hold: number; none: number } };
  changeSummary?: { topColumns: [string, number][]; columnOnlyToSame: number; headerDiff: { added: string[]; removed: string[] } };
};
type Batch = { id: number; originalFilename: string | null; totalRows: number; successRows: number; isCurrent: boolean | null; status: string; createdAt: string };

const CLS_META: Record<Cls, { label: string; color: string; bg: string }> = {
  CHANGES: { label: '변경 전체', color: '#111827', bg: '#f3f4f6' },
  NEW: { label: '신규', color: '#1e40af', bg: '#eff6ff' },
  UPDATED: { label: '수정', color: '#92400e', bg: '#fffbeb' },
  SAME: { label: '변경 없음', color: '#065f46', bg: '#ecfdf5' },
  AMBIGUOUS: { label: '중복 의심', color: '#991b1b', bg: '#fef2f2' },
  DELETION_SUSPECT: { label: '삭제·취소 의심', color: '#6b21a8', bg: '#faf5ff' },
};
const FIELD_LABEL: Record<string, string> = {
  companyName: '거래처', contactName: '담당자', productName: '상품', language: '언어', recordDate: '체결일', translatorName: '통번역사',
  deliveryDate: '납품일', payoutDate: '지급일', payoutPretax: '지급액(세전)', collectionDate: '입금일', collectionStatus: '입금상태',
  supplyAmount: '공급가액', vatAmount: '부가세', totalAmount: '총액',
};
const AMOUNT_FIELDS = new Set(['payoutPretax', 'supplyAmount', 'vatAmount', 'totalAmount']);
const fmt = (f: string, v: unknown) => (v == null || v === '' ? '(없음)' : AMOUNT_FIELDS.has(f) ? formatAmountDisplay(v as any) : String(v));

export function LegacyArchiveSyncPanel({ token, file, sourceType, setToast, onApplied }: {
  token: string; file: File | null; sourceType: SourceType; setToast: (m: string) => void; onApplied?: () => void;
}) {
  const authHeaders = { Authorization: `Bearer ${token}` };
  const [scope, setScope] = useState<'range' | 'full'>('range');
  const [cls, setCls] = useState<Cls>('CHANGES');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [rows, setRows] = useState<PageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [approvedAmb, setApprovedAmb] = useState<Set<string>>(new Set());
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [rbPlan, setRbPlan] = useState<any>(null);
  const [rbBusy, setRbBusy] = useState(false);

  // 파일·유형·범위가 바뀌면 이전 판정·승인 무효화
  useEffect(() => { setSummary(null); setPreviewId(null); setRows([]); setApprovedAmb(new Set()); setConfirmChecked(false); setResult(null); }, [file, sourceType, scope]);

  const load = useCallback(async (nextCls: Cls, nextPage: number, nextSize: number, reset: boolean) => {
    if (!file) { setToast('엑셀 파일을 선택하세요.'); return; }
    setLoading(true);
    try {
      // 페이지·분류 이동은 서버 캐시(previewId)에서 조회 — 파일 재전송·재파싱 없음. 만료(410) 시 전체 재분석.
      let res: Response | null = null;
      if (!reset && previewId) {
        res = await fetch(api('/api/admin/legacy-archive/sync-preview/page'), {
          method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ previewId, cls: nextCls, page: nextPage, pageSize: nextSize }),
        });
        if (res.status === 410) res = null;
      }
      if (!res) {
        const fd = new FormData();
        fd.append('file', file); fd.append('sourceType', sourceType); fd.append('scope', scope);
        fd.append('cls', nextCls); fd.append('page', String(nextPage)); fd.append('pageSize', String(nextSize));
        res = await fetch(api('/api/admin/legacy-archive/sync-preview'), { method: 'POST', headers: authHeaders, body: fd });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '변경분 미리보기 실패');
      if (data.previewId) { setPreviewId(data.previewId); setElapsedMs(data.elapsedMs ?? null); }
      if (reset || (summary && summary.planToken !== data.summary.planToken)) { setApprovedAmb(new Set()); setConfirmChecked(false); }
      setSummary(data.summary); setRows(data.page.rows); setTotal(data.page.total);
      setCls(nextCls); setPage(data.page.page); setPageSize(data.page.pageSize);
    } catch (e: any) { setToast(e?.message || '변경분 미리보기 실패'); } finally { setLoading(false); }
  }, [file, sourceType, scope, token, summary, previewId]); // eslint-disable-line

  const loadBatches = useCallback(async () => {
    try {
      const res = await fetch(api(`/api/admin/legacy-archive-snapshots?sourceType=${sourceType}`), { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '업로드 이력 조회 실패');
      setBatches((data.snapshots ?? []).slice(0, 10));
    } catch (e: any) { setToast(e?.message || '업로드 이력 조회 실패'); }
  }, [sourceType, token]); // eslint-disable-line
  useEffect(() => { loadBatches(); }, [loadBatches]);

  const apply = useCallback(async () => {
    if (!file || !summary) return;
    setApplying(true);
    try {
      const fd = new FormData();
      fd.append('file', file); fd.append('sourceType', sourceType); fd.append('scope', scope);
      fd.append('approve', 'true'); fd.append('planToken', summary.planToken); fd.append('approvedAmbiguous', JSON.stringify([...approvedAmb]));
      const res = await fetch(api('/api/admin/legacy-archive/execute'), { method: 'POST', headers: authHeaders, body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '반영 실패');
      setResult(data); setConfirmChecked(false);
      setToast(data.mode === 'no_change' ? '반영할 변경이 없습니다. 아무것도 저장하지 않았습니다.' : `반영 완료(배치 #${data.batchId}): 신규 ${data.applied.created + data.applied.approvedNew} · 수정 ${data.applied.updated + data.applied.approvedUpdate}`);
      setSummary(null); setPreviewId(null); setRows([]); setApprovedAmb(new Set());
      loadBatches(); onApplied?.();
    } catch (e: any) { setToast(e?.message || '반영 실패'); } finally { setApplying(false); }
  }, [file, summary, sourceType, scope, approvedAmb, token, loadBatches, onApplied]); // eslint-disable-line

  const previewRollback = async (id: number) => {
    setRbBusy(true);
    try {
      const res = await fetch(api(`/api/admin/legacy-archive/batches/${id}/rollback-preview`), { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '되돌리기 미리보기 실패');
      setRbPlan(data);
    } catch (e: any) { setToast(e?.message || '되돌리기 미리보기 실패'); } finally { setRbBusy(false); }
  };
  const runRollback = async () => {
    if (!rbPlan?.ok) return;
    setRbBusy(true);
    try {
      const res = await fetch(api(`/api/admin/legacy-archive/batches/${rbPlan.batchId}/rollback`), { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '되돌리기 실패');
      setToast(`배치 #${rbPlan.batchId} 되돌리기 완료: 이전 버전 ${data.restored}건 복원 · 변경행 ${data.deactivated}건 비유효 처리 · 보존 ${data.preservedLater}건`);
      setRbPlan(null); loadBatches(); onApplied?.();
    } catch (e: any) { setToast(e?.message || '되돌리기 실패'); } finally { setRbBusy(false); }
  };

  const box: React.CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, background: '#fff', marginTop: 14 };
  const btn = (disabled: boolean, color = '#111827'): React.CSSProperties => ({ padding: '9px 16px', borderRadius: 8, fontWeight: 700, fontSize: 13, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, background: color, color: '#fff' });
  const td: React.CSSProperties = { padding: '6px 8px', borderTop: '1px solid #f3f4f6', verticalAlign: 'top' };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const willApply = summary ? summary.counts.NEW + summary.counts.UPDATED + approvedAmb.size : 0;
  const canApply = !!summary && summary.safeToExecute && confirmChecked && !applying && willApply > 0;

  return (
    <div style={box} data-testid="archive-sync-panel">
      <div style={{ fontSize: 15, fontWeight: 800, color: '#111827' }}>변경분 미리보기 · 대표 승인 반영</div>
      <div style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 10px' }}>
        기존 자료와 비교해 신규·수정만 반영합니다. 중복 의심은 승인한 건만 저장하고, 삭제·취소 의심은 표시만 합니다(자동 삭제 없음). 같은 파일을 다시 올려도 중복 생성되지 않습니다.
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>삭제·취소 의심 판정 범위</span>
        {([['range', '업로드 파일 기간만(일부 기간 파일)'], ['full', '전체 기간 파일']] as const).map(([v, label]) => (
          <label key={v} style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="radio" name="sync-scope" checked={scope === v} onChange={() => setScope(v)} data-testid={`sync-scope-${v}`} aria-label={label} />{label}
          </label>
        ))}
        <button style={btn(!file || loading, '#0ea5e9')} disabled={!file || loading} onClick={() => load('CHANGES', 1, pageSize, true)} data-testid="sync-preview-btn" aria-label="변경분 미리보기 실행">
          {loading ? '분석 중…' : '변경분 미리보기'}
        </button>
      </div>

      {summary && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
            {(['CHANGES', 'NEW', 'UPDATED', 'SAME', 'AMBIGUOUS', 'DELETION_SUSPECT'] as Cls[]).map(c => {
              const n = c === 'CHANGES' ? summary.counts.NEW + summary.counts.UPDATED + summary.counts.AMBIGUOUS : summary.counts[c];
              const m = CLS_META[c];
              return (
                <button key={c} onClick={() => load(c, 1, pageSize, false)} data-testid={`sync-cls-${c}`} aria-label={`${m.label} ${n}건 보기`}
                  style={{ padding: '8px 14px', borderRadius: 8, minWidth: 104, textAlign: 'left', cursor: 'pointer', background: m.bg, border: cls === c ? `2px solid ${m.color}` : '1px solid #e5e7eb' }}>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{m.label}</div>
                  <div style={{ fontSize: 19, fontWeight: 800, color: m.color }}>{n.toLocaleString()}</div>
                </button>
              );
            })}
          </div>
          {summary.comparedWith && (
            <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe', fontSize: 13 }} data-testid="sync-compared-with">
              비교 대상: <b>기존 {summary.comparedWith.label} 유효 {summary.comparedWith.effectiveRows.toLocaleString()}행</b> ↔ 업로드 파일 {summary.total.toLocaleString()}행
              {summary.comparedWith.detectedFileType ? ` · 파일 유형 감지: ${summary.comparedWith.detectedFileType === summary.comparedWith.sourceType ? '일치' : '불일치'}` : ' · 파일 유형 자동 감지 불가(열 구성 확인 필요)'}
            </div>
          )}
          <div style={{ fontSize: 12, color: '#374151', marginTop: 8, lineHeight: 1.7 }} data-testid="sync-summary-notes">
            <div>총 {summary.total.toLocaleString()}행{elapsedMs != null && ` · 분석 ${(elapsedMs / 1000).toFixed(1)}초`}{summary.alreadyStored > 0 && ` · 이 파일로 이미 저장된 행 ${summary.alreadyStored.toLocaleString()}건(재저장 안 함)`}{summary.conflicts > 0 && <b style={{ color: '#dc2626' }}> · 원본 위치 충돌 {summary.conflicts}건(반영 불가)</b>}</div>
            {summary.saleNoValidation.applicable && (
              <div>판매번호 검증: <b style={{ color: summary.saleNoValidation.usable ? '#065f46' : '#b45309' }}>{summary.saleNoValidation.usable ? '통과' : '미통과'}</b> — {summary.saleNoValidation.reason}
                {' '}(보유 {summary.saleNoValidation.withSaleNo}/{summary.saleNoValidation.total}, 파일 내 중복 번호 {summary.saleNoValidation.duplicateInFileKeys}, 기존 중복 번호 {summary.saleNoValidation.duplicateInExistingKeys}, 번호 재사용 의심 {summary.saleNoValidation.inconsistentMatches})</div>
            )}
            <div>삭제·취소 의심 범위: {summary.deletionScope.mode === 'full' ? '전체 기간' : `${summary.deletionScope.from ?? '-'} ~ ${summary.deletionScope.to ?? '-'}`}
              {summary.deletionScope.mode === 'range' && ` (범위 밖 ${summary.deletionScope.outOfScope.toLocaleString()}건·날짜 없음 ${summary.deletionScope.undated.toLocaleString()}건은 판정 제외)`}</div>
            <div>연결 영향: 수정 건 중 판매·진행 연결 보유 {summary.impact.updatedWithLinks}건(연결 {summary.impact.linksToCarry}개 새 버전으로 이관, 재검토 {summary.impact.linkReview}건)
              {sourceType === 'progress' && ` · 수행이력 Master 연결 끊김 ${summary.impact.masterLost}건 · Master 변경 ${summary.impact.masterMoved}건 · 미연결 통번역사명 ${summary.impact.newUnmappedNames}명`}
              {summary.impact.deletionSuspectWithLinks > 0 && ` · 연결 있는 삭제 의심 ${summary.impact.deletionSuspectWithLinks}건`}</div>
            {summary.impact.newSaleLink && <div data-testid="sync-new-sale-link">신규 판매건 진행관리표 연결(기존 연결 규칙): 연결 {summary.impact.newSaleLink.link}건(진행 행 {summary.impact.newSaleLink.linkRows}) · 불확실 보류 {summary.impact.newSaleLink.hold}건 · 대응 진행 행 없음 {summary.impact.newSaleLink.none}건</div>}
          </div>
          {summary.changeSummary && (
            <div style={{ fontSize: 12, marginTop: 6 }} data-testid="sync-change-summary">
              {(summary.changeSummary.headerDiff.added.length > 0 || summary.changeSummary.headerDiff.removed.length > 0) && (
                <div style={{ padding: '6px 10px', borderRadius: 6, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', marginBottom: 6 }}>
                  열 구성 변경 감지 — 추가: {summary.changeSummary.headerDiff.added.join(', ') || '없음'} / 삭제: {summary.changeSummary.headerDiff.removed.join(', ') || '없음'}. 공통 열만 비교하며, 열 구성 차이만 있는 {summary.changeSummary.columnOnlyToSame.toLocaleString()}행은 '변경 없음'으로 처리합니다.
                </div>
              )}
              {summary.changeSummary.topColumns.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ color: '#6b7280' }}>주요 변경 항목:</span>
                  {summary.changeSummary.topColumns.map(([c, n]) => <span key={c} style={{ padding: '2px 8px', borderRadius: 999, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e' }}>{c.replace('[정규화] ', '')} {n.toLocaleString()}</span>)}
                </div>
              )}
            </div>
          )}

          <div style={{ overflowX: 'auto', marginTop: 10, border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }} data-testid="sync-rows-table">
              <thead><tr style={{ background: '#f9fafb', textAlign: 'left' }}>
                {['분류', 'Excel행', '판매번호/날짜', '거래처 · 상품 · 통번역사', '수정 전 → 후', '연결 영향', '사유', cls === 'AMBIGUOUS' || cls === 'CHANGES' ? '승인' : ''].map((h, i) => <th key={i} style={{ padding: '7px 8px', fontWeight: 700 }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: '#9ca3af', padding: 18 }}>해당 분류 자료가 없습니다.</td></tr>}
                {rows.map((r, i) => {
                  const v: Partial<View> = r.incoming ?? r;
                  const c: Cls = r.classification ?? 'DELETION_SUSPECT';
                  const m = CLS_META[c];
                  const imp = r.impact;
                  return (
                    <tr key={r.key ?? `e${r.existingId}-${i}`} data-testid={`sync-row-${r.key ?? `existing-${r.existingId}`}`}>
                      <td style={td}><span style={{ padding: '2px 8px', borderRadius: 999, background: m.bg, color: m.color, fontWeight: 700, whiteSpace: 'nowrap' }}>{m.label}</span>{r.alreadyStored && <div style={{ color: '#9ca3af', fontSize: 11 }}>이미 저장됨</div>}</td>
                      <td style={td}>{r.existingId != null ? `기존 #${r.existingId}` : `${v.sourceSheet ?? ''} ${v.sourceRow ?? ''}`}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{v.saleNo ?? '-'}<div style={{ color: '#6b7280' }}>{v.saleDate ?? ''}</div></td>
                      <td style={td}>{[v.companyName, v.productName, v.translatorName].filter(Boolean).join(' · ') || '(표시 없음)'}{v.totalAmount != null && <div style={{ color: '#6b7280' }}>총액 {formatAmountDisplay(v.totalAmount as any)}</div>}</td>
                      <td style={td}>
                        {(r.changedFields ?? []).length === 0 && (r.rawChanges ?? []).length === 0 ? <span style={{ color: '#9ca3af' }}>-</span> : (r.changedFields ?? []).map((cf, ci) => (
                          <div key={ci}><b>{FIELD_LABEL[cf.field] ?? cf.field}</b>: <span style={{ color: '#9ca3af' }}>{fmt(cf.field, cf.before)}</span> → <span style={{ color: '#065f46', fontWeight: 700 }}>{fmt(cf.field, cf.after)}</span></div>
                        ))}
                        {(r.rawChanges ?? []).filter(rc => !(r.changedFields ?? []).length || !['총액', '공급가액', '부가세', '지급액(세전)', '통번역사납품일', '통번역사지급일', '거래처명', '상품명', '통번역사명', '입금일'].includes(rc.column)).slice(0, 8).map((rc, ri) => (
                          <div key={`r${ri}`} style={{ color: '#374151' }}><b>{rc.column}</b>: <span style={{ color: '#9ca3af' }}>{rc.before ?? '(없음)'}</span> → <span style={{ color: '#065f46', fontWeight: 700 }}>{rc.after ?? '(없음)'}</span></div>
                        ))}
                      </td>
                      <td style={td}>
                        {imp ? <>
                          {imp.links > 0 && <div style={{ color: imp.linkReview ? '#b45309' : '#374151' }}>판매·진행 연결 {imp.links}개{imp.linkReview ? ' · 재검토' : ' · 이관'}</div>}
                          {imp.master && imp.master.change === 'lost' && <div style={{ color: '#dc2626' }}>수행이력 Master 연결 끊김</div>}
                          {imp.master && imp.master.change === 'moved' && <div style={{ color: '#b45309' }}>Master 변경 #{imp.master.before?.masterIds.join(',')} → #{imp.master.after.masterIds.join(',')}</div>}
                          {imp.master && imp.master.after.status === 'unmapped' && imp.master.change !== 'lost' && <div style={{ color: '#6b7280' }}>Master 미연결 이름</div>}
                          {imp.master && imp.master.after.status === 'mapped' && imp.master.change !== 'moved' && <div style={{ color: '#065f46' }}>Master #{imp.master.after.masterIds.join(',')}</div>}
                        </> : '-'}
                      </td>
                      <td style={{ ...td, color: '#4b5563' }}>{r.reason ?? (c === 'DELETION_SUSPECT' ? '기존 자료가 이번 파일에 없음 — 삭제·취소 여부 확인(자동 삭제 안 함)' : '')}</td>
                      <td style={td}>{c === 'AMBIGUOUS' && r.key && !r.alreadyStored && (() => {
                        // 판매번호 1:1 대응(번호 재사용 의심) → 기존 건 '수정'으로 승인, 그 외 → '신규'로 승인
                        const asUpdate = r.matchBasis === 'sale_no' && r.matchedExistingId != null;
                        const label = asUpdate ? `기존 #${r.matchedExistingId} 수정으로` : '신규로';
                        return (
                          <label style={{ display: 'flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap', cursor: 'pointer' }}>
                            <input type="checkbox" checked={approvedAmb.has(r.key!)} data-testid={`sync-approve-${r.key}`} aria-label={`Excel행 ${v.sourceRow} ${label} 반영 승인`}
                              onChange={e => setApprovedAmb(prev => { const n = new Set(prev); if (e.target.checked) n.add(r.key!); else n.delete(r.key!); return n; })} />{label}
                          </label>
                        );
                      })()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 12 }}>
            <button style={btn(page <= 1 || loading, '#6b7280')} disabled={page <= 1 || loading} onClick={() => load(cls, page - 1, pageSize, false)} data-testid="sync-page-prev" aria-label="이전 페이지">이전</button>
            <span>{page} / {totalPages} 페이지 · {total.toLocaleString()}건</span>
            <button style={btn(page >= totalPages || loading, '#6b7280')} disabled={page >= totalPages || loading} onClick={() => load(cls, page + 1, pageSize, false)} data-testid="sync-page-next" aria-label="다음 페이지">다음</button>
            <select value={pageSize} onChange={e => load(cls, 1, Number(e.target.value), false)} data-testid="sync-page-size" aria-label="페이지당 행 수" style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #d1d5db' }}>
              {[20, 50, 100].map(n => <option key={n} value={n}>{n}행</option>)}
            </select>
          </div>

          <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: '#fff7ed', border: '1px solid #fed7aa' }} data-testid="sync-approval-box">
            <div style={{ fontSize: 13, fontWeight: 800, color: '#9a3412', marginBottom: 6 }}>대표 승인</div>
            <div style={{ fontSize: 12.5, color: '#374151', marginBottom: 8 }}>
              반영: 신규 {summary.counts.NEW.toLocaleString()}건 · 수정 {summary.counts.UPDATED.toLocaleString()}건 · 중복 의심 승인 {approvedAmb.size}건
              {' '}/ 반영 안 함: 중복 의심 보류 {(summary.counts.AMBIGUOUS - approvedAmb.size).toLocaleString()}건 · 삭제·취소 의심 {summary.counts.DELETION_SUSPECT.toLocaleString()}건(표시만) · 변경 없음 {summary.counts.SAME.toLocaleString()}건
            </div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={confirmChecked} onChange={e => setConfirmChecked(e.target.checked)} data-testid="sync-confirm-check" aria-label="변경 내용을 확인했으며 반영을 승인합니다" />
              변경 내용을 확인했으며 반영을 승인합니다(관리자 권한 필요, 되돌리기 가능)
            </label>
            <button style={{ ...btn(!canApply, '#c2410c'), marginTop: 8 }} disabled={!canApply} onClick={apply} data-testid="sync-apply-btn" aria-label="승인 후 반영">
              {applying ? '반영 중…' : willApply === 0 ? '반영할 변경 없음' : `승인 후 반영 (${willApply.toLocaleString()}건)`}
            </button>
          </div>
        </>
      )}

      {result && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: '#ecfdf5', border: '1px solid #a7f3d0', fontSize: 12.5 }} data-testid="sync-result">
          {result.mode === 'no_change' ? '반영할 변경이 없어 아무것도 저장하지 않았습니다.' : <>
            <b>배치 #{result.batchId} 반영 완료</b> — 신규 {result.applied.created} · 수정 {result.applied.updated} · 중복 의심 승인(신규 {result.applied.approvedNew}·수정 {result.applied.approvedUpdate}) · 연결 이관 {result.linksCarried}(재검토 {result.linkReview}) · 보류 {result.held} · 삭제 의심 {result.deletionSuspects}
            <div>유효 자료 {result.effective.before.toLocaleString()} → {result.effective.after.toLocaleString()}건 · 변경 없음 {result.unchangedSkipped?.toLocaleString?.() ?? 0}건은 저장하지 않음</div>
          </>}
        </div>
      )}

      <div style={{ marginTop: 16, borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>업로드 이력 · 배치 되돌리기</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }} data-testid="sync-batches-table">
            <thead><tr style={{ background: '#f9fafb', textAlign: 'left' }}>{['배치', '파일', '저장 행', '상태', '등록일', ''].map(h => <th key={h} style={{ padding: '6px 8px' }}>{h}</th>)}</tr></thead>
            <tbody>
              {batches.map(b => (
                <tr key={b.id}>
                  <td style={td}>#{b.id}{b.isCurrent ? ' (현재)' : ''}</td>
                  <td style={td}>{b.originalFilename ?? '-'}</td>
                  <td style={td}>{b.successRows.toLocaleString()} / {b.totalRows.toLocaleString()}</td>
                  <td style={td}>{b.status === 'rolled_back' ? '되돌림' : b.status === 'completed' ? '반영됨' : b.status}</td>
                  <td style={td}>{new Date(b.createdAt).toLocaleString()}</td>
                  <td style={td}>{b.status === 'completed' && (
                    <button style={btn(rbBusy, '#6b7280')} disabled={rbBusy} onClick={() => previewRollback(b.id)} data-testid={`sync-rollback-preview-${b.id}`} aria-label={`배치 ${b.id} 되돌리기 미리보기`}>되돌리기 확인</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rbPlan && (
          <div style={{ marginTop: 10, padding: 12, borderRadius: 8, background: rbPlan.ok ? '#fef2f2' : '#f9fafb', border: '1px solid #fecaca', fontSize: 12.5 }} data-testid="sync-rollback-plan">
            <b>배치 #{rbPlan.batchId} 되돌리기 {rbPlan.ok ? '가능' : '불가'}</b> — {rbPlan.reason}
            {rbPlan.ok && <div style={{ marginTop: 4 }}>이 업로드가 바꾼 행 {rbPlan.effectiveInBatch}건 비유효 처리 · 이전 버전 {rbPlan.restoreSuperseded}건 복원 · 이후 다른 업로드로 수정된 {rbPlan.preservedLater}건 보존 · 이관 연결 {rbPlan.carriedLinks}개 해제 · 연결 보완 {rbPlan.linksToReattach}개 · 유효 자료 {rbPlan.effective.before.toLocaleString()} → {rbPlan.effective.afterExpected.toLocaleString()}건 (삭제 없음)</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {rbPlan.ok && <button style={btn(rbBusy, '#dc2626')} disabled={rbBusy} onClick={runRollback} data-testid="sync-rollback-run" aria-label="되돌리기 실행">되돌리기 실행</button>}
              <button style={btn(rbBusy, '#6b7280')} disabled={rbBusy} onClick={() => setRbPlan(null)} data-testid="sync-rollback-cancel" aria-label="되돌리기 취소">닫기</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
