// CRM 자료 최신화 — 최신 CRM 파일 업로드만으로 과거 CRM 자료를 갱신한다(건별 비교·승인 없음).
//   · 판매목록 + 진행관리표 = 한 세트 전체 교체(두 파일 모두 있어야 실행 · 서버 단일 트랜잭션 · 실패 시 기존 자료 유지)
//   · 통번역사 / 거래처 / 담당자 명부 = 각각 독립 최신화(기존 Master 갱신·신규 등록, 삭제 없음)
//   · 화면 정보: 파일명 · 최근 업데이트 · 현재 등록 건수 · 성공 여부 · 처리 오류
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/constants';

type Kind = 'sales_progress' | 'translator' | 'company' | 'contact';
type StatusItem = {
  kind: Kind; counts: Record<string, number>; lastAppliedAt: string | null;
  last: { at: string; ok: boolean; fileName: string | null; by: string | null; error: string | null; summary: Record<string, any> | null } | null;
};
type Props = { token: string; setToast: (m: string) => void; onApplied?: () => void };

const COUNT_LABEL: Record<string, string> = { sales: '판매건', progress: '수행행', translators: '활성 통번역사', companies: '거래처', contacts: '담당자' };
const TITLE: Record<Kind, string> = { sales_progress: '판매목록 · 진행관리표', translator: '통번역사 목록', company: '거래처 목록', contact: '담당자 목록' };
const DESC: Record<Kind, string> = {
  sales_progress: '두 파일을 함께 올리면 최신 파일 기준으로 전체 교체합니다. 최신 파일에 없는 판매건·수행행은 조회에서 제외됩니다(이전 버전 보존).',
  translator: '주민번호 또는 수행이력이 있는 통번역사만 등록합니다. 기존 통번역사는 빈 정보만 보완하며 삭제하지 않습니다.',
  company: '사업자등록번호 등 기존 식별정보로 같은 거래처를 찾아 정보를 갱신하고, 없으면 신규 등록합니다. 기존 거래처는 삭제하지 않습니다.',
  contact: '거래처와 연결해 담당자를 갱신·등록합니다. 동일 여부가 불확실하면 합치지 않고 보류합니다. 기존 담당자는 삭제하지 않습니다.',
};
const fmtAt = (v: string | null | undefined) => { if (!v) return '-'; const d = new Date(v); return isNaN(d.getTime()) ? String(v) : d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }); };
const n = (v: unknown) => Number(v ?? 0).toLocaleString();

function resultLines(kind: Kind, s: Record<string, any> | null | undefined): string[] {
  if (!s) return [];
  if (kind === 'sales_progress') {
    if (s.mode === 'no_change') return ['변경 사항 없음 — 이미 최신 상태입니다.'];
    const side = (l: string, x: any) => x ? `${l}: 추가 ${n(x.added)} · 수정 ${n(x.updated)} · 조회 제외 ${n(x.removed)}${x.protectedFromRemoval ? ` · 운영 전환 보호 ${n(x.protectedFromRemoval)}` : ''}${x.held ? ` · 보류 ${n(x.held)}` : ''} → 현재 ${n(x.effectiveAfter)}건` : '';
    return [side('판매목록', s.sales), side('진행관리표', s.progress), s.links ? `판매↔수행 연결: 유지 ${n(s.links.carried)} · 신규 ${n(s.links.created)}${s.links.relinked ? ` · 재연결 ${n(s.links.relinked)}` : ''}` : ''].filter(Boolean);
  }
  if (kind === 'translator') {
    if (s.mode === 'no_change') return ['변경 사항 없음 — 이미 최신 상태입니다.'];
    const nr = s.notRegistered ? Object.values(s.notRegistered as Record<string, number>).reduce((a, b) => a + b, 0) : 0;
    return [
      `신규 등록 ${n(s.applied?.created)} · 정보 보완 ${n(s.applied?.updated)} · 기존 동일 ${n(s.persons?.same)}`,
      `명부 제외(주민번호·수행이력 모두 없음) ${n(s.excludedNoRrnNoHistory)}${nr - Number(s.excludedNoRrnNoHistory ?? 0) > 0 ? ` · 보류(동일인 불확실·이메일 없음 등) ${n(nr - Number(s.excludedNoRrnNoHistory ?? 0))}` : ''}`,
    ];
  }
  return [`신규 등록 ${n(s.inserted)} · 정보 수정 ${n(s.updated)} · 기존 동일 ${n(s.same)}${s.review ? ` · 확인 필요(보류) ${n(s.review)}` : ''}${s.excluded ? ` · 제외 ${n(s.excluded)}` : ''}`];
}

