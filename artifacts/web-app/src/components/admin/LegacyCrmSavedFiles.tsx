// 과거 CRM Excel 등록 — 자료 유형별 분석 파일 저장·불러오기·삭제(보관)
//   · 분석 / 파일 저장 / 동기화는 별개. 이 컴포넌트는 CRM 데이터를 바꾸지 않는다(파일·메타데이터만).
//   · 원본은 서버(R2 비공개)에 보관, 분석 결과는 집계 요약만 저장 → 상세는 '불러오기/재분석'으로 원본에서 다시 계산.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/constants';

type SourceType = 'sales_list' | 'progress' | 'translator_list';
type SavedFile = {
  id: number; sourceType: SourceType; fileName: string; fileHash: string; status: 'saved' | 'archived' | 'deleted';
  createdAt: string; createdBy: string | null; totalRows: number; size: number | null; analyzedAt: string | null;
  summary: Summary | null; syncStatus: 'synced' | 'rolled_back' | 'not_synced'; syncBatchIds: number[];
};
export type Summary = {
  totalRows: number;
  archivePlan?: { total: number; toSave: number; sameContentRows: number; warning: number } | null;
  matching?: Record<string, number> | null;                // Preview(Record Matching) 신규·수정·변경없음·중복의심
  syncPreview?: { counts: Record<string, number>; scope: string } | null;   // 변경분 미리보기(신규·수정·삭제·중복의심·삭제충돌)
};
const SYNC_LABEL: Record<SavedFile['syncStatus'], [string, string]> = { synced: ['동기화 반영', '#065f46'], rolled_back: ['반영 후 되돌림', '#92400e'], not_synced: ['미반영', '#6b7280'] };
const STATUS_LABEL: Record<SavedFile['status'], string> = { saved: '저장', archived: '보관', deleted: '삭제' };
const dt = (s: string | null) => (s ? new Date(s).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '-');
const kb = (n: number | null) => (n == null ? '-' : n < 1048576 ? `${(n / 1024).toFixed(0)}KB` : `${(n / 1048576).toFixed(1)}MB`);

function countsOf(s: Summary | null) {
  const c = s?.syncPreview?.counts, m = s?.matching;
  if (c) return { 신규: c.NEW ?? 0, 수정: c.UPDATED ?? 0, 삭제: c.DELETION_SUSPECT ?? 0, 중복의심: c.AMBIGUOUS ?? 0 };
  if (m) return { 신규: m.NEW ?? 0, 수정: m.UPDATED ?? 0, 삭제: null, 중복의심: m.AMBIGUOUS ?? 0 };
  return null;
}

