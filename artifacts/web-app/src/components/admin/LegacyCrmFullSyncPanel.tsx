// 과거 CRM 판매목록·진행관리표 통합 동기화 — 최신 CRM 파일 기준(신규·변경·삭제 모두 반영)
//   · 두 파일을 같은 기준일로 미리보기 → '최신 자료로 동기화'(관리자, 단일 트랜잭션 · 전부 또는 전무).
//   · 삭제 = 비활성(업무 화면·집계 제외, 되돌리기로 복구). 건별 승인 없음. 운영 전환·연결 보존 건은 충돌로 분리.
//   · 동기화 범위는 관리자가 명시 선택(파일명 날짜로 전체 자료라고 추정하지 않음).
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/constants';
import { formatAmountDisplay } from '../../lib/utils';

type Src = 'sales_list' | 'progress';
type Impact = { basis: string; added: { count: number; amount: number }; changed: { count: number; before: number; after: number }; excluded: { count: number; amount: number }; conflicts: { count: number; amount: number }; netDelta: number };
type Side = {
  planToken: string; total: number; counts: Record<string, number>; relaxedMatches: number; blockers: { code: string; message: string }[];
  comparedWith: { effectiveRows: number }; deletionScope: { mode: string; from: string | null; to: string | null; outOfScope: number; undated: number; inScope: number };
  amountImpact: Impact; conflictsByCode: Record<string, number>;
};
type FullSummary = {
  fullSyncId: string; asOfDate: string; scope: 'range' | 'full'; salesName: string; progressName: string; executable: boolean;
  lastAsOf: { sales_list: string | null; progress: string | null }; blockers: { code: string; message: string }[];
  links: { salesDeletedWithProgressDeleted: number; progressDeletedSaleKept: number }; sales: Side; progress: Side;
  cancelCandidates?: { sales: number; progressRows: number; progressPretax: number };
};
type Run = { runId: string; asOfDate: string | null; createdAt: string; rolledBack: boolean; batches: { batchId: number; sourceType: Src; fileName: string; status: string; deleted: number; counts: Record<string, number> | null }[] };
const SRC_LABEL: Record<Src, string> = { sales_list: '판매목록', progress: '진행관리표' };
const CLS_LABEL: Record<string, string> = { NEW: '신규', UPDATED: '변경', AMBIGUOUS: '중복 의심(보류)', DELETION_SUSPECT: '삭제', DELETION_CONFLICT: '삭제 충돌' };
const CONFLICT_LABEL: Record<string, string> = { activated: '운영 전환', linked_progress: '수행행 유지', identity_unresolved: '식별 불가' };
const won = (n: number) => formatAmountDisplay(Math.round(n) as any);
const todayKst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export function LegacyCrmFullSyncPanel({ token, setToast, onApplied }: { token: string; setToast: (m: string) => void; onApplied?: () => void }) {
  const authH = { Authorization: `Bearer ${token}` };
  const [asOfDate, setAsOfDate] = useState(todayKst());
  const [scope, setScope] = useState<'range' | 'full' | null>(null);
  const [salesFile, setSalesFile] = useState<File | null>(null);
  const [progressFile, setProgressFile] = useState<File | null>(null);
  const [lastAsOf, setLastAsOf] = useState<FullSummary['lastAsOf'] | null>(null);
  const [summary, setSummary] = useState<FullSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<{ source: Src; cls: string; rows: any[]; total: number } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [rbArm, setRbArm] = useState<string | null>(null);

  useEffect(() => { setSummary(null); setDetail(null); setConfirm(false); }, [asOfDate, scope, salesFile, progressFile]);
  const loadMeta = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([fetch(api('/api/admin/legacy-archive/full-sync/status'), { headers: authH }), fetch(api('/api/admin/legacy-archive/full-sync/runs'), { headers: authH })]);
      if (s.ok) setLastAsOf((await s.json()).lastAsOf); if (r.ok) setRuns((await r.json()).runs ?? []);
    } catch { /* 표시용 */ }
  }, [token]); // eslint-disable-line
  useEffect(() => { loadMeta(); }, [loadMeta]);

  const preview = async () => {
    if (!salesFile || !progressFile || !scope) return;
    setLoading(true); setResult(null);
    try {
      const fd = new FormData();
      fd.append('salesFile', salesFile); fd.append('progressFile', progressFile); fd.append('asOfDate', asOfDate); fd.append('scope', scope);
      const res = await fetch(api('/api/admin/legacy-archive/full-sync/preview'), { method: 'POST', headers: authH, body: fd });
      const d = await res.json(); if (!res.ok) throw new Error(d?.error || '미리보기 실패');
      setSummary(d.summary); setDetail(null); setConfirm(false);
    } catch (e: any) { setToast(e?.message || '미리보기 실패'); } finally { setLoading(false); }
  };
  const loadDetail = async (source: Src, cls: string) => {
    if (!summary) return;
    try {
      const res = await fetch(api('/api/admin/legacy-archive/full-sync/page'), { method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' }, body: JSON.stringify({ fullSyncId: summary.fullSyncId, source, cls, page: 1, pageSize: 200 }) });
      const d = await res.json(); if (!res.ok) throw new Error(d?.error || '상세 조회 실패');
      setDetail({ source, cls, rows: d.page.rows, total: d.page.total });
    } catch (e: any) { setToast(e?.message || '상세 조회 실패'); }
  };
  const execute = async () => {
    if (!summary) return;
    setRunning(true);
    try {
      const res = await fetch(api('/api/admin/legacy-archive/full-sync/execute'), { method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, fullSyncId: summary.fullSyncId, salesToken: summary.sales.planToken, progressToken: summary.progress.planToken, }) });
      const d = await res.json(); if (!res.ok) throw new Error(d?.error || '동기화 실패');
      setResult(d); setSummary(null); setDetail(null); setConfirm(false);
      setToast(d.mode === 'no_change' ? '최신 자료와 이미 일치합니다. 변경 없음.' : `동기화 완료(기준일 ${d.asOfDate})`);
      loadMeta(); onApplied?.();
    } catch (e: any) { setToast(e?.message || '동기화 실패'); } finally { setRunning(false); }
  };
  const rollback = async (runId: string) => {
    setRunning(true);
    try {
      const res = await fetch(api(`/api/admin/legacy-archive/full-sync/runs/${runId}/rollback`), { method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      const d = await res.json(); if (!res.ok) throw new Error(d?.error || '되돌리기 실패');
      setToast('동기화를 되돌렸습니다(삭제 복구·변경 이전 버전 복원).'); setRbArm(null); loadMeta(); onApplied?.();
    } catch (e: any) { setToast(e?.message || '되돌리기 실패'); } finally { setRunning(false); }
  };

  const box: React.CSSProperties = { border: '1px solid #c7d2fe', borderRadius: 10, padding: 14, background: '#fff', marginTop: 14 };
  const inp: React.CSSProperties = { padding: '6px 9px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13 };
  const btn = (disabled: boolean, bg: string): React.CSSProperties => ({ padding: '8px 15px', borderRadius: 8, fontWeight: 700, fontSize: 13, border: 'none', color: '#fff', background: bg, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 });
  const th: React.CSSProperties = { padding: '6px 10px', fontSize: 12, color: '#6b7280', textAlign: 'right', whiteSpace: 'nowrap', background: '#f9fafb' };
  const td: React.CSSProperties = { padding: '6px 10px', fontSize: 13, textAlign: 'right', borderTop: '1px solid #f3f4f6', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
  const cell = (source: Src, cls: string, n: number, color?: string) => (
    <td style={td}>{n > 0 && CLS_LABEL[cls]
      ? <button onClick={() => loadDetail(source, cls)} data-testid={`fs-cell-${source}-${cls}`} aria-label={`${SRC_LABEL[source]} ${CLS_LABEL[cls]} ${n}건 상세`} style={{ border: 'none', background: 'none', color: color ?? '#1d4ed8', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: 13 }}>{n.toLocaleString()}</button>
      : <span style={{ color: n ? undefined : '#9ca3af' }}>{n.toLocaleString()}</span>}</td>
  );
  const canPreview = !!salesFile && !!progressFile && !!scope && /^\d{4}-\d{2}-\d{2}$/.test(asOfDate) && !loading;
  const canRun = !!summary && summary.executable && confirm && !running;

  return (
    <div style={box} data-testid="full-sync-panel">
      <div style={{ fontSize: 15, fontWeight: 800, color: '#111827' }}>최신 CRM 자료 통합 동기화 <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>판매목록 + 진행관리표 · 같은 기준일</span></div>
      <div style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 10px', lineHeight: 1.6 }}>
        최신 CRM 파일과 일치하도록 신규·변경·삭제를 모두 반영합니다. 삭제 자료는 업무 화면·집계·지급대상에서 제외되며 되돌리기로 복구할 수 있습니다.
        플랫폼 운영 판매로 전환된 자료와 연결이 남은 자료는 삭제하지 않고 충돌로 보고합니다. 두 파일 중 하나라도 실패하면 아무것도 반영되지 않습니다.
        {lastAsOf && <> · 최종 동기화 기준일: 판매목록 <b>{lastAsOf.sales_list ?? '없음'}</b> / 진행관리표 <b>{lastAsOf.progress ?? '없음'}</b></>}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: 13, fontWeight: 700 }}>기준일 <input type="date" style={inp} value={asOfDate} onChange={e => setAsOfDate(e.target.value)} data-testid="fs-asof" aria-label="동기화 기준일" /></label>
        <label style={{ fontSize: 13 }}>판매목록 <input type="file" accept=".xls,.xlsx" onChange={e => setSalesFile(e.target.files?.[0] ?? null)} data-testid="fs-sales-file" aria-label="판매목록 파일" /></label>
        <label style={{ fontSize: 13 }}>진행관리표 <input type="file" accept=".xls,.xlsx" onChange={e => setProgressFile(e.target.files?.[0] ?? null)} data-testid="fs-progress-file" aria-label="진행관리표 파일" /></label>
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>동기화 범위</span>
        {([['full', '전체 자료 파일(CRM 전체 기간)'], ['range', '기간 자료(파일에 포함된 체결일 기간만 비교)']] as const).map(([v, l]) => (
          <label key={v} style={{ fontSize: 13, display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="fs-scope" checked={scope === v} onChange={() => setScope(v)} data-testid={`fs-scope-${v}`} aria-label={l} />{l}
          </label>
        ))}
        <button style={btn(!canPreview, '#4f46e5')} disabled={!canPreview} onClick={preview} data-testid="fs-preview-btn" aria-label="통합 동기화 미리보기">{loading ? '분석 중…(약 10~20초)' : '미리보기'}</button>
      </div>
      {!scope && (salesFile || progressFile) && <div style={{ fontSize: 12, color: '#b45309', marginTop: 6 }}>동기화 범위를 선택하세요. 범위가 불명확하면 삭제를 판정할 수 없습니다.</div>}

      {summary && (
        <div style={{ marginTop: 12 }} data-testid="fs-summary">
          {summary.blockers.length > 0 && (
            <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12.5, marginBottom: 10 }} data-testid="fs-blockers">
              <b>실행 차단</b>{summary.blockers.map((b, i) => <div key={i}>· {b.message}</div>)}
            </div>
          )}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', border: '1px solid #e5e7eb', borderRadius: 8 }}>
              <thead><tr>{['', '기존', '최신 파일', '신규', '변경', '동일', '삭제', '중복 의심', '삭제 충돌'].map(h => <th key={h} style={{ ...th, textAlign: h ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
              <tbody>
                {(['sales_list', 'progress'] as Src[]).map(src => {
                  const s = summary[src === 'sales_list' ? 'sales' : 'progress'];
                  return (
                    <tr key={src} data-testid={`fs-row-${src}`}>
                      <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>{SRC_LABEL[src]}<div style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af' }}>{src === 'sales_list' ? summary.salesName : summary.progressName}</div></td>
                      <td style={td}>{s.comparedWith.effectiveRows.toLocaleString()}</td>
                      <td style={td}>{s.total.toLocaleString()}</td>
                      {cell(src, 'NEW', s.counts.NEW)}
                      {cell(src, 'UPDATED', s.counts.UPDATED, '#92400e')}
                      <td style={td}>{s.counts.SAME.toLocaleString()}</td>
                      {cell(src, 'DELETION_SUSPECT', s.counts.DELETION_SUSPECT, '#6b21a8')}
                      {cell(src, 'AMBIGUOUS', s.counts.AMBIGUOUS, '#991b1b')}
                      {cell(src, 'DELETION_CONFLICT', s.counts.DELETION_CONFLICT ?? 0, '#b45309')}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 12, color: '#374151', marginTop: 8, lineHeight: 1.7 }}>
            {(['sales', 'progress'] as const).map(k => { const s = summary[k]; return (
              <div key={k}>{k === 'sales' ? '판매목록' : '진행관리표'} 비교 범위: {s.deletionScope.mode === 'full' ? '전체' : `체결일 ${s.deletionScope.from ?? '-'} ~ ${s.deletionScope.to ?? '-'}`} · 비교 대상 기존 {s.deletionScope.inScope.toLocaleString()}건
                {s.deletionScope.mode === 'range' && ` (범위 밖 ${s.deletionScope.outOfScope.toLocaleString()}건·날짜 없음 ${s.deletionScope.undated.toLocaleString()}건 보존)`}
                {s.relaxedMatches > 0 && ` · 식별 항목 변경 재매칭 ${s.relaxedMatches}건(중복 생성 방지)`}
                {Object.keys(s.conflictsByCode ?? {}).length > 0 && ` · 충돌: ${Object.entries(s.conflictsByCode).map(([c, n]) => `${CONFLICT_LABEL[c] ?? c} ${n}`).join(', ')}`}</div>
            ); })}
            <div>연결 검증: 판매·수행행 함께 삭제 {summary.links.salesDeletedWithProgressDeleted}건 · 수행행만 삭제(판매 유지) {summary.links.progressDeletedSaleKept}건</div>
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
            {([['progress', '지급 영향(진행관리표 · 세전 지급액)', ['지급대상 추가', '지급대상 변경', '지급대상 제외', '확정기록 충돌']], ['sales', '매출 영향(판매목록 · 총액)', ['매출 추가', '매출 변경', '매출 제외', '운영전환 충돌']]] as const).map(([k, title, labels]) => {
              const a = summary[k].amountImpact;
              return (
                <div key={k} style={{ flex: '1 1 320px', border: '1px solid #e5e7eb', borderRadius: 8, padding: 10 }} data-testid={`fs-impact-${k}`}>
                  <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 4 }}>{title}</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
                    <div>{labels[0]} {a.added.count.toLocaleString()}건 · {won(a.added.amount)}원</div>
                    <div>{labels[1]} {a.changed.count.toLocaleString()}건 · {won(a.changed.before)} → {won(a.changed.after)}원</div>
                    <div>{labels[2]} {a.excluded.count.toLocaleString()}건 · −{won(a.excluded.amount)}원</div>
                    <div>{labels[3]} {a.conflicts.count.toLocaleString()}건 · {won(a.conflicts.amount)}원(보존)</div>
                    <div style={{ fontWeight: 800 }}>금액 변경 합계 {a.netDelta >= 0 ? '+' : '−'}{won(Math.abs(a.netDelta))}원</div>
                  </div>
                </div>
              );
            })}
          </div>

          {detail && (
            <div style={{ marginTop: 10, border: '1px solid #e5e7eb', borderRadius: 8, overflowX: 'auto' }} data-testid="fs-detail">
              <div style={{ padding: '6px 10px', fontSize: 12.5, fontWeight: 800, background: '#f9fafb' }}>{SRC_LABEL[detail.source]} · {CLS_LABEL[detail.cls]} {detail.total.toLocaleString()}건{detail.total > detail.rows.length && ` (상위 ${detail.rows.length}건 표시)`}</div>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr>{['판매번호', '거래처', '상품', '통번역사', '체결/판매일', '납품일', '지급일', '금액', '사유·변경'].map(h => <th key={h} style={{ ...th, textAlign: 'left' }}>{h}</th>)}</tr></thead>
                <tbody>{detail.rows.map((r, i) => { const v = r.incoming ?? r; return (
                  <tr key={i}>
                    {[v.saleNo, v.companyName, v.productName, v.translatorName, v.saleDate, v.deliveryDate, v.payoutDate].map((x, j) => <td key={j} style={{ ...td, textAlign: 'left' }}>{x ?? '-'}</td>)}
                    <td style={td}>{won(Number(detail.source === 'sales_list' ? v.totalAmount : v.payoutPretax) || 0)}</td>
                    <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal', minWidth: 220, color: '#4b5563' }}>{r.reason ?? ''}{r.changedFields?.length ? ` · ${r.changedFields.map((c: any) => `${c.field}: ${c.before ?? '∅'}→${c.after ?? '∅'}`).join(', ')}` : ''}</td>
                  </tr>); })}</tbody>
              </table>
            </div>
          )}

          <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: '#eef2ff', border: '1px solid #c7d2fe' }}>
            {(summary.cancelCandidates?.sales ?? 0) > 0 && (
              <div data-testid="fs-cancel-info" style={{ fontSize: 12.5, color: '#92400e', marginBottom: 8, lineHeight: 1.6 }}>
                최신 판매목록에 없는 판매 중 연결 수행행이 남은 <b>{summary.cancelCandidates!.sales}건</b> — 판매는 비활성화하고, 연결 수행행 {summary.cancelCandidates!.progressRows}건(세전 {won(summary.cancelCandidates!.progressPretax)}원)은
                최신 파일상 다른 유효 판매(재등록 판매번호 등)와 연결되면 재연결, 아니면 비활성화(지급예정 제외)합니다. 운영 전환 자료는 보호.
              </div>
            )}
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} disabled={!summary.executable} data-testid="fs-confirm" aria-label="미리보기 내용을 확인했으며 최신 자료로 동기화합니다" />
              기준일 {summary.asOfDate} 미리보기 내용을 확인했으며, 신규·변경·삭제를 최신 자료로 동기화합니다(관리자 권한 · 되돌리기 가능)
            </label>
            <button style={{ ...btn(!canRun, '#4338ca'), marginTop: 8 }} disabled={!canRun} onClick={execute} data-testid="fs-execute-btn" aria-label="최신 자료로 동기화">{running ? '동기화 중…' : '최신 자료로 동기화'}</button>
          </div>
        </div>
      )}

      {result && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: '#ecfdf5', border: '1px solid #a7f3d0', fontSize: 12.5, lineHeight: 1.7 }} data-testid="fs-result">
          {result.mode === 'no_change' ? '최신 자료와 이미 일치합니다 — 저장·삭제 없음.' : <>
            <b>동기화 완료 · 기준일 {result.asOfDate}</b>
            {(['sales', 'progress'] as const).map(k => { const r = result[k]; return (
              <div key={k}>{k === 'sales' ? '판매목록' : '진행관리표'}: 신규 {r.applied.created} · 변경 {r.applied.updated} · 삭제 {r.deleted} · 삭제 충돌 {r.deletionConflicts} · 보류 {r.held} · 유효 {r.effective.before.toLocaleString()} → {r.effective.after.toLocaleString()}</div>
            ); })}
            {result.cancelled && result.cancelled.sales > 0 && <div>최신 파일에 없는 판매(연결 수행행 보유) {result.cancelled.sales}건 비활성화 · 연결 수행행 비활성화 {result.cancelled.progress}건 · 다른 유효 판매로 재연결 {result.cancelled.relinked ?? 0}건</div>}
            {(result.keptProgressOfCancelledSales?.length ?? 0) > 0 && <div>판매취소 판매에 연결된 채 유지된 수행행 {result.keptProgressOfCancelledSales.length}건: {result.keptProgressOfCancelledSales.map((k: any) => `${k.saleNo}·${k.translator ?? '-'}·${k.deliveryDate ?? '-'}`).join(' / ')}</div>}
            <div>정합성: 비유효 행과의 신규 연결 {result.integrity.newLinksToInactive} · 판매건을 잃은 수행행 {result.integrity.orphanedByRun} · 중복 버전 그룹 {result.integrity.duplicateGroups}</div>
          </>}
        </div>
      )}

      {runs.length > 0 && (
        <div style={{ marginTop: 12 }} data-testid="fs-runs">
          <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 4 }}>통합 동기화 이력</div>
          {runs.slice(0, 5).map(r => (
            <div key={r.runId} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5, padding: '4px 0', borderTop: '1px solid #f3f4f6' }}>
              <span>기준일 <b>{r.asOfDate ?? '-'}</b> · {new Date(r.createdAt).toLocaleString('ko-KR')}</span>
              {r.batches.map(b => <span key={b.batchId} style={{ color: '#6b7280' }}>{SRC_LABEL[b.sourceType]} #{b.batchId}(삭제 {b.deleted}){b.status === 'rolled_back' ? ' · 되돌림' : ''}</span>)}
              {!r.rolledBack && (rbArm === r.runId
                ? <><button style={btn(running, '#b91c1c')} disabled={running} onClick={() => rollback(r.runId)} data-testid={`fs-rollback-confirm-${r.runId}`} aria-label="되돌리기 확정">되돌리기 확정</button>
                    <button style={btn(false, '#6b7280')} onClick={() => setRbArm(null)} data-testid={`fs-rollback-cancel-${r.runId}`} aria-label="되돌리기 취소">취소</button></>
                : <button style={btn(running, '#9ca3af')} disabled={running} onClick={() => setRbArm(r.runId)} data-testid={`fs-rollback-${r.runId}`} aria-label="이 동기화 되돌리기">되돌리기</button>)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