function DropZone({ id, label, file, onFile, disabled }: { id: string; label: string; file: File | null; onFile: (f: File | null) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const accept = (f?: File | null) => {
    if (!f) return;
    if (!/\.(xls|xlsx)$/i.test(f.name)) { onFile(null); return; }
    onFile(f);
  };
  return (
    <div style={{ flex: 1, minWidth: 220 }}>
      <input ref={ref} type="file" accept=".xls,.xlsx" hidden onChange={e => { accept(e.target.files?.[0]); e.target.value = ''; }} data-testid={`crm-refresh-input-${id}`} aria-label={`${label} 파일 선택`} />
      <div role="button" tabIndex={0} aria-label={`${label} 파일 업로드 — 클릭하거나 끌어다 놓으세요`} data-testid={`crm-refresh-drop-${id}`}
        onClick={() => !disabled && ref.current?.click()}
        onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ref.current?.click(); } }}
        onDragOver={e => { e.preventDefault(); if (!disabled) setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); if (!disabled) accept(e.dataTransfer.files?.[0]); }}
        style={{ border: `2px dashed ${drag ? '#0ea5e9' : file ? '#22c55e' : '#cbd5e1'}`, borderRadius: 10, background: drag ? '#e0f2fe' : file ? '#f0fdf4' : '#f8fafc',
          padding: '14px 12px', textAlign: 'center', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#0369a1' }}>{label}</div>
        {file ? (
          <div style={{ fontSize: 12.5, color: '#166534', marginTop: 4, wordBreak: 'break-all' }}>{file.name}</div>
        ) : (
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{drag ? '여기에 놓으세요' : '엑셀 파일을 끌어놓거나 클릭(.xls/.xlsx)'}</div>
        )}
      </div>
      {file && (
        <button onClick={() => onFile(null)} disabled={disabled} aria-label={`${label} 파일 제거`} data-testid={`crm-refresh-clear-${id}`}
          style={{ marginTop: 4, fontSize: 11.5, border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', padding: 0 }}>파일 제거</button>
      )}
    </div>
  );
}

export function CrmRefreshPanel({ token, setToast, onApplied }: Props) {
  const [status, setStatus] = useState<Record<Kind, StatusItem> | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [files, setFiles] = useState<{ sales: File | null; progress: File | null; translator: File | null; company: File | null; contact: File | null }>({ sales: null, progress: null, translator: null, company: null, contact: null });
  const [busy, setBusy] = useState<Kind | null>(null);
  const [result, setResult] = useState<Partial<Record<Kind, { ok: boolean; lines: string[]; error?: string }>>>({});
  // 통번역사 명부: 미리보기(읽기 전용) → 관리자 확인 → 실행. 미리보기한 파일이 바뀌면 다시 미리보기.
  const [tPreview, setTPreview] = useState<{ file: File; lines: string[]; blocked: boolean } | null>(null);
  const auth = { Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    try {
      const res = await fetch(api('/api/admin/crm-refresh/status'), { headers: auth });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || '현황 조회 실패');
      const m = {} as Record<Kind, StatusItem>; for (const it of d.items as StatusItem[]) m[it.kind] = it;
      setStatus(m); setStatusErr(null);
    } catch (e: any) { setStatusErr(e?.message || '현황 조회 실패'); }
  }, [token]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);

  const finish = (kind: Kind, ok: boolean, lines: string[], error?: string) => {
    setResult(r => ({ ...r, [kind]: { ok, lines, error } }));
    if (ok) { setToast(`${TITLE[kind]} 최신화 완료`); onApplied?.(); }
    load();
  };

  const runSalesProgress = async () => {
    if (!files.sales || !files.progress) return;
    if (!window.confirm('판매목록·진행관리표를 최신 파일 기준으로 전체 교체합니다.\n최신 파일에 없는 과거 CRM 판매건·수행행은 조회에서 제외됩니다(이전 버전은 보존되어 복구 가능).\n진행할까요?')) return;
    setBusy('sales_progress'); setResult(r => ({ ...r, sales_progress: undefined }));
    try {
      const fd = new FormData(); fd.append('salesFile', files.sales); fd.append('progressFile', files.progress);
      const res = await fetch(api('/api/admin/crm-refresh/sales-progress'), { method: 'POST', headers: auth, body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { finish('sales_progress', false, [], d?.error || '전체 교체 실패 — 기존 자료가 유지됩니다.'); return; }
      setFiles(f => ({ ...f, sales: null, progress: null }));
      finish('sales_progress', true, resultLines('sales_progress', d));
    } catch (e: any) { finish('sales_progress', false, [], e?.message || '전체 교체 실패 — 기존 자료가 유지됩니다.'); }
    finally { setBusy(null); }
  };

  const previewTranslator = async () => {
    const f = files.translator; if (!f) return;
    setBusy('translator'); setResult(r => ({ ...r, translator: undefined })); setTPreview(null);
    try {
      const fd = new FormData(); fd.append('file', f);
      const res = await fetch(api('/api/admin/crm-refresh/translators/preview'), { method: 'POST', headers: auth, body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setResult(r => ({ ...r, translator: { ok: false, lines: [], error: d?.error || '미리보기 실패 — 변경 없음' } })); return; }
      const e = d.expected ?? {};
      const blocked = Number(e.invalidName ?? 0) * 2 > Number(d.fileRows ?? 0);
      setTPreview({ file: f, blocked, lines: [
        `미리보기(DB 변경 없음) · 파일 ${n(d.fileRows)}행 · 성명 열 '${d.file?.nameColumn ?? ''}'(${n(d.file?.headerRow)}행 머리글)`,
        `신규 등록 예정 ${n(e.created)} · 정보 보완 예정 ${n(e.updated)} · 기존 동일 ${n(e.same)}`,
        `명부 제외(주민번호·수행이력 모두 없음) ${n(e.excludedNoRrnNoHistory)} · 보류(동일인 불확실·이메일 없음 등) ${n(e.held)} · 성명 누락(invalid_name) ${n(e.invalidName)}`,
        ...(blocked ? ['⚠ 성명 누락 행이 과반이라 실행할 수 없습니다. 파일을 확인해 주세요.'] : []),
      ] });
    } catch (e: any) { setResult(r => ({ ...r, translator: { ok: false, lines: [], error: e?.message || '미리보기 실패 — 변경 없음' } })); }
    finally { setBusy(null); }
  };

  const runTranslator = async () => {
    const f = files.translator; if (!f) return;
    // 미리보기 전이거나 다른 파일이면 먼저 미리보기
    if (!tPreview || tPreview.file !== f) { await previewTranslator(); return; }
    if (tPreview.blocked) return;
    if (!window.confirm('미리보기 결과대로 통번역사 명부 최신화를 실행합니다.\n기존 통번역사는 삭제하지 않으며 빈 정보만 보완합니다.\n진행할까요?')) return;
    setBusy('translator'); setResult(r => ({ ...r, translator: undefined }));
    try {
      const fd = new FormData(); fd.append('file', f);
      const res = await fetch(api('/api/admin/crm-refresh/translators'), { method: 'POST', headers: auth, body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { finish('translator', false, [], d?.error || '통번역사 명부 최신화 실패 — 변경 없음'); return; }
      setFiles(x => ({ ...x, translator: null })); setTPreview(null);
      finish('translator', true, resultLines('translator', d));
    } catch (e: any) { finish('translator', false, [], e?.message || '통번역사 명부 최신화 실패 — 변경 없음'); }
    finally { setBusy(null); }
  };

  // 거래처·담당자: 기존 대량등록 API 재사용(분석 → 정보 수정 포함 실행). 확인 필요 행은 자동 보류.
  const runParty = async (kind: 'company' | 'contact') => {
    const f = files[kind]; if (!f) return;
    const base = kind === 'company' ? '/api/admin/companies/bulk-import' : '/api/admin/contacts/bulk-import';
    setBusy(kind); setResult(r => ({ ...r, [kind]: undefined }));
    const log = (body: Record<string, unknown>) => fetch(api('/api/admin/crm-refresh/log'), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, fileName: f.name, ...body }) }).catch(() => {});
    try {
      const fa = new FormData(); fa.append('file', f);
      const ra = await fetch(api(`${base}/analyze`), { method: 'POST', headers: auth, body: fa });
      const a = await ra.json().catch(() => ({}));
      if (!ra.ok) throw new Error(a?.error || '파일 분석 실패 — 파일 형식을 확인하세요.');
      if (!a?.summary?.total) throw new Error('자료 행이 없는 파일입니다. 변경 없음.');
      const fe = new FormData(); fe.append('file', f); fe.append('mode', 'update'); fe.append('planToken', String(a.planToken ?? ''));
      const re = await fetch(api(`${base}/execute`), { method: 'POST', headers: auth, body: fe });
      const e = await re.json().catch(() => ({}));
      if (!re.ok) throw new Error(e?.error || '최신화 실패 — 변경 없음');
      const s = { totalRows: a.summary.total, inserted: e.inserted ?? 0, updated: e.updated ?? 0, same: a.summary.identical ?? 0,
        review: (a.summary.needsReview ?? 0) + (a.summary.conflict ?? 0), excluded: (a.summary.error ?? 0) + (a.summary.duplicateFile ?? 0), batchId: e.batchId ?? null };
      await log({ ok: true, summary: s });
      setFiles(x => ({ ...x, [kind]: null }));
      finish(kind, true, resultLines(kind, s));
    } catch (err: any) {
      await log({ ok: false, error: err?.message || '처리 실패' });
      finish(kind, false, [], err?.message || '최신화 실패 — 변경 없음');
    } finally { setBusy(null); }
  };

  const card: React.CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, background: '#fff', display: 'flex', flexDirection: 'column', gap: 10 };
  const btn = (dis: boolean): React.CSSProperties => ({ padding: '9px 16px', borderRadius: 8, border: 'none', fontWeight: 800, fontSize: 13.5, cursor: dis ? 'not-allowed' : 'pointer', opacity: dis ? 0.5 : 1, background: '#0ea5e9', color: '#fff', alignSelf: 'flex-start' });

  const info = (kind: Kind) => {
    const st = status?.[kind];
    const r = result[kind];
    const last = st?.last;
    return (
      <div style={{ fontSize: 12.5, color: '#374151', display: 'flex', flexDirection: 'column', gap: 3 }} data-testid={`crm-refresh-info-${kind}`}>
        <div>현재 등록: {st ? Object.entries(st.counts).map(([k, v]) => `${COUNT_LABEL[k] ?? k} ${n(v)}건`).join(' · ') : '-'}</div>
        <div>최근 업데이트: {fmtAt(st?.lastAppliedAt)}</div>
        {last && (
          <div style={{ color: last.ok ? '#166534' : '#b91c1c' }}>
            최근 처리: {fmtAt(last.at)} · {last.ok ? '성공' : '실패'}{last.fileName ? ` · ${last.fileName}` : ''}{last.by ? ` · ${last.by}` : ''}
            {!last.ok && last.error ? <div style={{ marginTop: 2 }}>오류: {last.error}</div> : null}
          </div>
        )}
        {r && (
          <div role="status" data-testid={`crm-refresh-result-${kind}`} style={{ marginTop: 4, padding: '8px 10px', borderRadius: 8, background: r.ok ? '#f0fdf4' : '#fef2f2', border: `1px solid ${r.ok ? '#bbf7d0' : '#fecaca'}`, color: r.ok ? '#166534' : '#b91c1c' }}>
            <div style={{ fontWeight: 800 }}>{r.ok ? '업로드 성공' : '처리 오류 — 기존 자료 유지'}</div>
            {r.error && <div>{r.error}</div>}
            {r.lines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
      </div>
    );
  };

  const single = (kind: 'translator' | 'company' | 'contact', run: () => void) => (
    <div style={card} data-testid={`crm-refresh-card-${kind}`}>
      <div style={{ fontSize: 14.5, fontWeight: 800, color: '#111827' }}>{TITLE[kind]}</div>
      <div style={{ fontSize: 12, color: '#6b7280' }}>{DESC[kind]}</div>
      <DropZone id={kind} label={TITLE[kind]} file={files[kind]} onFile={f => { setFiles(x => ({ ...x, [kind]: f })); if (kind === 'translator') setTPreview(null); }} disabled={!!busy} />
      {kind === 'translator' && tPreview && tPreview.file === files.translator && (
        <div data-testid="crm-refresh-preview-translator" style={{ fontSize: 12, lineHeight: 1.6, color: tPreview.blocked ? '#b91c1c' : '#0f172a', background: tPreview.blocked ? '#fef2f2' : '#f1f5f9', border: `1px solid ${tPreview.blocked ? '#fecaca' : '#e2e8f0'}`, borderRadius: 8, padding: '8px 10px' }}>
          {tPreview.lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
      {(() => {
        const tReady = kind === 'translator' && !!tPreview && tPreview.file === files.translator;
        const dis = !files[kind] || !!busy || (tReady && !!tPreview?.blocked);
        const label = busy === kind ? '처리 중…' : kind !== 'translator' ? '최신화 실행' : tReady ? '확인 후 최신화 실행' : '미리보기(Preview)';
        return (
          <button style={btn(dis)} disabled={dis} onClick={run} aria-label={`${TITLE[kind]} ${label}`} data-testid={`crm-refresh-run-${kind}`}>
            {label}
          </button>
        );
      })()}
      {info(kind)}
    </div>
  );

  return (
    <div style={{ border: '1px solid #bae6fd', borderRadius: 12, padding: 16, background: '#f8fdff', marginBottom: 16 }} data-testid="crm-refresh-panel">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: '#0c4a6e' }}>CRM 자료 최신화</div>
        <button onClick={load} disabled={!!busy} aria-label="자료 현황 새로고침" data-testid="crm-refresh-reload"
          style={{ fontSize: 12, border: '1px solid #d1d5db', background: '#fff', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}>새로고침</button>
      </div>
      <div style={{ fontSize: 12.5, color: '#475569', marginBottom: 12 }}>
        최신 CRM 엑셀 파일을 올리면 그 파일을 기준으로 자료가 갱신됩니다. 필요한 자료만 올리면 됩니다. 신규 플랫폼의 판매·지급·입금·세금계산서 기록은 변경되지 않습니다.
      </div>
      {statusErr && <div role="alert" style={{ color: '#b91c1c', fontSize: 12.5, marginBottom: 8 }}>{statusErr}</div>}
      <div style={{ ...card, marginBottom: 12 }} data-testid="crm-refresh-card-sales_progress">
        <div style={{ fontSize: 14.5, fontWeight: 800, color: '#111827' }}>{TITLE.sales_progress} <span style={{ fontSize: 12, fontWeight: 700, color: '#0369a1' }}>(세트 전체 교체)</span></div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>{DESC.sales_progress}</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <DropZone id="sales" label="① 판매목록" file={files.sales} onFile={f => setFiles(x => ({ ...x, sales: f }))} disabled={!!busy} />
          <DropZone id="progress" label="② 진행관리표" file={files.progress} onFile={f => setFiles(x => ({ ...x, progress: f }))} disabled={!!busy} />
        </div>
        <button style={btn(!files.sales || !files.progress || !!busy)} disabled={!files.sales || !files.progress || !!busy} onClick={runSalesProgress}
          aria-label="판매목록 진행관리표 전체 교체 실행" data-testid="crm-refresh-run-sales_progress">
          {busy === 'sales_progress' ? '전체 교체 중… (1~2분 소요)' : !files.sales || !files.progress ? '두 파일을 모두 올려 주세요' : '전체 교체 실행'}
        </button>
        {info('sales_progress')}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        {single('translator', runTranslator)}
        {single('company', () => runParty('company'))}
        {single('contact', () => runParty('contact'))}
      </div>
    </div>
  );
}
