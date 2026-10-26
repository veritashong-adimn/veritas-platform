// 통번역사 대량등록 — 통합 판정 · 대표 승인 · 실행 · 되돌리기 패널
//   기존 동일 / 정보 보완 / 신규 / 등록 보류 / 수동 확인 5유형과 변경 전후를 보여주고,
//   수동 확인 행은 개별로 '보류 / 기존 Master 연결 / 신규 등록' 을 선택한다. 승인하지 않은 행은 등록하지 않는다.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/constants';
import { TranslatorReviewDrawer, DECISION_LABEL } from './TranslatorReviewDrawer';

type Cat = 'ALL' | 'SAME' | 'UPDATE' | 'NEW' | 'HOLD' | 'MANUAL';
type FieldChange = { field: string; label: string; before: string | null; after: string | null };
type Candidate = { id: number; name: string; alive: boolean; basis: string };
type Row = {
  rowNumber: number; name: string; category: Exclude<Cat, 'ALL'>; reasonCode: string; reason: string;
  masterId: number | null; masterName: string | null; viaMergedId: number | null;
  fills: FieldChange[]; diffs: FieldChange[]; candidates: Candidate[]; allowNew: boolean; allowLinkIds: number[];
  eligibility: { history: boolean; rrn: boolean }; email: string; hasRrn: boolean; firstRowOfDuplicate?: number;
  basis: string[]; creatable: boolean; allowOwnHistory?: boolean; rrnConflictIds?: number[];
  savedDecision?: { decision: string; at: string } | null;
};
type Summary = {
  planToken: string; reviewedManual?: number; counts: Record<Exclude<Cat, 'ALL'>, number>; personCounts?: Record<Exclude<Cat, 'ALL'>, number>; byReason: Record<string, number>;
  totals: { rows: number; reconciled: boolean; aliveMastersBefore: number; excludedMasters: number; expectedNew: number; expectedUpdate: number; expectedAliveAfter: number; newWithoutEmail: number; duplicateRows: number; persons: number };
  checks: { newRowsMatchingExisting: number; newRowsEmailCollision: number; newDuplicateEmailInBatch: number };
};

const META: Record<Cat, { label: string; color: string; bg: string }> = {
  ALL: { label: '전체', color: '#111827', bg: '#f3f4f6' },
  SAME: { label: '기존 Master 동일인', color: '#065f46', bg: '#ecfdf5' },
  UPDATE: { label: '기존 Master 정보 보완', color: '#92400e', bg: '#fffbeb' },
  NEW: { label: '신규 등록 가능', color: '#1e40af', bg: '#eff6ff' },
  HOLD: { label: '등록 제외(주민번호·수행이력 없음)', color: '#4b5563', bg: '#f9fafb' },
  MANUAL: { label: '동일인 수동 확인', color: '#991b1b', bg: '#fef2f2' },
};