export function LegacyCrmSavedFiles({ token, sourceType, sourceLabel, file, summary, setToast, onLoad, onReanalyze, reanalyzedSummary, onReset }: {
  token: string; sourceType: SourceType; sourceLabel: string; file: File | null; summary: Summary | null; setToast: (m: string) => void;
  onLoad: (f: File) => void;                       // 저장 파일을 현재 자료유형 슬롯에 불러오기(분석 결과는 저장 요약으로 표시)
  onReanalyze: (f: File) => void;                  // 불러온 원본으로 Preview 재실행
  reanalyzedSummary: Summary | null;               // 재분석 완료 후 요약(부모가 전달) → 저장 파일 요약 갱신
  onReset: () => void;                             // 현재 자료유형 파일·미리보기만 초기화
}) {
  const authH = { Authorization: `Bearer ${token}` };
  const [files, setFiles] = useState<SavedFile[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<SavedFile | null>(null);
  const [delArm, setDelArm] = useState<number | null>(null);
  const [dup, setDup] = useState<{ id: number; fileName: string; createdAt: string } | null>(null);
  const [pendingReanalyze, setPendingReanalyze] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(api(`/api/admin/legacy-archive/files?sourceType=${sourceType}`), { headers: authH });
      const d = await r.json(); if (!r.ok) throw new Error(d?.error || '목록 조회 실패');
      setFiles(d.files ?? []);
    } catch (e: any) { setToast(e?.message || '저장 파일 목록 조회 실패'); }
  }, [sourceType, token]); // eslint-disable-line
  useEffect(() => { setView(null); setDelArm(null); setDup(null); load(); }, [load]);

  // 재분석 완료 → 저장 파일 요약 갱신
  useEffect(() => {
    if (pendingReanalyze == null || !reanalyzedSummary) return;
    const id = pendingReanalyze; setPendingReanalyze(null);
    (async () => {
      try {
        const r = await fetch(api(`/api/admin/legacy-archive/files/${id}/analysis`), { method: 'PATCH', headers: { ...authH, 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: reanalyzedSummary }) });
        const d = await r.json(); if (!r.ok) throw new Error(d?.error || '재분석 결과 저장 실패');
        setToast('재분석 결과를 저장 파일에 반영했습니다.'); load();
      } catch (e: any) { setToast(e?.message || '재분석 결과 저장 실패'); }
    })();
  }, [reanalyzedSummary, pendingReanalyze]); // eslint-disable-line

  const save = async () => {
    if (!file) return;
    setBusy(true); setDup(null);
    try {
      const fd = new FormData(); fd.append('file', file); fd.append('sourceType', sourceType);
      if (summary) { fd.append('summary', JSON.stringify(summary)); fd.append('analyzedAt', new Date().toISOString()); }
      const r = await fetch(api('/api/admin/legacy-archive/files'), { method: 'POST', headers: authH, body: fd });
      const d = await r.json();
      if (r.status === 409 && d?.code === 'DUPLICATE_FILE') { setDup(d.existing); setOpen(true); setToast('같은 파일이 이미 저장되어 있습니다.'); return; }
      if (!r.ok) throw new Error(d?.error || '저장 실패');
      setToast(`저장 완료 — ${d.fileName}`); setOpen(true); load();
    } catch (e: any) { setToast(e?.message || '분석 파일 저장 실패'); } finally { setBusy(false); }
  };
  const fetchFile = async (f: SavedFile): Promise<File> => {
    const r = await fetch(api(`/api/admin/legacy-archive/files/${f.id}/download`), { headers: authH });
    if (!r.ok) { let m = '원본 파일을 가져오지 못했습니다.'; try { m = (await r.json())?.error || m; } catch { /* binary 아님 */ } if (r.status === 403) m = '원본 파일 열람은 관리자만 가능합니다.'; throw new Error(m); }
    const b = await r.blob();
    return new File([b], f.fileName, { type: b.type || 'application/vnd.ms-excel' });
  };
  const doLoad = async (f: SavedFile, reanalyze: boolean) => {
    setBusy(true);
    try {
      const fl = await fetchFile(f);
      if (reanalyze) { setPendingReanalyze(f.id); onReanalyze(fl); } else { onLoad(fl); setView(f); }
      setToast(reanalyze ? `${f.fileName} — 재분석을 시작했습니다.` : `${f.fileName}을(를) 불러왔습니다. 저장된 분석 요약을 표시합니다.`);
    } catch (e: any) { setToast(e?.message || '불러오기 실패'); setPendingReanalyze(null); } finally { setBusy(false); }
  };
  const download = async (f: SavedFile) => {
    try {
      const fl = await fetchFile(f);
      const url = URL.createObjectURL(fl); const a = document.createElement('a'); a.href = url; a.download = f.fileName; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: any) { setToast(e?.message || '다운로드 실패'); }
  };
  const remove = async (f: SavedFile) => {
    setBusy(true);
    try {
      const r = await fetch(api(`/api/admin/legacy-archive/files/${f.id}?confirm=true`), { method: 'DELETE', headers: authH });
      const d = await r.json(); if (!r.ok) throw new Error(d?.error || '삭제 실패');
      setToast(d.result === 'archived' ? '동기화에 사용된 파일이라 삭제하지 않고 보관 상태로 전환했습니다.' : '저장 파일을 삭제했습니다.');
      setDelArm(null); if (view?.id === f.id) setView(null); load();
    } catch (e: any) { setToast(e?.message || '삭제 실패'); } finally { setBusy(false); }
  };

  const btn = (disabled: boolean, bg = '#fff', fg = '#334155'): React.CSSProperties => ({ padding: '7px 13px', borderRadius: 8, fontSize: 13, fontWeight: 700, border: '1px solid #cbd5e1', background: bg, color: fg, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 });
  const sm: React.CSSProperties = { padding: '3px 8px', borderRadius: 6, fontSize: 12, fontWeight: 700, border: '1px solid #cbd5e1', background: '#fff', color: '#334155', cursor: 'pointer', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '6px 8px', fontSize: 12.5, borderTop: '1px solid #f3f4f6', whiteSpace: 'nowrap' };
  const shownSummary = view?.summary ?? null;

  return (
    <div data-testid={`saved-files-${sourceType}`} style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={btn(!file)} disabled={!file} onClick={onReset} data-testid="archive-reset-file" aria-label={`${sourceLabel} 파일 초기화`}>파일 초기화</button>
        <button style={btn(!file || busy, '#0f766e', '#fff')} disabled={!file || busy} onClick={save} data-testid="archive-save-file" aria-label={`${sourceLabel} 분석 파일 저장`}>{busy ? '처리 중…' : '분석 파일 저장'}</button>
        <button style={btn(false)} onClick={() => setOpen(v => !v)} data-testid="archive-saved-toggle" aria-expanded={open} aria-label={`${sourceLabel} 저장 파일 불러오기`}>저장 파일 불러오기 ({files.length}) {open ? '▲' : '▼'}</button>
        {!summary && file && <span style={{ fontSize: 12, color: '#9ca3af' }}>Preview 전 저장하면 원본만 저장되고 분석 요약은 비어 있습니다.</span>}
      </div>
      {dup && (
        <div data-testid="archive-dup-notice" style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a', fontSize: 12.5, color: '#92400e' }}>
          같은 파일이 이미 저장되어 있습니다({dup.fileName} · {dt(dup.createdAt)}). 목록에서 <b>불러오기</b>로 기존 파일을 열거나, 현재 파일로 <b>Preview</b>를 다시 실행하세요.
          <button style={{ ...sm, marginLeft: 8 }} onClick={() => setDup(null)} data-testid="archive-dup-close" aria-label="안내 닫기">닫기</button>
        </div>
      )}
      {open && (
        <div style={{ marginTop: 8, border: '1px solid #e5e7eb', borderRadius: 8, overflowX: 'auto' }} data-testid="archive-saved-list">
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr>{['파일명', '등록일시', '분석일시', '등록자', '행 수', '신규', '수정', '삭제', '중복의심', '저장', '동기화', ''].map(h => <th key={h} style={{ ...td, borderTop: 'none', background: '#f9fafb', color: '#6b7280', fontWeight: 700, textAlign: 'left' }}>{h}</th>)}</tr></thead>
            <tbody>
              {files.map(f => { const c = countsOf(f.summary); const [sl, sc] = SYNC_LABEL[f.syncStatus]; return (
                <tr key={f.id} data-testid={`saved-file-${f.id}`} style={view?.id === f.id ? { background: '#eff6ff' } : undefined}>
                  <td style={{ ...td, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${f.fileName} · ${kb(f.size)} · #${f.fileHash}`}>{f.fileName}</td>
                  <td style={td}>{dt(f.createdAt)}</td><td style={td}>{dt(f.analyzedAt)}</td><td style={td}>{f.createdBy ?? '-'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{(f.summary?.totalRows ?? f.totalRows).toLocaleString()}</td>
                  {(['신규', '수정', '삭제', '중복의심'] as const).map(k => <td key={k} style={{ ...td, textAlign: 'right', color: c?.[k] == null ? '#d1d5db' : undefined }}>{c?.[k] == null ? '-' : c[k]!.toLocaleString()}</td>)}
                  <td style={td}>{STATUS_LABEL[f.status]}</td>
                  <td style={{ ...td, color: sc, fontWeight: 700 }} title={f.syncBatchIds.length ? `배치 #${f.syncBatchIds.join(', #')}` : undefined}>{sl}{f.syncBatchIds.length ? ` (#${f.syncBatchIds.join(',')})` : ''}</td>
                  <td style={{ ...td, display: 'flex', gap: 4 }}>
                    <button style={sm} disabled={busy} onClick={() => doLoad(f, false)} data-testid={`saved-load-${f.id}`} aria-label={`${f.fileName} 불러오기`}>불러오기</button>
                    <button style={sm} onClick={() => setView(v => (v?.id === f.id ? null : f))} data-testid={`saved-view-${f.id}`} aria-label={`${f.fileName} 분석 결과 보기`}>분석 결과</button>
                    <button style={sm} onClick={() => download(f)} data-testid={`saved-download-${f.id}`} aria-label={`${f.fileName} 원본 다운로드`}>원본</button>
                    <button style={sm} disabled={busy} onClick={() => doLoad(f, true)} data-testid={`saved-reanalyze-${f.id}`} aria-label={`${f.fileName} 재분석`}>재분석</button>
                    {f.status === 'saved' && (delArm === f.id
                      ? <><button style={{ ...sm, background: '#dc2626', color: '#fff', borderColor: '#dc2626' }} disabled={busy} onClick={() => remove(f)} data-testid={`saved-delete-confirm-${f.id}`} aria-label={`${f.fileName} ${f.syncStatus === 'not_synced' ? '삭제' : '보관'} 확정`}>{f.syncStatus === 'not_synced' ? '삭제 확정' : '보관 확정'}</button>
                          <button style={sm} onClick={() => setDelArm(null)} data-testid={`saved-delete-cancel-${f.id}`} aria-label="취소">취소</button></>
                      : <button style={{ ...sm, color: '#b91c1c' }} onClick={() => setDelArm(f.id)} data-testid={`saved-delete-${f.id}`} aria-label={`${f.fileName} ${f.syncStatus === 'not_synced' ? '삭제' : '보관'}`}>{f.syncStatus === 'not_synced' ? '삭제' : '보관'}</button>)}
                  </td>
                </tr>
              ); })}
              {files.length === 0 && <tr><td colSpan={12} style={{ ...td, textAlign: 'center', color: '#9ca3af' }}>저장된 {sourceLabel} 파일이 없습니다.</td></tr>}
            </tbody>
          </table>
          <div style={{ padding: '5px 8px', fontSize: 11.5, color: '#6b7280' }}>저장·삭제는 파일 보관만 다루며 CRM 데이터에는 영향이 없습니다. 동기화에 사용된 파일은 삭제 대신 보관됩니다(이력·되돌리기 근거 보존).</div>
        </div>
      )}
      {view && (
        <div data-testid="archive-saved-summary" style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe', fontSize: 12.5, lineHeight: 1.7 }}>
          <b>{view.fileName}</b> — 저장된 분석 요약(분석 {dt(view.analyzedAt)}){!shownSummary && ' · 분석 요약 없음(원본만 저장)'}
          {shownSummary?.archivePlan && <div>총 {shownSummary.archivePlan.total.toLocaleString()}행 · 저장 대상 {shownSummary.archivePlan.toSave.toLocaleString()} · 원본 동일행 {shownSummary.archivePlan.sameContentRows.toLocaleString()} · 경고 {shownSummary.archivePlan.warning.toLocaleString()}</div>}
          {shownSummary?.matching && <div>Preview 대조: {Object.entries(shownSummary.matching).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>}
          {shownSummary?.syncPreview && <div>변경분 미리보기({shownSummary.syncPreview.scope === 'full' ? '전체' : '기간'}): {Object.entries(shownSummary.syncPreview.counts).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>}
          <div style={{ color: '#6b7280' }}>상세 행 목록은 <b>재분석</b> 또는 아래 <b>Preview / 변경분 미리보기</b>로 원본에서 다시 계산합니다.</div>
        </div>
      )}
    </div>
  );
}