// mode: summary(②단계 — 6개 수치만) · review(③단계 — 판정표·수동 확인) · final(④단계 — 실행 대상 4개 수치 + 최종 등록) · full(전체)
export function TranslatorImportApprovalPanel({ token, snapshotId, onToast, mode = 'full' }: { token: string; snapshotId: string | null | undefined; onToast: (m: string) => void; mode?: 'summary' | 'review' | 'final' | 'full' }) {
  const showTable = mode === 'review' || mode === 'full';
  const showExec = mode === 'final' || mode === 'full';
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [summary, setSummary] = useState<Summary | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [cat, setCat] = useState<Cat>('ALL');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [batches, setBatches] = useState<any[]>([]);
  const [rb, setRb] = useState<any>(null);
  const [reviewRow, setReviewRow] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(mode === 'full');

  const load = useCallback(async (c: Cat, p: number, size: number, search = q) => {
    if (!snapshotId) { onToast('업로드 원본이 없습니다. 파일을 업로드해 분석하세요.'); return; }
    setLoading(true);
    try {
      const res = await fetch(api('/api/admin/translators/import-plan/page'), { method: 'POST', headers: auth, body: JSON.stringify({ snapshotId, cat: c, page: p, pageSize: size, q: search }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '통합 판정 조회 실패');
      if (summary && summary.planToken !== data.summary.planToken) { setDecisions({}); setConfirmChecked(false); onToast('Master 자료가 바뀌어 판정을 다시 계산했습니다. 수동 결정을 다시 확인하세요.'); }
      setSummary(data.summary); setLabels(data.reasonLabels ?? {}); setRows(data.page.rows); setTotal(data.page.total);
      setCat(c); setPage(data.page.page); setPageSize(data.page.pageSize);
    } catch (e: any) { onToast(e?.message || '통합 판정 조회 실패'); } finally { setLoading(false); }
  }, [snapshotId, token, summary, q]); // eslint-disable-line

  const loadBatches = useCallback(async () => {
    try { const res = await fetch(api('/api/admin/translators/import-plan/batches'), { headers: auth }); const d = await res.json(); if (res.ok) setBatches(d.batches ?? []); } catch { /* 이력 조회 실패는 무시 */ }
  }, [token]); // eslint-disable-line
  useEffect(() => { setSummary(null); setRows([]); setDecisions({}); setResult(null); setConfirmChecked(false); loadBatches(); if (snapshotId) load('ALL', 1, pageSize); }, [snapshotId]); // eslint-disable-line

  const decidedNew = Object.values(decisions).filter(v => v === 'new' || v === 'different' || v === 'different_own_history').length;   // 신규 재판정 요청(실행 시 자격 재검증)
  const decidedLink = Object.values(decisions).filter(v => v.startsWith('link:')).length;
  const canExecute = !!summary && confirmChecked && !executing && (summary.counts.NEW + summary.counts.UPDATE + decidedNew + decidedLink) > 0;

  const execute = async () => {
    if (!summary || !snapshotId) return;
    setExecuting(true);
    try {
      const res = await fetch(api('/api/admin/translators/import-plan/execute'), { method: 'POST', headers: auth, body: JSON.stringify({ snapshotId, planToken: summary.planToken, approve: true, decisions }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || '등록 실행 실패');
      setResult(d); setConfirmChecked(false); setDecisions({});
      onToast(d.mode === 'no_change' ? '반영할 변경이 없습니다.' : `등록 완료(배치 #${d.batchId}): 신규 ${d.created} · 보완 ${d.updated} · Master ${d.aliveBefore} → ${d.aliveAfter}`);
      loadBatches(); load(cat, 1, pageSize);
    } catch (e: any) { onToast(e?.message || '등록 실행 실패'); } finally { setExecuting(false); }
  };
  const rollbackPreview = async (id: number) => {
    const res = await fetch(api(`/api/admin/translators/import-plan/batches/${id}/rollback-preview`), { headers: auth }); const d = await res.json();
    if (!res.ok) { onToast(d?.error || '되돌리기 미리보기 실패'); return; } setRb(d);
  };
  const rollbackRun = async () => {
    const res = await fetch(api(`/api/admin/translators/import-plan/batches/${rb.batchId}/rollback`), { method: 'POST', headers: auth, body: JSON.stringify({ confirm: true }) }); const d = await res.json();
    if (!res.ok) { onToast(d?.error || '되돌리기 실패'); return; }
    onToast(`배치 #${rb.batchId} 되돌리기 완료: 신규 ${d.softDeleted}명 비활성(소프트 삭제) · 보완 ${d.restored}개 복원 · 보존 ${d.kept + d.createdKept.length}건`);
    setRb(null); loadBatches(); if (summary) load(cat, page, pageSize);
  };

  const box: React.CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, background: '#fff', marginTop: 12 };
  const btn = (disabled: boolean, color = '#111827'): React.CSSProperties => ({ padding: '8px 14px', borderRadius: 8, border: 'none', fontWeight: 700, fontSize: 13, background: color, color: '#fff', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 });
  const td: React.CSSProperties = { padding: '6px 8px', borderTop: '1px solid #f3f4f6', verticalAlign: 'top', fontSize: 12 };
  const changeList = (list: FieldChange[], color: string) => list.map((f, i) => (
    <div key={i}><b>{f.label}</b>: <span style={{ color: '#9ca3af' }}>{f.before || '(없음)'}</span> → <span style={{ color, fontWeight: 600 }}>{(f.after ?? '').length > 40 ? `${(f.after ?? '').slice(0, 40)}…` : f.after}</span></div>
  ));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div style={box} data-testid="tplan-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 800 }}>{mode === 'final' ? '최종 등록' : '통합 판정 결과'}</div>
        <button style={btn(!snapshotId || loading, '#64748b')} disabled={!snapshotId || loading} onClick={() => load(showTable ? cat : 'ALL', 1, pageSize)} data-testid="tplan-load-btn" aria-label="판정 새로고침">
          {loading ? '판정 중…' : '판정 새로고침'}
        </button>
      </div>
      <div style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 6px' }}>
        기존 Master 동일인은 신규 생성 안 함 · 빈 정보만 보완 · 주민번호·수행이력 모두 없으면 제외 · 동일인 불확실은 수동 확인 보류 · 수행이력·판매·정산 보존
      </div>
      {!summary && loading && <div style={{ fontSize: 12.5, color: '#6b7280' }}>판정 불러오는 중…</div>}

      {summary && mode === 'final' && (() => { const pc = summary.personCounts ?? summary.counts; return (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }} data-testid="tplan-final-counts">
          {([['신규 등록', summary.totals.expectedNew + decidedNew, '#1e40af', '#eff6ff'], ['정보 보완', pc.UPDATE, '#92400e', '#fffbeb'], ['제외', pc.HOLD, '#4b5563', '#f9fafb'], ['수동 확인(보류)', pc.MANUAL - decidedNew - decidedLink, '#991b1b', '#fef2f2']] as const).map(([k, v, col, bg]) => (
            <div key={k} style={{ padding: '10px 16px', minWidth: 120, borderRadius: 8, background: bg, border: '1px solid #e5e7eb' }}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{k}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: col }}>{Number(v).toLocaleString()}<span style={{ fontSize: 12, fontWeight: 600 }}>명</span></div>
            </div>
          ))}
        </div>); })()}
      {summary && (<>
        {mode !== 'final' && <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          {(['ALL', 'SAME', 'UPDATE', 'NEW', 'HOLD', 'MANUAL'] as Cat[]).map(c => (
            <button key={c} onClick={() => load(c, 1, pageSize)} data-testid={`tplan-cat-${c}`} aria-label={`${META[c].label} 보기`}
              style={{ padding: '8px 14px', minWidth: 100, textAlign: 'left', borderRadius: 8, cursor: 'pointer', background: META[c].bg, border: cat === c ? `2px solid ${META[c].color}` : '1px solid #e5e7eb' }}>
              <div style={{ fontSize: 11, color: '#6b7280' }}>{META[c].label}</div>
              <div style={{ fontSize: 19, fontWeight: 800, color: META[c].color }}>{(c === 'ALL' ? summary.totals.persons : (summary.personCounts ?? summary.counts)[c]).toLocaleString()}<span style={{ fontSize: 11, fontWeight: 600 }}>명</span></div>
              {c !== 'ALL' && summary.personCounts && summary.counts[c] !== summary.personCounts[c] && <div style={{ fontSize: 10.5, color: '#9ca3af' }}>엑셀 {summary.counts[c].toLocaleString()}행(중복행 포함)</div>}
              {c === 'ALL' && <div style={{ fontSize: 10.5, color: '#9ca3af' }}>엑셀 {summary.totals.rows.toLocaleString()}행</div>}
            </button>
          ))}
        </div>}
        {showTable && <div style={{ fontSize: 12, color: '#374151', marginTop: 8, lineHeight: 1.7 }} data-testid="tplan-checks">
          {(() => { const pc = summary.personCounts ?? summary.counts; return <div>합계 검증(고유 인원): {summary.totals.reconciled ? '✓' : '✗'} 기존 동일인 {pc.SAME.toLocaleString()} + 정보 보완 {pc.UPDATE} + 신규 {pc.NEW} + 등록 제외 {pc.HOLD.toLocaleString()} + 수동 확인 {pc.MANUAL.toLocaleString()} = {summary.totals.persons.toLocaleString()}명 (엑셀 {summary.totals.rows.toLocaleString()}행 · 파일 내 중복행 {summary.totals.duplicateRows})</div>; })()}
          <div>Master 수(유효): {summary.totals.aliveMastersBefore.toLocaleString()} → 예상 {summary.totals.expectedAliveAfter.toLocaleString()} (자동 신규 {summary.totals.expectedNew}{summary.totals.newWithoutEmail ? ` · 이메일 없어 생성 보류 ${summary.totals.newWithoutEmail}` : ''}) · 통합·제외 Master {summary.totals.excludedMasters.toLocaleString()}명 변경 없음 · 실인원 {summary.totals.persons.toLocaleString()}명(파일 내 중복행 {summary.totals.duplicateRows})</div>
          <div>신규 안전 점검: 기존 Master 동명 {summary.checks.newRowsMatchingExisting} · 이메일 충돌 {summary.checks.newRowsEmailCollision} · 배치 내 이메일 중복 {summary.checks.newDuplicateEmailInBatch}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            {Object.entries(summary.byReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
              const [c, code] = k.split(':');
              return <span key={k} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: META[c as Cat]?.bg, color: META[c as Cat]?.color, border: '1px solid #e5e7eb' }}>{labels[code] ?? code} {v}</span>;
            })}
          </div>
        </div>}

        {showTable && (<>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
          <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') load(cat, 1, pageSize, q); }} placeholder="성명·Master ID·행 번호 검색"
            data-testid="tplan-search" aria-label="판정 검색" style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, minWidth: 220 }} />
          <button style={btn(loading, '#6b7280')} disabled={loading} onClick={() => load(cat, 1, pageSize, q)} data-testid="tplan-search-btn" aria-label="검색">검색</button>
        </div>

        <div style={{ overflowX: 'auto', marginTop: 8, border: '1px solid #e5e7eb', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }} data-testid="tplan-table">
            <thead><tr style={{ background: '#f9fafb', textAlign: 'left', fontSize: 12 }}>
              {['행', '성명', '판정', '사유', '대상 Master', '보완(전 → 후)', '차이(기존 값 유지)', '수동 결정'].map(h => <th key={h} style={{ padding: '7px 8px' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: '#9ca3af', padding: 16 }}>해당 자료가 없습니다.</td></tr>}
              {rows.map(r => {
                const m = META[r.category];
                const dKey = String(r.rowNumber);
                return (
                  <tr key={r.rowNumber} data-testid={`tplan-row-${r.rowNumber}`}>
                    <td style={td}>{r.rowNumber}</td>
                    <td style={td}>{r.name || '(성명 없음)'}<div style={{ color: '#9ca3af' }}>{r.hasRrn ? '주민번호 ○' : '주민번호 ×'} · {r.email ? '이메일 ○' : '이메일 ×'} · {r.eligibility.history ? '수행이력 ○' : '수행이력 ×'}</div></td>
                    <td style={td}><span style={{ padding: '2px 8px', borderRadius: 999, background: m.bg, color: m.color, fontWeight: 700, whiteSpace: 'nowrap' }}>{m.label}</span></td>
                    <td style={{ ...td, color: '#4b5563' }}>
                      <div style={{ fontWeight: 600 }}>{r.reason}</div>
                      {r.category === 'NEW' && !r.creatable && !r.firstRowOfDuplicate && <div style={{ color: '#b45309' }}>이메일 없음 — 계정 생성 보류(가짜 이메일 미생성)</div>}
                      {(r.basis ?? []).map((b, i) => <div key={i} style={{ color: '#6b7280', fontSize: 11 }}>· {b}</div>)}
                    </td>
                    <td style={td}>{r.masterId ? <>#{r.masterId} {r.masterName}{r.viaMergedId ? <div style={{ color: '#6b7280' }}>통합 #{r.viaMergedId} 경유</div> : null}</> :
                      r.candidates.length ? r.candidates.slice(0, 4).map(c => <div key={c.id} style={{ color: c.alive ? '#374151' : '#9ca3af' }}>#{c.id} {c.name} {c.alive ? '' : '(제외)'} · {c.basis}</div>) : '-'}</td>
                    <td style={td}>{r.fills.length ? changeList(r.fills, '#065f46') : '-'}</td>
                    <td style={td}>{r.diffs.length ? changeList(r.diffs, '#b45309') : '-'}</td>
                    <td style={td}>{r.category === 'MANUAL' && !r.firstRowOfDuplicate ? (() => {
                      const cur = decisions[dKey] ?? r.savedDecision?.decision ?? null;
                      return (
                        <div>
                          <div style={{ fontWeight: 700, color: cur ? '#1d4ed8' : '#9ca3af', marginBottom: 4 }}>{cur ? DECISION_LABEL(cur) : '미판정(보류)'}{!decisions[dKey] && r.savedDecision ? ' · 저장됨' : ''}</div>
                          <button onClick={() => setReviewRow(r.rowNumber)} data-testid={`tplan-review-${r.rowNumber}`} aria-label={`${r.rowNumber}행 비교·판정`}
                            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', fontSize: 12, cursor: 'pointer' }}>비교·판정</button>
                        </div>
                      );
                    })() : '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 12 }}>
          <button style={btn(page <= 1 || loading, '#6b7280')} disabled={page <= 1 || loading} onClick={() => load(cat, page - 1, pageSize)} data-testid="tplan-prev" aria-label="이전 페이지">이전</button>
          <span>{page} / {totalPages} · {total.toLocaleString()}건</span>
          <button style={btn(page >= totalPages || loading, '#6b7280')} disabled={page >= totalPages || loading} onClick={() => load(cat, page + 1, pageSize)} data-testid="tplan-next" aria-label="다음 페이지">다음</button>
          <select value={pageSize} onChange={e => load(cat, 1, Number(e.target.value))} data-testid="tplan-page-size" aria-label="페이지당 행 수" style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db' }}>
            {[20, 50, 100].map(n => <option key={n} value={n}>{n}행</option>)}
          </select>
        </div>
        </>)}

        {showExec && <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: '#fff7ed', border: '1px solid #fed7aa' }} data-testid="tplan-approval">
          <div style={{ fontSize: 13, fontWeight: 800, color: '#9a3412' }}>대표 승인</div>
          {mode !== 'final' && summary.reviewedManual != null && <div style={{ fontSize: 12, color: '#1d4ed8' }}>동일인 수동 확인 저장된 판정: {summary.reviewedManual.toLocaleString()} / {summary.counts.MANUAL.toLocaleString()}명 (실행 시 서버에서 다시 검증)</div>}
          {mode !== 'final' && (() => { const pc = summary.personCounts ?? summary.counts; return (
          <div style={{ fontSize: 13, margin: '6px 0', lineHeight: 1.7 }} data-testid="tplan-exec-plan">
            <div><b>실행 대상</b>: 신규 등록 <b>{summary.totals.expectedNew + decidedNew}명</b>(자동 {summary.totals.expectedNew}{decidedNew ? ` + 수동 승인 ${decidedNew}` : ''}) · 정보 보완 <b>{pc.UPDATE}명</b>(공란만){decidedLink ? ` · 수동 연결 ${decidedLink}명` : ''}</div>
            <div><b>실행 안 함</b>: 수동 확인 보류 {(pc.MANUAL - decidedNew - decidedLink).toLocaleString()}명 · 등록 제외 {pc.HOLD.toLocaleString()}명 · 기존 동일인 {pc.SAME.toLocaleString()}명(변경 없음){summary.totals.newWithoutEmail ? ` · 이메일 없어 생성 보류 ${summary.totals.newWithoutEmail}명` : ''}</div>
            <div style={{ color: '#6b7280' }}>실행 후 활성 Master {summary.totals.aliveMastersBefore.toLocaleString()} → {(summary.totals.aliveMastersBefore + summary.totals.expectedNew + decidedNew).toLocaleString()}명(수동 승인 신규는 실행 시 자격 재검증)</div>
          </div>); })()}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={confirmChecked} onChange={e => setConfirmChecked(e.target.checked)} data-testid="tplan-confirm" aria-label="판정 결과를 확인했으며 등록을 승인합니다" />
            판정 결과를 확인했으며 등록을 승인합니다(관리자 권한 · 배치 되돌리기 가능)
          </label>
          <button style={{ ...btn(!canExecute, '#c2410c'), marginTop: 8 }} disabled={!canExecute} onClick={execute} data-testid="tplan-execute" aria-label="최종 등록 실행">
            {executing ? '등록 중…' : '최종 등록 실행'}
          </button>
          <div style={{ fontSize: 11.5, color: '#6b7280', marginTop: 4 }}>실행 시 서버가 판정을 다시 계산해 이 화면과 일치할 때만 등록합니다.</div>
        </div>}
      </>)}

      {reviewRow != null && snapshotId && (
        <TranslatorReviewDrawer token={token} snapshotId={snapshotId} rowNumber={reviewRow} onToast={onToast} onClose={() => setReviewRow(null)}
          onSaved={(rn, dec) => { setDecisions(prev => ({ ...prev, [String(rn)]: dec })); setConfirmChecked(false); }} />
      )}
      {result && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: '#ecfdf5', border: '1px solid #a7f3d0', fontSize: 12.5 }} data-testid="tplan-result">
          {result.mode === 'no_change' ? '반영할 변경이 없어 아무것도 저장하지 않았습니다.' : `배치 #${result.batchId}: 신규 ${result.created} · 보완 ${result.updated} · 수동 승인 ${result.manualApproved} · 수동 보류 ${result.manualHeld} · Master ${result.aliveBefore} → ${result.aliveAfter}`}
        </div>
      )}

      {showExec && <div style={{ marginTop: 14, borderTop: '1px solid #e5e7eb', paddingTop: 10 }}>
        <button onClick={() => setHistoryOpen(v => !v)} data-testid="tplan-history-toggle" aria-expanded={historyOpen} aria-label="등록 이력 · 배치 되돌리기 펼치기"
          style={{ fontSize: 12.5, fontWeight: 700, background: 'none', border: 'none', color: '#475569', cursor: 'pointer', padding: 0 }}>{historyOpen ? '▾' : '▸'} 등록 이력 · 배치 되돌리기</button>
        {historyOpen && <table style={{ width: '100%', borderCollapse: 'collapse' }} data-testid="tplan-batches">
          <thead><tr style={{ background: '#f9fafb', textAlign: 'left', fontSize: 12 }}>{['배치', '파일', '신규', '보완', '상태', '등록일', ''].map(h => <th key={h} style={{ padding: '6px 8px' }}>{h}</th>)}</tr></thead>
          <tbody>
            {batches.length === 0 && <tr><td colSpan={7} style={{ ...td, color: '#9ca3af' }}>이력 없음</td></tr>}
            {batches.map((b: any) => (
              <tr key={b.id}>
                <td style={td}>#{b.id}</td><td style={td}>{b.original_filename ?? '-'}</td><td style={td}>{b.created}</td><td style={td}>{b.updated}</td>
                <td style={td}>{b.status === 'rolled_back' ? '되돌림' : '반영됨'}</td><td style={td}>{new Date(b.created_at).toLocaleString()}</td>
                <td style={td}>{b.status !== 'rolled_back' && <button style={btn(false, '#6b7280')} onClick={() => rollbackPreview(b.id)} data-testid={`tplan-rb-preview-${b.id}`} aria-label={`배치 ${b.id} 되돌리기 확인`}>되돌리기 확인</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>}
        {rb && (
          <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: rb.ok ? '#fef2f2' : '#f9fafb', border: '1px solid #fecaca', fontSize: 12.5 }} data-testid="tplan-rb-plan">
            <b>배치 #{rb.batchId} 되돌리기 {rb.ok ? '가능' : '불가'}</b> — {rb.reason}
            {rb.ok && <div>신규 {rb.createdTotal}명 중 {rb.createdRollbackable}명 비활성(소프트 삭제) · 이후 연결로 보존 {rb.createdKept.length}명 · 보완 항목 복원 {rb.fieldsRestorable} · 이후 변경으로 보존 {rb.fieldsKept}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              {rb.ok && <button style={btn(false, '#dc2626')} onClick={rollbackRun} data-testid="tplan-rb-run" aria-label="되돌리기 실행">되돌리기 실행</button>}
              <button style={btn(false, '#6b7280')} onClick={() => setRb(null)} data-testid="tplan-rb-close" aria-label="닫기">닫기</button>
            </div>
          </div>
        )}
      </div>}
    </div>
  );
}
